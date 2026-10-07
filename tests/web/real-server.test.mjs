import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { auth, caddy, password, port } from "./helpers.mjs";

test("real OpenCode V2 works through the gateway with native auth, file-secret health checks and private backend", async t => {
  const dir = await mkdtemp(join(tmpdir(), "opencode-real-web-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const config = join(dir, "opencode.json");
  await writeFile(config, JSON.stringify({ plugins: [], update: "disable" }));
  const webPort = await port();
  const backendPort = await port();
  const secret = join(dir, "password");
  await writeFile(secret, password, { mode: 0o600 });
  const env = { PATH: process.env.PATH, HOME: dir, XDG_STATE_HOME: join(dir, "state"),
    XDG_CONFIG_HOME: join(dir, "config"), XDG_DATA_HOME: join(dir, "data"), XDG_CACHE_HOME: join(dir, "cache"),
    OPENCODE_CONFIG: config, OPENCODE_CONFIG_PROJECT_DISABLE: "1",
    OPENCODE_PASSWORD_FILE: secret, OPENCODE_WEB_PORT: String(webPort), OPENCODE_BACKEND_PORT: String(backendPort) };
  const runner = join(dir, "runner.mjs");
  await writeFile(runner, `import { supervise } from ${JSON.stringify(fileURLToPath(new URL("../../web/supervisor.mjs", import.meta.url)))};
import { loadSecrets } from ${JSON.stringify(fileURLToPath(new URL("../../web/settings.mjs", import.meta.url)))};
process.umask(0o077);
process.exitCode = await supervise(loadSecrets(process.env), {server:'opencode',proxy:${JSON.stringify(caddy)}});
`);
  const child = spawn(process.execPath, [runner], { cwd: dir, env, stdio: ["ignore", "pipe", "pipe"] });
  const exited = once(child, "exit");
  let logs = "";
  child.stdout.on("data", data => { logs += data; });
  child.stderr.on("data", data => { logs += data; });
  t.after(async () => { if (child.exitCode === null && !child.signalCode) { child.kill("SIGTERM"); await exited; } });
  function send(path, headers = {}) {
    return new Promise((resolve, reject) => {
      const req = request({ hostname: "127.0.0.1", port: webPort, path, agent: false,
        headers: { Host: `localhost:${webPort}`, ...headers }, signal: AbortSignal.timeout(2000),
      }, res => {
        let body = "";
        res.on("data", data => { body += data; });
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body }));
      });
      req.on("error", reject);
      req.end();
    });
  }
  let ready = false;
  for (let n = 0; n < 100; n++) {
    try { ready = (await send("/api/info", { Authorization: auth })).status === 200; } catch { /* starting */ }
    if (ready) break;
    assert.equal(child.exitCode, null, logs);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(ready, logs);
  for (const path of ["/api/info", "/api/session", "/api/config", "/openapi.json"]) {
    assert.equal((await send(path)).status, 401);
    assert.equal((await send(path, { Authorization: "Basic invalid" })).status, 401);
  }
  assert.equal((await send("/")).status, 200);
  assert.equal((await send("/api/info", { Authorization: auth, Origin: "https://attacker.example" })).status, 403);
  const info = await send("/api/info", { Authorization: auth });
  const dockerfile = await readFile(new URL("../../Dockerfile", import.meta.url), "utf8");
  assert.equal(JSON.parse(info.body).version, dockerfile.match(/^ARG OPENCODE_VERSION=(.+)$/m)[1]);
  assert.equal(info.headers["cache-control"], "no-store");
  const ui = await send("/");
  assert.match(ui.headers["content-security-policy"], /script-src/);
  assert.match(ui.headers["content-security-policy"], /frame-ancestors 'none'/);
  const health = spawn(process.execPath, [fileURLToPath(new URL("../../web/healthcheck.mjs", import.meta.url))], { env, stdio: "pipe" });
  assert.equal((await once(health, "exit"))[0], 0);
  const unhealthy = spawn(process.execPath, [fileURLToPath(new URL("../../web/healthcheck.mjs", import.meta.url))], {
    env: { ...env, OPENCODE_PASSWORD_FILE: "", OPENCODE_PASSWORD: "incorrect-health-password-".repeat(2) }, stdio: "pipe",
  });
  assert.equal((await once(unhealthy, "exit"))[0], 1);
  child.kill("SIGTERM");
  assert.equal((await exited)[0], 0);
  assert.ok(!logs.includes(password));
  assert.ok(!logs.includes(auth));
});
