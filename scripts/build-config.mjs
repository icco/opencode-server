// Materialize upstream agent definitions: V2 replays config after plugin transforms,
// so empty config seeds can overwrite Orchestra's generated instructions/models.
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
const upstream = new URL("./", import.meta.resolve("@oeronteros-1/opencode-orchestra"));
const { loadConfig } = await import(new URL("config/load.js", upstream));
const { createAgentSet } = await import(new URL("agents/build.js", upstream));
const { loadPrompts } = await import(new URL("prompts/load.js", upstream));

export async function buildConfig({
  configPath = new URL("../opencode.json", import.meta.url),
  policyPath = new URL("../orchestra.jsonc", import.meta.url),
} = {}) {
  const config = JSON.parse(await readFile(configPath));
  const { config: policy } = await loadConfig(process.cwd(), {
    configFile: policyPath instanceof URL ? fileURLToPath(policyPath) : policyPath,
  });
  config.agents ??= {};
  for (const [name, agent] of Object.entries(createAgentSet(policy, await loadPrompts()))) {
    const override = config.agents[name] ?? {};
    config.agents[name] = {
      mode: agent.mode, hidden: agent.hidden,
      description: agent.description, system: agent.prompt, model: agent.model,
      ...override,
      permissions: [
        ...Object.entries(agent.permission).flatMap(([action, rules]) => {
          if (action === "list" || action === "lsp") return [];
          action = ({ bash: "shell", task: "subagent", write: "edit", patch: "edit" })[action] ?? action;
          return typeof rules === "string" ? [{ action, resource: "*", effect: rules }] :
            Object.entries(rules).map(([resource, effect]) => ({ action, resource, effect }));
        }),
        // MCP uses Code Mode in V2. Nested calls still enforce each tool's rules.
        { action: "execute", resource: "*", effect: "allow" },
        ...(override.permissions ?? []),
      ],
    };
  }
  return JSON.parse(JSON.stringify(config));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!process.argv[2]) throw new Error("Usage: node scripts/build-config.mjs OUTPUT");
  await writeFile(process.argv[2], JSON.stringify(await buildConfig(), null, 2) + "\n");
}
