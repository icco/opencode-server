import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { Config } from "@opencode/schema/config";
import { parse } from "jsonc-parser";
import { buildConfig, readConfig } from "../scripts/build-config.mjs";

// Decode schemas with their own Effect runtime, not an independently updated one.
const schemaRequire = createRequire(import.meta.resolve("@opencode/schema/config"));
const { Schema } = await import(schemaRequire.resolve("effect"));
const config = await readConfig();

test("configuration validates strictly against the installed V2 schema", () => {
  const parsed = Schema.decodeUnknownSync(Config.Info, { onExcessProperty: "error" })(config);
  assert.equal(parsed.default_agent, "build");
  assert.equal(parsed.model.providerID, "anthropic");
  assert.equal(config.worktree.directory, "/data/workspace/.worktrees");
});

test("Superpowers is immutable-pinned and replaces Orchestra", async () => {
  assert.ok(config.plugins.some(p => /^superpowers@git\+https:\/\/github.com\/obra\/superpowers.git#[a-f0-9]{40}$/.test(p)));
  assert.ok(!config.plugins.some(p => (p.package ?? p).includes("orchestra")));
  assert.ok(!Object.keys(config.agents).some(p => p.startsWith("orch-")));
  assert.deepEqual(await buildConfig(), config);
  const instructions = await readFile(new URL("../AGENTS.md", import.meta.url), "utf8");
  assert.match(instructions, /Always perform repository code and configuration changes in a Git worktree/);
  assert.match(instructions, /\/data\/workspace\/\.worktrees\/<repository>\/<task>/);
  assert.match(instructions, /Use Superpowers skills/);
});

test("image-owned skills are discoverable", async () => {
  assert.deepEqual(config.skills, ["/etc/opencode/skills"]);
  for (const name of ["commit-push-pr", "go-repo"]) {
    const skill = await readFile(new URL(`../skills/${name}/SKILL.md`, import.meta.url), "utf8");
    assert.match(skill, new RegExp(`^---\nname: ${name}\ndescription: .+\n---\n`));
  }
});

test("existing providers, MCP integrations and quota are preserved", () => {
  assert.deepEqual(Object.keys(config.mcp.servers).sort(), ["context7", "gmail", "grafana", "karakeep", "lunchmoney", "notion", "robinhood"]);
  assert.ok(config.plugins.includes("@slkiser/opencode-quota@5.0.3"));
  const allowed = config.policies.filter(p => p.action === "provider.use" && p.effect === "allow").map(p => p.resource);
  assert.deepEqual(allowed.sort(), ["anthropic", "google", "openai"]);
  assert.ok(!config.permissions?.some(rule => rule.action === "*" && rule.effect === "allow"));
  assert.deepEqual(config.agents.build.permissions[0], { action: "*", resource: "*", effect: "allow" });
  for (const name of ["general", "explore"])
    assert.ok(config.agents[name].permissions.some(rule => rule.action === "robinhood_*" && rule.resource === "*" && rule.effect === "deny"), `${name} denies Robinhood tools`);
});

test("paid providers fall back across OpenAI and Google and show $50 budgets", async () => {
  const fallback = config.plugins.find(p => p.package?.startsWith("opencode-runtime-fallback@"));
  assert.match(fallback.package, /@\d+\.\d+\.\d+$/);
  assert.deepEqual(fallback.options.fallback_models.map(m => m.split("/")[0]), ["openai", "google"]);
  const quota = parse(await readFile(new URL("../config/quota-toast.jsonc", import.meta.url), "utf8"));
  assert.deepEqual(quota.quotaProviders.map(p => [p.providerId, p.windows[0].usdBudget]), [["anthropic", 50], ["openai", 50], ["google", 50]]);
  assert.equal(quota.waitForQuotaReset, false);
});

test("agents ask before deleting server state under the home directory", async () => {
  const asks = ["rm *.config*", "rm *.local*", "rm *HOME*", "rm *~*", "rm */data", "rm */data/", "rm */data/.*"]
    .map(resource => ({ action: "shell", resource, effect: "ask" }));
  for (const name of ["build", "general"])
    assert.deepEqual(config.agents[name].permissions.slice(-asks.length), asks, `${name} ends with the state-deletion asks`);
  const instructions = await readFile(new URL("../AGENTS.md", import.meta.url), "utf8");
  assert.match(instructions, /Never delete, move, or reset `\/data\/\.config` or `\/data\/\.local`/);
});

test("runtime conversion preserves JSONC overrides and rejects malformed input", async () => {
  const home = await mkdtemp(join(tmpdir(), "opencode-config-test-"));
  try {
    const configPath = join(home, "opencode.jsonc");
    const custom = { agents: { build: { system: "Custom guidance", model: "google/gemini-3.8-flash" } } };
    await writeFile(configPath, "// Preserve overrides\n" + JSON.stringify(custom).replace(/}$/, ",}"));
    assert.deepEqual(await buildConfig({ configPath }), custom);
    await writeFile(configPath, '{"model": }');
    await assert.rejects(buildConfig({ configPath }), /Invalid config/);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("build tooling and schema versions stay aligned", async () => {
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url)));
  const dockerfile = await readFile(new URL("../Dockerfile", import.meta.url), "utf8");
  const version = dockerfile.match(/^ARG OPENCODE_VERSION=(.+)$/m)[1];
  for (const name of ["@opencode/plugin", "@opencode/schema"])
    assert.equal(pkg.devDependencies[name], version, `${name} must match the server`);
  assert.ok(!pkg.devDependencies["@oeronteros-1/opencode-orchestra"]);
  assert.equal(dockerfile.match(/^ARG PNPM_VERSION=(.+)$/m)[1], pkg.packageManager.split("@")[1]);
  await assert.rejects(stat(new URL("../opencode.jsonc", import.meta.url)));
  await assert.rejects(stat(new URL("../opencode.json", import.meta.url)));
});
