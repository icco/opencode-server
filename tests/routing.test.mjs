import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Schema } from "effect";
import { Config } from "@opencode/schema/config";
import { buildConfig } from "../scripts/build-config.mjs";

const config = JSON.parse(await readFile(new URL("../opencode.json", import.meta.url)));
const policy = JSON.parse(await readFile(new URL("../orchestra.jsonc", import.meta.url)));
const upstream = new URL("./", import.meta.resolve("@oeronteros-1/opencode-orchestra"));
const { orchestraConfigSchema } = await import(new URL("config/schema.js", upstream));
const { createAgentSet } = await import(new URL("agents/build.js", upstream));
const { loadPrompts } = await import(new URL("prompts/load.js", upstream));

test("configuration validates strictly against the installed V2 schema", () => {
  const parsed = Schema.decodeUnknownSync(Config.Info, { onExcessProperty: "error" })(config);
  assert.equal(parsed.default_agent, "orch-lead");
  assert.equal(parsed.model.providerID, "github-copilot");
});

test("Orchestra policy validates and all upstream agents are materialized", async () => {
  const parsed = orchestraConfigSchema.parse(policy);
  const agents = createAgentSet(parsed, await loadPrompts());
  const runtime = await buildConfig();
  for (const [name, agent] of Object.entries(agents)) {
    assert.equal(runtime.agents[name].mode, agent.mode);
    assert.equal(runtime.agents[name].hidden, agent.hidden);
  }
  assert.equal(agents["orch-lead"].model, "github-copilot/gpt-6-astra");
  assert.equal(agents["orch-docs"].model, "google/gemini-3.8-flash");
  assert.equal(agents["orch-judge"].model, "github-copilot/claude-opus-5.5");
  assert.equal(agents["orch-repo"].permission.edit ?? agents["orch-repo"].permission["*"], "deny");
});

test("configured fallback chains refer to materialized agents and allowed providers", async () => {
  const runtime = await buildConfig();
  const allowed = new Set(config.experimental.policies.filter(p => p.effect === "allow").map(p => p.resource));
  for (const [agent, models] of Object.entries(policy.models.fallback.agents)) {
    assert.ok(runtime.agents[agent]);
    assert.ok(models.length > 0);
    for (const model of models) assert.ok(allowed.has(model.split("/")[0]));
  }
});

test("generated V2 agents preserve upstream instructions and read-only worker permissions", async () => {
  const runtime = await buildConfig();
  Schema.decodeUnknownSync(Config.Info, { onExcessProperty: "error" })(runtime);
  assert.ok(runtime.agents["orch-lead"].system.length > 100);
  const worker = runtime.agents["orch-repo"];
  assert.equal(worker.permissions.find(p => p.action === "*").effect, "deny");
  assert.equal(worker.model, policy.models.agents["orch-repo"]);
});

test("MCP permissions survive materialization without changing worker permissions", async () => {
  const runtime = await buildConfig();
  function permission(agent, action) {
    return runtime.agents[agent].permissions.filter(p =>
      new RegExp(`^${p.action.split("*").map(RegExp.escape).join(".*")}$`).test(action)).at(-1)?.effect;
  }
  for (const action of ["execute", "grafana_list_datasources", "lunchmoney_get_user", "context7_query-docs"])
    assert.equal(permission("orch-lead", action), "allow");
  for (const agent of ["orch-docs", "orch-research"]) {
    assert.equal(permission(agent, "execute"), "allow");
    assert.equal(permission(agent, "context7_query-docs"), "allow");
    assert.equal(permission(agent, "edit"), "deny");
    assert.equal(permission(agent, "shell"), "deny");
  }
  assert.equal(permission("orch-repo", "grafana_list_datasources"), "deny");
});

test("materialization honors explicit agent overrides and real JSONC policies", async () => {
  const home = await mkdtemp(join(tmpdir(), "opencode-config-test-"));
  try {
    const configPath = join(home, "opencode.json");
    const policyPath = join(home, "orchestra.jsonc");
    const permissions = [{ action: "execute", resource: "*", effect: "deny" }];
    await writeFile(configPath, JSON.stringify({ agents: {
      "orch-docs": { model: "google/gemini-3.1-pro-preview", system: "Custom docs guidance", permissions },
    } }));
    await writeFile(policyPath, '{ // Keep comments and trailing commas valid.\n"superpowers": {"compatibility": false,}, "orchestration": {"exposeWorkers": true,},}');
    const runtime = await buildConfig({ configPath, policyPath });
    Schema.decodeUnknownSync(Config.Info, { onExcessProperty: "error" })(runtime);
    assert.equal(runtime.agents["orch-docs"].model, "google/gemini-3.1-pro-preview");
    assert.equal(runtime.agents["orch-docs"].system, "Custom docs guidance");
    assert.deepEqual(runtime.agents["orch-docs"].permissions.at(-1), permissions[0]);
    assert.equal(runtime.agents["orch-docs"].hidden, false);
    assert.ok(!runtime.agents["orch-lead"].system.includes("Superpowers workflow"));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("build tooling, schema and runtime plugin versions stay aligned", async () => {
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url)));
  const dockerfile = await readFile(new URL("../Dockerfile", import.meta.url), "utf8");
  const version = dockerfile.match(/^ARG OPENCODE_VERSION=(.+)$/m)[1];
  for (const name of ["@opencode/plugin", "@opencode/schema"])
    assert.equal(pkg.devDependencies[name], version, `${name} must match the server`);
  const orchestra = pkg.devDependencies["@oeronteros-1/opencode-orchestra"];
  assert.ok(config.plugins.includes(`@oeronteros-1/opencode-orchestra@${orchestra}`));
  assert.ok(policy.$schema.includes(`@${orchestra}/`));
  assert.equal(dockerfile.match(/^ARG PNPM_VERSION=(.+)$/m)[1], pkg.packageManager.split("@")[1]);
});
