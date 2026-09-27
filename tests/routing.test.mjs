import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
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

test("Orchestra policy validates and all upstream agents have V2 config seeds", async () => {
  const parsed = orchestraConfigSchema.parse(policy);
  const agents = createAgentSet(parsed, await loadPrompts());
  for (const name of Object.keys(agents)) assert.ok(config.agents[name], `missing agent seed: ${name}`);
  assert.equal(agents["orch-lead"].model, "github-copilot/gpt-6-astra");
  assert.equal(agents["orch-docs"].model, "google/gemini-3.8-flash");
  assert.equal(agents["orch-judge"].model, "github-copilot/claude-opus-5.5");
  assert.equal(agents["orch-repo"].permission.edit ?? agents["orch-repo"].permission["*"], "deny");
});

test("configured fallback chains refer to seeded agents and allowed providers", () => {
  const allowed = new Set(config.experimental.policies.filter(p => p.effect === "allow").map(p => p.resource));
  for (const [agent, models] of Object.entries(policy.models.fallback.agents)) {
    assert.ok(config.agents[agent]);
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
