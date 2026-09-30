import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { proxyConfig } from "../../web/proxy.mjs";

export const haproxy = process.env.HAPROXY_BIN || "haproxy";
export const password = "disposable-web-test-password-".repeat(2);
export const auth = `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`;
export async function port() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const result = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return result;
}
export async function gateway(t, { secure = false, proxies = [], handler, upgrade } = {}) {
  const backend = createServer(handler || ((req, res) => {
    if (req.headers.authorization !== auth) { res.writeHead(401, { "WWW-Authenticate": "Basic" }); res.end(); return; }
    res.writeHead(200, { "Content-Security-Policy": "script-src 'self' 'wasm-unsafe-eval'", "Cache-Control": "public, max-age=3600" });
    res.end(JSON.stringify(req.headers));
  }));
  if (upgrade) backend.on("upgrade", upgrade);
  backend.listen(0, "127.0.0.1");
  await once(backend, "listening");
  t.after(() => { backend.closeAllConnections(); backend.close(); });
  const s = { webPort: await port(), backendPort: backend.address().port,
    origin: secure ? "https://code.example" : "http://localhost:4096", host: secure ? "code.example" : "localhost:4096", secure, proxies };
  const dir = await mkdtemp(join(tmpdir(), "opencode-proxy-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const config = join(dir, "haproxy.cfg");
  await writeFile(config, proxyConfig(s));
  const check = spawnSync(haproxy, ["-c", "-f", config], { encoding: "utf8" });
  if (check.error || check.status !== 0) throw new Error(check.stderr || String(check.error));
  const child = spawn(haproxy, ["-db", "-f", config], { stdio: ["ignore", "pipe", "pipe"] });
  let logs = "";
  child.stdout.on("data", data => { logs += data; });
  child.stderr.on("data", data => { logs += data; });
  async function stop() {
    if (child.exitCode !== null || child.signalCode) return;
    const exited = once(child, "exit");
    child.kill("SIGTERM");
    await exited;
  }
  t.after(stop);
  function options(headers = {}) {
    return { hostname: "127.0.0.1", port: s.webPort, agent: false,
      headers: { Host: s.host, Authorization: auth, ...(secure ? { "X-Forwarded-Proto": "https" } : {}), ...headers } };
  }
  function send(path = "/api/info", headers = {}, method = "GET") {
    return new Promise((resolve, reject) => {
      const req = request({ ...options(headers), path, method }, res => {
        let body = "";
        res.on("data", chunk => { body += chunk; });
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, rawHeaders: res.rawHeaders, body }));
      });
      req.on("error", reject);
      req.end();
    });
  }
  for (let attempt = 0; ; attempt++) {
    try { await send("/ready"); break; } catch {
      if (attempt >= 100 || child.exitCode !== null) throw new Error(`Proxy startup failed: ${logs}`);
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  }
  return { send, options, s, stop, logs: () => logs };
}
