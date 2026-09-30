import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { request as httpRequest } from "node:http";
import { caddy, password, port } from "./helpers.mjs";

async function until(check, child) {
  for (let n = 0; n < 150; n++) {
    const result = await check().catch(() => false);
    if (result) return result;
    if (child.exitCode !== null) throw new Error("Supervisor exited before readiness");
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error("Readiness deadline exceeded");
}

async function fixture(t, failure) {
  const dir = await mkdtemp(join(tmpdir(), "opencode-supervisor-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const server = join(dir, "server.mjs");
  const proxy = join(dir, "proxy.mjs");
  await writeFile(server, `#!/usr/bin/env node
import { createServer } from 'node:http';
import { writeFileSync } from 'node:fs';
if (${JSON.stringify(failure)} === 'server') process.exit(2);
writeFileSync(${JSON.stringify(join(dir, "server.pid"))}, String(process.pid));
writeFileSync(${JSON.stringify(join(dir, "server.args"))}, JSON.stringify(process.argv.slice(2)));
console.log('private-password-marker:' + process.env.OPENCODE_PASSWORD);
if (${JSON.stringify(failure)} === 'large-log') process.stdout.write('x'.repeat(5 * 1024 * 1024));
const server = createServer((req, res) => { res.writeHead(200); res.end('{}'); });
server.listen(+process.argv.at(-1), '127.0.0.1');
process.on('SIGTERM', () => { writeFileSync(${JSON.stringify(join(dir, "terminated"))}, 'yes'); server.closeAllConnections(); server.close(() => process.exit(0)); });
`, { mode: 0o700 });
  await writeFile(proxy, `#!/usr/bin/env node
process.exit(process.argv.includes('validate') ? 0 : 2);
`, { mode: 0o700 });
  const webPort = await port();
  const env = { PATH: process.env.PATH, HOME: dir, XDG_STATE_HOME: join(dir, "state"),
    OPENCODE_SERVER_PASSWORD: password, OPENCODE_PASSWORD: password,
    OPENCODE_WEB_PORT: String(webPort), OPENCODE_BACKEND_PORT: String(await port()) };
  const module = fileURLToPath(new URL("../../web/supervisor.mjs", import.meta.url));
  const runner = join(dir, "runner.mjs");
  await writeFile(runner, `import { supervise } from ${JSON.stringify(module)};
process.umask(0o077);
process.exitCode = await supervise(${JSON.stringify(env)}, {server:${JSON.stringify(server)}, proxy:${JSON.stringify(failure === "proxy" ? proxy : caddy)}});
`);
  const child = spawn(process.execPath, [runner], { stdio: ["ignore", "pipe", "pipe"] });
  const exit = once(child, "exit");
  let logs = "";
  child.stdout.on("data", chunk => { logs += chunk; });
  child.stderr.on("data", chunk => { logs += chunk; });
  t.after(async () => { if (child.exitCode === null && !child.signalCode) { child.kill("SIGTERM"); await exit; } });
  async function request() {
    return new Promise((resolve, reject) => {
      const req = httpRequest({ hostname: "127.0.0.1", port: webPort, path: "/api/info",
        headers: { Host: `localhost:${webPort}` }, signal: AbortSignal.timeout(500), agent: false,
      }, response => { response.resume(); resolve(response.statusCode === 200); });
      req.on("error", reject);
      req.end();
    });
  }
  return { dir, child, exit, logs: () => logs, env, request };
}

test("SIGTERM closes both processes, keeps native credentials out of stdout and uses loopback", async t => {
  const f = await fixture(t);
  await until(f.request, f.child);
  assert.deepEqual(JSON.parse(await readFile(join(f.dir, "server.args"))),
    ["serve", "--hostname", "127.0.0.1", "--port", f.env.OPENCODE_BACKEND_PORT]);
  f.child.kill("SIGTERM");
  assert.equal((await f.exit)[0], 0);
  assert.equal(await readFile(join(f.dir, "terminated"), "utf8"), "yes");
  const log = join(f.dir, "state/opencode-web/server.log");
  assert.equal((await stat(log)).mode & 0o777, 0o600);
  assert.match(await readFile(log, "utf8"), /private-password-marker/);
  assert.ok(!f.logs().includes(password));
  assert.ok(!f.logs().includes("private-password-marker"));
  await assert.rejects(f.request);
});

test("backend death tears down the public gateway and fails the container", async t => {
  const f = await fixture(t);
  await until(f.request, f.child);
  process.kill(+await readFile(join(f.dir, "server.pid"), "utf8"), "SIGKILL");
  assert.equal((await f.exit)[0], 1);
  await assert.rejects(f.request);
});

test("private diagnostics rotate rather than growing without bound", async t => {
  const f = await fixture(t, "large-log");
  await until(f.request, f.child);
  f.child.kill("SIGTERM");
  assert.equal((await f.exit)[0], 0);
  for (const name of ["server.log", "server.log.previous"]) {
    const info = await stat(join(f.dir, "state/opencode-web", name));
    assert.ok(info.size <= 4 * 1024 * 1024);
    assert.equal(info.mode & 0o777, 0o600);
  }
  assert.ok(!f.logs().includes(password));
});

for (const failure of ["server", "proxy"]) {
  test(`${failure} startup failure cannot leave a partial deployment running`, async t => {
    const f = await fixture(t, failure);
    assert.equal((await f.exit)[0], 1);
    await assert.rejects(f.request);
    if (failure === "proxy") assert.equal(await readFile(join(f.dir, "terminated"), "utf8"), "yes");
  });
}
