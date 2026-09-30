import { spawn, spawnSync } from "node:child_process";
import { chmodSync, closeSync, mkdirSync, mkdtempSync, openSync, renameSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { authorization, settings } from "./settings.mjs";
import { proxyConfig } from "./proxy.mjs";

// Exported for lifecycle tests with disposable executable paths.
export async function supervise(env, executables = { server: "opencode", proxy: "haproxy" }) {
  const s = settings(env);
  const work = mkdtempSync(join(tmpdir(), "opencode-web-"));
  const config = join(work, "haproxy.cfg");
  const children = [];
  let logFd;
  let shuttingDown = false;
  let finish;
  const stopped = new Promise(resolve => { finish = resolve; });
  const shutdown = code => { if (!shuttingDown) { shuttingDown = true; finish(code); } };
  const signal = () => shutdown(0);
  process.once("SIGTERM", signal);
  process.once("SIGINT", signal);
  function launch(name, command, args, options) {
    const child = spawn(command, args, { detached: true, ...options });
    const closed = new Promise(resolve => child.once("close", resolve));
    children.push({ child, closed });
    child.once("error", () => { console.error(`${name} could not start`); shutdown(1); });
    child.once("exit", () => {
      if (!shuttingDown) console.error(`${name} exited; stopping the container`);
      shutdown(1);
    });
    return child;
  }
  function kill(child, sig) {
    if (!child.pid) return;
    try { process.kill(-child.pid, sig); } catch (error) { if (error.code !== "ESRCH") throw error; }
  }
  try {
    writeFileSync(config, proxyConfig(s), { mode: 0o600 });
    // The gateway does not need provider credentials or the server password.
    const proxyEnv = { PATH: env.PATH, LANG: "C" };
    const check = spawnSync(executables.proxy, ["-c", "-f", config], { env: proxyEnv, encoding: "utf8" });
    if (check.error || check.status !== 0) throw new Error(`Gateway configuration failed validation: ${check.stderr || "proxy unavailable"}`);
    const logDir = join(env.XDG_STATE_HOME || join(env.HOME, ".local/state"), "opencode-web");
    mkdirSync(logDir, { recursive: true, mode: 0o700 });
    chmodSync(logDir, 0o700);
    const log = join(logDir, "server.log");
    try { renameSync(log, `${log}.previous`); } catch (error) { if (error.code !== "ENOENT") throw error; }
    logFd = openSync(log, "w", 0o600);
    let logSize = 0;
    const logLimit = 4 * 1024 * 1024;
    function diagnostic(chunk) {
      try {
        if (chunk.length > logLimit) chunk = chunk.subarray(-logLimit);
        if (logSize + chunk.length > logLimit) {
          closeSync(logFd);
          logFd = undefined;
          renameSync(log, `${log}.previous`);
          logFd = openSync(log, "w", 0o600);
          logSize = 0;
        }
        writeSync(logFd, chunk);
        logSize += chunk.length;
      } catch {
        console.error("Could not write private OpenCode diagnostics");
        shutdown(1);
      }
    }
    // Native stdout can include pairing/password material. Keep bounded private
    // diagnostics instead of sending raw application output to Docker logs.
    const server = launch("OpenCode", executables.server,
      ["serve", "--hostname", "127.0.0.1", "--port", String(s.backendPort)],
      { env, stdio: ["ignore", "pipe", "pipe"] });
    server.stdout.on("data", diagnostic);
    server.stderr.on("data", diagnostic);
    let ready = false;
    const deadline = Date.now() + 120000;
    while (Date.now() < deadline && !shuttingDown) {
      try {
        const response = await fetch(`http://127.0.0.1:${s.backendPort}/api/info`, {
          headers: { Authorization: authorization(env) }, signal: AbortSignal.timeout(Math.min(1000, deadline - Date.now())),
        });
        ready = response.ok;
        await response.body?.cancel();
        if (ready) break;
      } catch { /* Backend is still starting. */ }
      await Promise.race([delay(Math.max(0, Math.min(1000, deadline - Date.now()))), stopped]);
    }
    if (!shuttingDown) {
      if (!ready) throw new Error("OpenCode did not become healthy within the startup deadline");
      launch("Gateway", executables.proxy, ["-db", "-f", config], { env: proxyEnv, stdio: "inherit" });
      console.log(`Protected OpenCode listening on port ${s.webPort}`);
    }
    return await stopped;
  } finally {
    shuttingDown = true;
    for (const { child } of children) kill(child, "SIGTERM");
    let timer;
    await Promise.race([
      Promise.all(children.map(({ closed }) => closed)),
      new Promise(resolve => { timer = setTimeout(resolve, 20000); }),
    ]);
    clearTimeout(timer);
    // Also terminate any descendants left after a group leader exited.
    for (const { child } of children) kill(child, "SIGKILL");
    await Promise.all(children.map(({ closed }) => closed));
    if (logFd !== undefined) closeSync(logFd);
    process.removeListener("SIGTERM", signal);
    process.removeListener("SIGINT", signal);
    rmSync(work, { recursive: true, force: true });
  }
}
