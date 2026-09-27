import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { classify, contextRequirements, cooldownUntil, copilotQuota, geminiQuota,
  selectModel, validatePolicy } from "./routing.mjs";

export default async function modelRouter({ client, directory }) {
  const policy = validatePolicy(JSON.parse(await readFile(
    new URL("../model-routing.json", import.meta.url), "utf8",
  )));
  const authPath = join(process.env.XDG_DATA_HOME || join(homedir(), ".local/share"), "opencode/auth.json");
  const blocked = new Map();
  let cachedQuota;
  let expires = 0;
  let pending;

  async function json(url, options) {
    const response = await fetch(url, {
      ...options, redirect: "error", signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) return;
    return response.json();
  }

  async function quotas() {
    if (cachedQuota && expires > Date.now()) return cachedQuota;
    if (pending) return pending;
    pending = (async () => {
      const auth = await readFile(authPath, "utf8").then(JSON.parse).catch(() => ({}));
      const results = await Promise.all([
        (async () => {
          const record = auth["github-copilot"];
          // GitHub Enterprise needs its own quota endpoint; unknown is preferable
          // to sending enterprise credentials to the public GitHub API.
          if (record?.type !== "oauth" || record.enterpriseUrl || !record.refresh) return {};
          const data = await json("https://api.github.com/copilot_internal/user", {
            headers: { Authorization: `Bearer ${record.refresh}`, Accept: "application/json",
              "User-Agent": "opencode-model-router" },
          });
          return copilotQuota(data);
        })().catch(() => ({})),
        (async () => {
          const record = auth.google;
          if (record?.type !== "oauth" || !record.access || record.expires <= Date.now() + 60000) return {};
          const [, project, managed] = (record.refresh ?? "").split("|");
          const projectID = process.env.OPENCODE_GEMINI_PROJECT_ID || managed || project;
          if (!projectID) return {};
          const data = await json("https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota", {
            method: "POST",
            headers: { Authorization: `Bearer ${record.access}`, "Content-Type": "application/json" },
            body: JSON.stringify({ project: projectID }),
          });
          return geminiQuota(data, Date.now());
        })().catch(() => ({})),
      ]);
      cachedQuota = Object.assign({}, ...results);
      expires = Date.now() + policy.quotaCacheSeconds * 1000;
      return cachedQuota;
    })();
    try { return await pending; } finally { pending = undefined; }
  }

  return {
    "chat.message": async (input, output) => {
      if (!policy.agents.includes(output.message.agent)) return;
      const [catalog, messages, quota] = await Promise.all([
        client.config.providers({ query: { directory }, throwOnError: true }),
        client.session.messages({ path: { id: input.sessionID }, query: { directory }, throwOnError: true }),
        quotas(),
      ]);
      const history = messages.data ?? [];
      const text = output.parts.filter((part) => part.type === "text" && !part.synthetic && !part.ignored)
        .map((part) => part.text).join("\n").trim();
      const previous = history.findLast((message) => message.info.role === "user");
      const priorText = previous?.parts.filter((part) => part.type === "text" && !part.synthetic)
        .map((part) => part.text).join("\n") ?? "";
      const rule = classify(policy, previous ? `${priorText}\n${text}` : text, !previous);
      const now = Date.now();
      for (const [key, until] of blocked) if (until <= now) blocked.delete(key);
      const selected = selectModel({ policy, rule, providers: catalog.data.providers,
        quota, blocked, now, ...contextRequirements(history, output.parts) });
      if (!selected) {
        throw new Error("Auto routing: no configured model fits the context, capabilities, and quota policy. " +
          "Check provider logins/model-routing.json, wait for quota, or select the build agent for manual selection.");
      }
      // This is the supported pre-save hook. The inference loop reads this model
      // from the saved user message on every tool step in the turn.
      output.message.model = {
        providerID: selected.model.providerID,
        modelID: selected.model.id,
      };
      delete output.message.variant;
      await client.app.log({ body: { service: "model-router", level: "info",
        message: "Selected model", extra: { sessionID: input.sessionID, rule: rule.name,
          model: selected.id, quota: selected.fraction ?? "unknown" } },
      }).catch(() => {});
    },
    event: async ({ event }) => {
      if (event.type !== "message.updated") return;
      const message = event.properties.info;
      if (message.role !== "assistant") return;
      const until = cooldownUntil(message.error, Date.now(), policy.cooldownSeconds);
      if (!until) return;
      const key = `${message.providerID}/${message.modelID}`;
      blocked.set(key, Math.max(blocked.get(key) ?? 0, until));
      expires = 0;
    },
  };
}
