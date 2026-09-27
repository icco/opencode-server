// Pure policy helpers; kept separate from the plugin entry point because OpenCode
// treats every export from a legacy plugin module as a plugin factory.
export function validatePolicy(policy) {
  const models = (value) => Array.isArray(value) && value.length > 0 &&
    value.every((id) => typeof id === "string" && /^[^/]+\/.+$/.test(id));
  if (!Array.isArray(policy.agents) || !policy.agents.length ||
      !policy.agents.every((agent) => typeof agent === "string" && agent.length)) {
    throw new Error("model-routing.json: agents must be a nonempty string array");
  }
  for (const key of ["quotaCacheSeconds", "cooldownSeconds", "contextReserveTokens"]) {
    if (!Number.isFinite(policy[key]) || policy[key] <= 0) {
      throw new Error(`model-routing.json: ${key} must be positive`);
    }
  }
  if (!Number.isFinite(policy.quotaReserveFraction) || policy.quotaReserveFraction < 0 ||
      policy.quotaReserveFraction >= 1 || !["allow", "deny"].includes(policy.unknownQuota)) {
    throw new Error("model-routing.json: invalid quota policy");
  }
  if (!models(policy.defaultModels) || !Array.isArray(policy.rules)) {
    throw new Error("model-routing.json: invalid rules/defaultModels");
  }
  for (const rule of policy.rules) {
    if (!rule.name || typeof rule.pattern !== "string" || !models(rule.models) ||
        (rule.firstTurnOnly !== undefined && typeof rule.firstTurnOnly !== "boolean") ||
        (rule.maxPromptCharacters !== undefined &&
          (!Number.isFinite(rule.maxPromptCharacters) || rule.maxPromptCharacters <= 0))) {
      throw new Error("model-routing.json: invalid rule");
    }
    new RegExp(rule.pattern, "i");
  }
  return policy;
}

export function classify(policy, text, firstTurn) {
  return policy.rules.find((rule) =>
    (!rule.firstTurnOnly || firstTurn) &&
    (!rule.maxPromptCharacters || text.length <= rule.maxPromptCharacters) &&
    new RegExp(rule.pattern, "i").test(text),
  ) ?? { name: "general", models: policy.defaultModels };
}

export function selectModel({ policy, rule, providers, quota, blocked, tokens, modalities, now }) {
  const available = new Map(providers.flatMap((provider) =>
    Object.values(provider.models).map((model) => [`${provider.id}/${model.id}`, model]),
  ));
  const candidates = [...new Set([...rule.models, ...policy.defaultModels])];
  const eligible = candidates.flatMap((id, index) => {
    const model = available.get(id);
    if (!model || model.status === "deprecated" || !model.capabilities?.toolcall ||
        model.limit.context < tokens + policy.contextReserveTokens ||
        modalities.some((type) => !model.capabilities.input[type]) ||
        (blocked.get(id) ?? 0) > now) return [];
    const state = quota[id] ?? quota[id.split("/")[0]];
    const fraction = state?.resetAt <= now ? undefined : state?.fraction;
    const known = typeof fraction === "number" && Number.isFinite(fraction);
    if ((known && fraction <= 0) || (!known && policy.unknownQuota === "deny")) return [];
    // Preserve quality ordering within each availability tier.
    const tier = !known ? 1 : fraction <= policy.quotaReserveFraction ? 2 : 0;
    return [{ id, model, index, tier, fraction: known ? fraction : undefined }];
  });
  eligible.sort((a, b) => a.tier - b.tier || a.index - b.index);
  return eligible[0];
}

export function copilotQuota(payload) {
  const snapshots = payload?.quota_snapshots;
  const buckets = [snapshots?.premium_interactions, snapshots?.chat].filter(Boolean);
  const fractions = buckets.map((bucket) => {
    if (bucket.unlimited === true) return 1;
    if (typeof bucket.percent_remaining === "number") return bucket.percent_remaining / 100;
    if (typeof bucket.remaining === "number" && bucket.entitlement > 0) {
      return bucket.remaining / bucket.entitlement;
    }
  }).filter((value) => Number.isFinite(value));
  if (!fractions.length) return {};
  return { "github-copilot": {
    fraction: Math.max(0, Math.min(1, ...fractions)),
    resetAt: Date.parse(payload.quota_reset_date) || undefined,
  } };
}

export function geminiQuota(payload, now) {
  const result = {};
  for (const bucket of payload?.buckets ?? []) {
    // Vertex buckets describe a different route; do not apply them to Code Assist.
    if (!bucket.modelId || bucket.modelId.endsWith("_vertex")) continue;
    const resetAt = Date.parse(bucket.resetTime) || undefined;
    if (resetAt <= now) continue;
    const fraction = bucket.remainingAmount === "0" ? 0 : bucket.remainingFraction;
    if (typeof fraction !== "number" || !Number.isFinite(fraction)) continue;
    const key = `google/${bucket.modelId}`;
    if (!result[key] || fraction < result[key].fraction) {
      result[key] = { fraction: Math.max(0, Math.min(1, fraction)), resetAt };
    }
  }
  return result;
}

export function cooldownUntil(error, now, seconds) {
  const data = error?.data;
  if (error?.name !== "APIError" || ![402, 429, 503].includes(data?.statusCode)) return;
  const headers = data.responseHeaders ?? {};
  const value = Object.entries(headers).find(([key]) => key.toLowerCase() === "retry-after")?.[1];
  const retryAt = value && (/^\d+(\.\d+)?$/.test(value)
    ? now + Number(value) * 1000 : Date.parse(value));
  return Math.max(now + seconds * 1000, retryAt || 0);
}

export function contextRequirements(history, parts) {
  const summary = history.findLastIndex((message) => message.info.summary === true);
  const active = history.slice(Math.max(0, summary));
  const lastIndex = active.findLastIndex((message) => message.info.role === "assistant" &&
    message.info.tokens && (message.info.tokens.input > 0 || message.info.tokens.cache?.read > 0));
  const usage = active[lastIndex]?.info.tokens;
  const previousTokens = usage ? usage.input + usage.output + (usage.reasoning ?? 0) +
    (usage.cache?.read ?? 0) + (usage.cache?.write ?? 0) : 0;
  // A byte per token is deliberately conservative for new text, including code.
  const pendingParts = [...active.slice(lastIndex < 0 ? 0 : lastIndex).flatMap((message) => message.parts), ...parts];
  const textBytes = pendingParts.reduce((total, part) => {
    if (part.type === "text" || part.type === "reasoning") return total + Buffer.byteLength(part.text);
    if (part.type === "tool") return total + Buffer.byteLength(JSON.stringify(part.state?.input ?? {})) +
      Buffer.byteLength(part.state?.output ?? part.state?.error ?? "");
    return total;
  }, 0);
  const modalities = new Set();
  const allParts = [...active.flatMap((message) => message.parts), ...parts];
  for (const part of allParts.flatMap((part) => part.type === "tool"
    ? [part, ...(part.state?.attachments ?? [])] : [part])) {
    if (part.type !== "file") continue;
    if (part.mime === "application/pdf") modalities.add("pdf");
    for (const type of ["image", "audio", "video"]) {
      if (part.mime?.startsWith(`${type}/`)) modalities.add(type);
    }
  }
  return { tokens: previousTokens + textBytes, modalities: [...modalities] };
}
