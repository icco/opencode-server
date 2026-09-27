import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createAutoRouterWithConfig } from "opencode-auto-router";

// Exercise the pinned upstream package, not a copy of its implementation.
const { normalizeConfig } = await import(new URL("./config.js", import.meta.resolve("opencode-auto-router")));
const raw = JSON.parse(await readFile(new URL("../opencode-auto-router.json", import.meta.url)));
const config = normalizeConfig(raw);
config.notify = false;
const selected = { providerID: "auto-router", modelID: "quality" };
const reasoning = "Think carefully, weigh the options, and evaluate the architecture.";
async function route(hooks, text, model = selected, sessionID = "test") {
  const output = { message: { model }, parts: [{ type: "text", text }] };
  await hooks["chat.message"]({ sessionID, agent: "build", model }, output);
  return output.message.model;
}
const ref = (model) => `${model.providerID}/${model.modelID}`;

test("deployed config and tests use the same upstream version and router model", async () => {
  const server = JSON.parse(await readFile(new URL("../opencode.json", import.meta.url)));
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url)));
  assert.ok(server.plugin.includes(`opencode-auto-router@${pkg.devDependencies["opencode-auto-router"]}`));
  assert.equal(server.model, ref(selected));
  assert.ok(server.enabled_providers.includes(selected.providerID));
  assert.ok(server.provider[selected.providerID].models[selected.modelID]);
  for (const tier of ["SIMPLE", "MEDIUM", "COMPLEX", "REASONING"]) {
    assert.ok(raw.routers[0].tierModels[tier].model);
    for (const model of [raw.routers[0].tierModels[tier].model, ...raw.routers[0].tierModels[tier].fallbacks]) {
      assert.ok(server.enabled_providers.includes(model.split("/")[0]));
    }
  }
  // Internal tasks must not try to send requests to the virtual router provider.
  assert.notEqual(server.small_model.split("/")[0], "auto-router");
  assert.notEqual(server.agent.compaction.model.split("/")[0], "auto-router");
});

test("upstream selects configured simple and reasoning tiers and preserves manual selection", async () => {
  const hooks = createAutoRouterWithConfig(config);
  assert.equal(ref(await route(hooks, "hello")), raw.routers[0].tierModels.SIMPLE.model);
  assert.equal(ref(await route(hooks, reasoning)), raw.routers[0].tierModels.REASONING.model);
  const manual = { providerID: "github-copilot", modelID: "gpt-6-astra" };
  assert.deepEqual(await route(hooks, "hello", manual), manual);
});

test("upstream advances the configured chain after quota failure and resets after success", async () => {
  const hooks = createAutoRouterWithConfig(config);
  await route(hooks, reasoning);
  await hooks.event({ event: { type: "session.error", properties: {
    sessionID: "test", error: { name: "APIError", data: { statusCode: 429, message: "quota exhausted" } },
  } } });
  const fallback = await route(hooks, reasoning);
  assert.equal(ref(fallback), raw.routers[0].tierModels.REASONING.fallbacks[0]);
  await hooks.event({ event: { type: "message.updated", properties: { info: {
    sessionID: "test", role: "assistant", ...fallback, time: { completed: Date.now() },
  } } } });
  assert.equal(ref(await route(hooks, reasoning)), raw.routers[0].tierModels.REASONING.model);
});
