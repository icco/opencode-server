import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { classify, contextRequirements, cooldownUntil, copilotQuota, geminiQuota,
  selectModel, validatePolicy } from "../plugins/routing.mjs";
import modelRouter from "../plugins/model-router.mjs";

const policy = validatePolicy(JSON.parse(await readFile(new URL("../model-routing.json", import.meta.url))));
const now = Date.now();
const ids = policy.defaultModels;
const providers = ["google", "github-copilot"].map((providerID) => ({
  id: providerID,
  models: Object.fromEntries([...new Set([...ids, ...policy.rules.flatMap((rule) => rule.models)])]
    .filter((id) => id.startsWith(`${providerID}/`)).map((id) => {
      const modelID = id.split("/")[1];
      return [modelID, { id: modelID, providerID, status: "active", limit: { context: 200000 },
        capabilities: { toolcall: true, input: { text: true, image: true } } }];
    })),
}));
const choose = (overrides = {}) => selectModel({ policy, rule: classify(policy, "implement a feature", true),
  providers, quota: {}, blocked: new Map(), tokens: 0, modalities: [], now, ...overrides });

test("quality rules prefer design models and only simplify standalone tasks", () => {
  assert.equal(classify(policy, "debug this deadlock", true).name, "design-and-debugging");
  assert.equal(classify(policy, "fix the typo in README", true).name, "simple-work");
  assert.equal(classify(policy, "fix the typo in README", false).name, "general");
  assert.equal(classify(policy, "summarize this security review", true).name, "design-and-debugging");
  assert.equal(choose().id, ids[0]);
});

test("quota ranks healthy, unknown, low; exhausted models are excluded", () => {
  assert.equal(choose({ quota: { "github-copilot": { fraction: 0 } } }).id, "google/gemini-3.1-pro-preview");
  assert.equal(choose({ quota: { [ids[0]]: { fraction: 0.05 }, [ids[1]]: { fraction: 0.8 } } }).id, ids[1]);
  assert.equal(choose({ quota: { [ids[0]]: { fraction: 0.05 } } }).id, ids[1]);
  assert.equal(choose({ quota: { [ids[1]]: { fraction: 0.8 } } }).id, ids[1]);
  assert.equal(choose({ policy: { ...policy, unknownQuota: "deny" } }), undefined);
  assert.equal(choose({ quota: { [ids[0]]: { fraction: 0, resetAt: now - 1 } } }).id, ids[0]);
  assert.equal(choose({ quota: { "github-copilot": { fraction: 0 }, google: { fraction: 0 } } }), undefined);
});

test("disconnected, incompatible, and cooling-down candidates are skipped", () => {
  assert.equal(choose({ providers: providers.filter((p) => p.id === "google") }).id, "google/gemini-3.1-pro-preview");
  assert.equal(choose({ blocked: new Map([[ids[0], now + 1]]) }).id, ids[1]);
  assert.equal(choose({ blocked: new Map([[ids[0], now - 1]]) }).id, ids[0]);
  assert.equal(choose({ tokens: 199000 }), undefined);
  assert.equal(choose({ modalities: ["pdf"] }), undefined);
  const copy = structuredClone(providers);
  copy.find((p) => p.id === "github-copilot").models[ids[0].split("/")[1]].capabilities.toolcall = false;
  assert.equal(choose({ providers: copy }).id, ids[1]);
});

test("quota adapters distinguish unknown, zero, unlimited, and expired buckets", () => {
  assert.deepEqual(copilotQuota({}), {});
  assert.equal(copilotQuota({ quota_snapshots: { premium_interactions: { percent_remaining: 0 } } })["github-copilot"].fraction, 0);
  assert.equal(copilotQuota({ quota_snapshots: { premium_interactions: { unlimited: true } } })["github-copilot"].fraction, 1);
  assert.deepEqual(geminiQuota({ buckets: [] }, now), {});
  const quota = geminiQuota({ buckets: [
    { modelId: "gemini-test", remainingFraction: 0.8 },
    { modelId: "gemini-test", remainingAmount: "0" },
    { modelId: "gemini-test_vertex", remainingFraction: 1 },
    { modelId: "gemini-expired", remainingFraction: 0, resetTime: new Date(now - 1).toISOString() },
  ] }, now);
  assert.deepEqual(Object.keys(quota), ["google/gemini-test"]);
  assert.equal(quota["google/gemini-test"].fraction, 0);
});

test("rate-limit cooldown honors retry-after but ignores unrelated failures", () => {
  assert.equal(cooldownUntil({ name: "APIError", data: { statusCode: 429,
    responseHeaders: { "Retry-After": "600" } } }, now, 300), now + 600000);
  assert.equal(cooldownUntil({ name: "APIError", data: { statusCode: 503 } }, now, 300), now + 300000);
  assert.equal(cooldownUntil({ name: "APIError", data: { statusCode: 400 } }, now, 300), undefined);
});

test("context budget includes cached tokens and prior attachments", () => {
  const history = [{ info: { role: "assistant", tokens: {
    input: 100, output: 20, reasoning: 10, cache: { read: 10000, write: 500 },
  } }, parts: [{ type: "file", mime: "image/png" }] }];
  assert.deepEqual(contextRequirements(history, [{ type: "text", text: "hello" }]), {
    tokens: 10635, modalities: ["image"],
  });
  assert.equal(contextRequirements([{ info: { role: "user" }, parts: [
    { type: "text", text: "unsent history" },
  ] }], []).tokens, 14);
  history.push({ info: { role: "assistant", tokens: { input: 0, output: 0 } }, parts: [
    { type: "tool", state: { input: {}, output: "result", attachments: [
      { type: "file", mime: "application/pdf" },
    ] } },
  ] });
  assert.deepEqual(contextRequirements(history, []), { tokens: 10638, modalities: ["image", "pdf"] });
});

test("policy rejects invalid quota and regular expressions", () => {
  assert.throws(() => validatePolicy({ ...policy, quotaReserveFraction: 1 }));
  assert.throws(() => validatePolicy({ ...policy, rules: [{ name: "bad", pattern: "[", models: ids }] }));
});

test("plugin preserves manual agents and routes Auto before save without sending a prompt", async () => {
  const logs = [];
  const client = {
    config: { providers: async () => ({ data: { providers } }) },
    session: { messages: async () => ({ data: [] }) },
    app: { log: async ({ body }) => { logs.push(body); } },
  };
  const plugin = await modelRouter({ client, directory: "/test" });
  const output = { message: { agent: "build", model: { providerID: "manual", modelID: "manual" } },
    parts: [{ type: "text", text: "implement a feature" }] };
  await plugin["chat.message"]({ sessionID: "test" }, output);
  assert.equal(output.message.model.providerID, "manual");
  // Isolate the hook from real credentials/network; quota failures are unknown.
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("offline"); };
  try {
    output.message.agent = "auto";
    await plugin["chat.message"]({ sessionID: "test" }, output);
    assert.equal(output.message.model.modelID, "gpt-6-astra");
    await plugin.event({ event: { type: "message.updated", properties: { info: {
      role: "assistant", providerID: "github-copilot", modelID: "gpt-6-astra",
      error: { name: "APIError", data: { statusCode: 429 } },
    } } } });
    await plugin["chat.message"]({ sessionID: "test" }, output);
    assert.equal(output.message.model.modelID, "claude-opus-5.5");
    assert.equal(logs[0].extra.quota, "unknown");
  } finally { globalThis.fetch = originalFetch; }
});
