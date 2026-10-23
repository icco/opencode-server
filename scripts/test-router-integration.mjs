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
    await writeFile(join(home, "runtime.json"), JSON.stringify({ ...await buildConfig(), skills: [join(root, "skills")] }));
    await copyFile(join(root, "AGENTS.md"), join(home, "config/opencode/AGENTS.md"));
    await mkdir(join(home, "config/opencode/opencode-quota"), { recursive: true });
    await copyFile(join(root, "config/quota-toast.jsonc"), join(home, "config/opencode/opencode-quota/quota-toast.jsonc"));
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
    assert.ok(packages.some(p => p.id === "superpowers"));
    assert.ok(!data.some(p => p.id === "opencode-orchestra"));
    assert.ok(packages.some(p => p.id === "@slkiser/opencode-quota.server"), JSON.stringify(packages));
    assert.ok(packages.some(p => p.id.includes("fallback")), JSON.stringify(packages));
    return true;
  });
  const commands = (await request("/api/command")).data;
  for (const name of ["quota", "quota_status"])
    assert.ok(commands.some(c => c.name === name), `missing ${name}`);
  const google = (await request("/api/integration/google")).data;
  assert.ok(google.methods.some(m => m.type === "oauth" && m.id === "gemini-cli"));
  const copilot = (await request("/api/integration/github-copilot")).data;
  assert.ok(copilot.methods.some(m => m.type === "oauth"));
  for (const provider of ["anthropic", "openai"]) {
    const { methods } = (await request(`/api/integration/${provider}`)).data;
    assert.ok(methods.some(m => m.type === "key"), `${provider} accepts an API key: ${JSON.stringify(methods)}`);
  }
  const agents = (await request("/api/agent")).data;
  const lead = agents.find(a => a.id === "build");
  assert.ok(lead, "native build agent is available");
  assert.ok(!agents.some(a => a.id.startsWith("orch-")));
  const glob = pattern => new RegExp(`^${[...pattern].map(c => c === "*" ? ".*" : c === "?" ? "." : RegExp.escape(c)).join("")}$`, "s");
  function permission(agent, action, resource = "") {
    return agent.permissions.filter(rule => glob(rule.action).test(action) && glob(rule.resource).test(resource)).at(-1)?.effect;
  }
  for (const action of ["execute", "grafana_list_datasources", "lunchmoney_get_user", "karakeep_search-bookmarks", "notion_notion-search", "robinhood_test_tool", "context7_query-docs"])
    assert.equal(permission(lead, action), "allow", `lead can use ${action}`);
  const general = agents.find(a => a.id === "general");
  const explore = agents.find(a => a.id === "explore");
  for (const agent of [general, explore]) {
    assert.ok(agent);
    for (const action of ["grafana_list_datasources", "lunchmoney_get_user", "karakeep_search-bookmarks", "notion_notion-search", "robinhood_test_tool", "subagent"])
      assert.equal(permission(agent, action), "deny", `${agent.id} cannot use ${action}`);
    for (const action of ["read", "glob", "grep", "webfetch", "websearch", "skill", "execute", "context7_query-docs"])
      assert.equal(permission(agent, action), "allow", `${agent.id} can use ${action}`);
  }
  for (const action of ["edit", "shell"])
    assert.equal(permission(explore, action), "deny", `explore cannot use ${action}`);
  for (const action of ["edit", "shell"])
    assert.equal(permission(general, action), "allow", `general can implement and test with ${action}`);
  for (const agent of [lead, general]) {
    assert.equal(permission(agent, "shell", "rm -rf node_modules"), "allow", `${agent.id} can delete project files`);
    for (const command of ["rm -rf ~/.config", 'rm -rf "$HOME/.local/share/opencode"', 'rm -rf "$XDG_CONFIG_HOME"', "rm -rf .config .local .cache", "rm -rf ~", "rm -rf /data", "rm -rf /data/", "rm -rf /data/.*"])
      assert.equal(permission(agent, "shell", command), "ask", `${agent.id} asks before ${command}`);
  }
  const skills = (await request("/api/skill")).data;
  for (const id of ["using-superpowers", "brainstorming", "test-driven-development", "using-git-worktrees", "verification-before-completion"])
    assert.ok(skills.some(skill => skill.id === id), `missing Superpowers skill ${id}`);
  for (const id of ["commit-push-pr", "go-repo"])
    assert.ok(skills.some(skill => skill.id === id), `missing image skill ${id}`);
  const entries = await request("/api/config");
  const runtime = entries.findLast(entry => entry.info?.worktree)?.info;
  assert.equal(runtime.default_agent, "build");
  assert.equal(runtime.worktree.directory, "/data/workspace/.worktrees");
  await until(async () => {
    const { data } = await request("/api/mcp");
    for (const name of external ? ["lunchmoney", "grafana", "karakeep"] : ["lunchmoney", "karakeep"]) {
      assert.equal(data.find(server => server.name === name)?.status.status, "connected", JSON.stringify(data));
    }
    for (const name of ["context7", "gmail", "notion"])
      assert.ok(data.some(server => server.name === name), `missing ${name}`);
    return true;
  });
  // Without credentials, a dropped provider policy shows up as OpenCode's free models.
  const models = (await request("/api/model")).data;
  assert.ok(models.every(m => ["google", "github-copilot", "anthropic", "openai", "claude-code"].includes(m.providerID)), `policies hide other providers' models: ${models.map(m => m.providerID)}`);
  session = (await request("/api/session", { title: "V2 integration test", agent: "build",
    location: { directory } })).data;
  await request(`/api/session/${session.id}/command`, { name: "quota_announcements", text: "" });
  const inbox = (await request(`/api/session/${session.id}/inbox`)).data;
  assert.ok(inbox.some(item => {
    const report = item.payload.metadata?.opencodeQuota;
    return report?.command === "quota_announcements" && report.document?.sections?.length;
  }), `quota command produced a report: ${JSON.stringify(inbox)}`);
  await request(`/api/session/${session.id}/command`, { name: "quota_status", text: "" });
  const status = (await request(`/api/session/${session.id}/inbox`)).data
    .map(item => item.payload.metadata?.opencodeQuota).find(report => report?.command === "quota_status");
  assert.ok(!JSON.stringify(status).includes("quotaProviders["), `quota config is valid: ${JSON.stringify(status)}`);
  for (const id of ["anthropic-api", "openai-api", "google-api"])
    assert.ok(JSON.stringify(status).includes(id), `quota_status lists ${id}: ${JSON.stringify(status)}`);
  await request(`/api/experimental/session/${session.id}/wait`, undefined, "POST");
  const context = (await request(`/api/session/${session.id}/message`)).data;
  assert.ok(!context.some(m => m.type === "assistant"), "no model inference");
  console.log("V2 host, authentication, Superpowers skills, worktree settings, and deterministic quota commands passed.");
} finally {
  if (session) await request(`/api/session/${session.id}`, undefined, "DELETE").catch(() => {});
  if (child?.pid && child.exitCode == null && child.signalCode == null) {
    await new Promise(resolve => {
      const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
      child.once("close", () => { clearTimeout(timer); resolve(); });
      child.kill("SIGTERM");
    });
  }
  if (home) {
    const serverLog = await readFile(join(home, "data/opencode/log/opencode.log"), "utf8").catch(() => "");
    const diagnostics = serverLog.split("\n").filter(line => /level=ERROR|level=WARN|install|superpowers/.test(line));
    if (diagnostics.length) console.log(diagnostics.join("\n").replaceAll(password, "[redacted]"));
    await rm(home, { recursive: true, force: true });
  }
  if (logs) console.log(logs.replaceAll(password, "[redacted]"));
}
