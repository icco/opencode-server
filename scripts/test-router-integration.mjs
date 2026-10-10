// Check the real V2 host and published plugins without requesting model inference.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, copyFile, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const root = fileURLToPath(new URL("../", import.meta.url));
const dockerfile = await readFile(join(root, "Dockerfile"), "utf8");
const version = process.env.OPENCODE_TEST_VERSION ?? dockerfile.match(/^ARG OPENCODE_VERSION=(.+)$/m)[1];
const external = process.env.OPENCODE_TEST_URL;
const password = external ? process.env.OPENCODE_PASSWORD : randomBytes(32).toString("hex");
assert.ok(password);
const home = external ? undefined : await mkdtemp(join(tmpdir(), "opencode-v2-test-"));
const directory = external ? "/data/workspace" : join(home, "workspace");
const url = external || `http://127.0.0.1:${process.env.ROUTER_TEST_PORT || "4197"}`;
let child;
let spawnError;
let logs = "";
let session;
const headers = { Authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`,
  "Content-Type": "application/json" };
async function request(path, body, method = body ? "POST" : "GET") {
  const target = new URL(path, url);
  target.searchParams.set("location[directory]", directory);
  const response = await fetch(target, { method, headers,
    body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(120000) });
  const text = await response.text();
  if (!response.ok) throw new Error(`${path}: ${response.status} ${text}`);
  return text ? JSON.parse(text) : undefined;
}
async function until(check) {
  let last;
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
    if (spawnError) throw spawnError;
    try { const value = await check(); if (value) return value; } catch (error) { last = error; }
    if (child && (child.exitCode != null || child.signalCode != null)) throw new Error("V2 server exited");
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  throw last ?? new Error("Timed out waiting for V2 plugins");
}
try {
  if (home) {
    const { buildConfig } = await import("./build-config.mjs");
    await mkdir(directory, { recursive: true });
    await mkdir(join(home, "config/opencode"), { recursive: true });
    await writeFile(join(home, "runtime.json"), JSON.stringify(await buildConfig()));
    await copyFile(join(root, "orchestra.jsonc"), join(home, "config/opencode/orchestra.jsonc"));
    await copyFile(join(root, "AGENTS.md"), join(home, "config/opencode/AGENTS.md"));
    // Keep the host's config, database overrides, and credentials out of this server.
    const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
      !/^(OPENCODE_|ORCHESTRA_|WAKATIME_|GRAFANA_|LUNCHMONEY_|KARAKEEP_|GOOGLE_|GIT_CONFIG_|GH_|GITHUB_)|API_KEY|TOKEN/.test(key)));
    const env = { ...inherited, HOME: home, XDG_CONFIG_HOME: join(home, "config"),
      XDG_DATA_HOME: join(home, "data"), XDG_STATE_HOME: join(home, "state"), XDG_CACHE_HOME: join(home, "cache"),
      OPENCODE_CONFIG: join(home, "runtime.json"),
      OPENCODE_PASSWORD: password, LUNCHMONEY_API_TOKEN: "catalog-test-only",
      KARAKEEP_API_ADDR: "http://127.0.0.1:1", KARAKEEP_API_KEY: "catalog-test-only" };
    child = spawn("opencode", ["serve", "--hostname", "127.0.0.1", "--port", new URL(url).port],
      { cwd: directory, env, stdio: ["ignore", "pipe", "pipe"] });
    child.on("error", error => { spawnError = error; });
    child.stdout.on("data", chunk => { logs += chunk; });
    child.stderr.on("data", chunk => { logs += chunk; });
  }
  const info = await until(() => request("/api/info"));
  assert.equal(info.version, version);
  for (const authorization of [undefined, `Basic ${Buffer.from("opencode:wrong-password").toString("base64")}`]) {
    const response = await fetch(`${url}/api/info`, { headers: authorization ? { Authorization: authorization } : {} });
    assert.equal(response.status, 401);
  }
  await until(async () => {
    const { data } = await request("/api/plugin");
    const packages = data.filter(p => p.source.type === "package");
    assert.ok(packages.length >= 4, JSON.stringify(data));
    assert.ok(packages.every(p => p.state.status === "active"), JSON.stringify(packages));
    assert.ok(packages.some(p => p.id === "opencode-orchestra"));
    assert.ok(packages.some(p => p.id === "@slkiser/opencode-quota.server"), JSON.stringify(packages));
    return true;
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
  function permission(agent, action) {
    return agent.permissions.filter(rule => new RegExp(`^${rule.action.split("*").map(RegExp.escape).join(".*")}$`).test(action)).at(-1)?.effect;
  }
  for (const action of ["execute", "grafana_list_datasources", "lunchmoney_get_user", "karakeep_search-bookmarks", "context7_query-docs"])
    assert.equal(permission(lead, action), "allow", `lead can use ${action}`);
  const docs = agents.find(a => a.id === "orch-docs");
  assert.equal(permission(docs, "execute"), "allow");
  assert.equal(permission(docs, "context7_query-docs"), "allow");
  assert.equal(permission(docs, "edit"), "deny");
  assert.equal(permission(docs, "karakeep_search-bookmarks"), "deny");
  assert.ok(!lead.system.includes("Superpowers workflow"));
  await until(async () => {
    const { data } = await request("/api/mcp");
    for (const name of external ? ["lunchmoney", "grafana", "karakeep"] : ["lunchmoney", "karakeep"]) {
      assert.equal(data.find(server => server.name === name)?.status.status, "connected", JSON.stringify(data));
    }
    assert.ok(data.some(server => server.name === "context7"));
    return true;
  });
  session = (await request("/api/session", { title: "V2 integration test", agent: "build",
    location: { directory } })).data;
  await request(`/api/session/${session.id}/command`, { name: "quota_announcements", text: "" });
  const inbox = (await request(`/api/session/${session.id}/inbox`)).data;
  assert.ok(inbox.some(item => {
    const report = item.payload.metadata?.opencodeQuota;
    return report?.command === "quota_announcements" && report.document?.sections?.length;
  }), `quota command produced a report: ${JSON.stringify(inbox)}`);
  await request(`/api/experimental/session/${session.id}/wait`, undefined, "POST");
  const context = (await request(`/api/session/${session.id}/message`)).data;
  assert.ok(!context.some(m => m.type === "assistant"), "no model inference");
  console.log("V2 host, authentication, Orchestra agents, and deterministic quota commands passed.");
} finally {
  if (session) await request(`/api/session/${session.id}`, undefined, "DELETE").catch(() => {});
  if (child?.pid && child.exitCode == null && child.signalCode == null) {
    await new Promise(resolve => {
      const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
      child.once("close", () => { clearTimeout(timer); resolve(); });
      child.kill("SIGTERM");
    });
  }
  if (home) await rm(home, { recursive: true, force: true });
  if (logs) console.log(logs.replaceAll(password, "[redacted]"));
}
