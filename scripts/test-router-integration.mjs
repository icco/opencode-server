// Check the real V2 host and published plugins without requesting model inference.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, copyFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

const root = fileURLToPath(new URL("../", import.meta.url));
const external = process.env.OPENCODE_TEST_URL;
const password = external ? process.env.OPENCODE_SERVER_PASSWORD : randomBytes(32).toString("hex");
assert.ok(password);
const home = external ? undefined : await mkdtemp(join(tmpdir(), "opencode-v2-test-"));
const url = external || `http://127.0.0.1:${process.env.ROUTER_TEST_PORT || "4197"}`;
let child;
let logs = "";
let session;
const headers = { Authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`,
  "Content-Type": "application/json", ...(process.env.OPENCODE_TEST_HOST ? { Host: process.env.OPENCODE_TEST_HOST } : {}) };
function fetchServer(url, options) {
  // Docker smoke tests map an ephemeral local port to a fixed virtual host.
  // fetch ignores Host overrides; use Node's HTTP client for that test mode.
  if (!process.env.OPENCODE_TEST_HOST) return fetch(url, options);
  return new Promise((resolve, reject) => {
    const request = new URL(url).protocol === "https:" ? httpsRequest : httpRequest;
    const req = request(url, { ...options, agent: false }, res => {
      const chunks = [];
      res.on("data", chunk => chunks.push(chunk));
      res.on("error", reject);
      res.on("end", () => resolve(new Response([204, 205, 304].includes(res.statusCode) ? null : Buffer.concat(chunks),
        { status: res.statusCode, headers: res.headers })));
    });
    req.on("error", reject);
    req.end(options?.body);
  });
}
async function request(path, body, method = body ? "POST" : "GET") {
  const target = new URL(path, url);
  target.searchParams.set("location[directory]", external ? "/data/workspace" : root);
  const response = await fetchServer(target, { method, headers,
    body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(120000) });
  const text = await response.text();
  if (!response.ok) throw new Error(`${path}: ${response.status} ${text}`);
  return text ? JSON.parse(text) : undefined;
}
async function until(check) {
  let last;
  for (let attempt = 0; attempt < 120; attempt++) {
    try { const value = await check(); if (value) return value; } catch (error) { last = error; }
    if (child?.exitCode != null) throw new Error(logs);
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  throw last ?? new Error("Timed out waiting for V2 plugins");
}
try {
  if (home) {
    const { buildConfig } = await import("./build-config.mjs");
    await writeFile(join(home, "opencode.json"), JSON.stringify(await buildConfig()));
    await mkdir(join(home, "config/opencode"), { recursive: true });
    await copyFile(join(root, "orchestra.jsonc"), join(home, "config/opencode/orchestra.jsonc"));
    const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: join(home, "config"),
      XDG_DATA_HOME: join(home, "data"), XDG_STATE_HOME: join(home, "state"), XDG_CACHE_HOME: join(home, "cache"),
      OPENCODE_CONFIG: join(home, "opencode.json"), OPENCODE_PASSWORD: password,
      OPENCODE_CONFIG_PROJECT_DISABLE: "1" };
    // Provider connections and real credentials are not required for this check.
    for (const key of Object.keys(env)) if (/API_KEY|TOKEN/.test(key)) delete env[key];
    child = spawn("opencode", ["serve", "--hostname", "127.0.0.1", "--port", new URL(url).port],
      { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.on("data", chunk => { logs += chunk; });
    child.stderr.on("data", chunk => { logs += chunk; });
  }
  const info = await until(() => request("/api/info"));
  assert.equal(info.version, "2.0.18");
  for (const authorization of [undefined, `Basic ${Buffer.from("opencode:wrong-password").toString("base64")}`]) {
    const response = await fetchServer(`${url}/api/info`, { headers: {
      ...(process.env.OPENCODE_TEST_HOST ? { Host: process.env.OPENCODE_TEST_HOST } : {}),
      ...(authorization ? { Authorization: authorization } : {}),
    } });
    assert.equal(response.status, 401);
  }
  await until(async () => {
    const { data } = await request("/api/plugin");
    const active = data.filter(p => p.state.status === "active");
    return active.some(p => p.id === "opencode-orchestra") &&
      active.some(p => p.id === "@cardinal4/opencode-quota");
  });
  const commands = (await request("/api/command")).data;
  for (const name of ["orchestra", "orchestra-status", "quota", "quota_status"])
    assert.ok(commands.some(c => c.name === name), `missing ${name}`);
  const google = (await request("/api/integration/google")).data;
  assert.ok(google.methods.some(m => m.type === "oauth" && m.id === "gemini-cli"));
  const copilot = (await request("/api/integration/github-copilot")).data;
  assert.ok(copilot.methods.some(m => m.type === "oauth"));
  const agents = (await request("/api/agent")).data;
  const lead = agents.find(a => a.id === "orch-lead");
  assert.ok(lead.system?.length, "Orchestra populated lead instructions");
  assert.equal(lead.model.id, "gpt-6-astra");
  assert.equal(agents.find(a => a.id === "orch-docs").model.id, "gemini-3.8-flash");
  session = (await request("/api/session", { title: "V2 integration test", agent: "build",
    location: { directory: external ? "/data/workspace" : root } })).data;
  await request(`/api/session/${session.id}/command`, { name: "quota_announcements", text: "" });
  const inbox = await request(`/api/session/${session.id}/inbox`);
  assert.ok(JSON.stringify(inbox).includes("synthetic"), `quota command produced output: ${JSON.stringify(inbox)}`);
  const context = (await request(`/api/session/${session.id}/message`)).data;
  assert.ok(!context.some(m => m.type === "assistant"), "no model inference");
  console.log("V2 host, authentication, Orchestra agents, and deterministic quota commands passed.");
} finally {
  if (session) await request(`/api/session/${session.id}`, undefined, "DELETE").catch(() => {});
  if (child) { child.kill("SIGTERM"); await new Promise(resolve => child.once("exit", resolve)); }
  if (home) await rm(home, { recursive: true, force: true });
  if (logs) console.log(logs);
}
