// Materialize upstream agent definitions: V2 replays config after plugin transforms,
// so empty config seeds can overwrite Orchestra's generated instructions/models.
import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
const upstream = new URL("./", import.meta.resolve("@oeronteros-1/opencode-orchestra"));
const { orchestraConfigSchema } = await import(new URL("config/schema.js", upstream));
const { createAgentSet } = await import(new URL("agents/build.js", upstream));
const { loadPrompts } = await import(new URL("prompts/load.js", upstream));

export async function buildConfig() {
  const config = JSON.parse(await readFile(new URL("../opencode.json", import.meta.url)));
  const policy = orchestraConfigSchema.parse(JSON.parse(await readFile(new URL("../orchestra.jsonc", import.meta.url))));
  for (const [name, agent] of Object.entries(createAgentSet(policy, await loadPrompts()))) {
    config.agents[name] = {
      ...config.agents[name], description: agent.description, system: agent.prompt, model: agent.model,
      permissions: Object.entries(agent.permission).flatMap(([action, rules]) => {
        action = ({ bash: "shell", task: "subagent", write: "edit", patch: "edit" })[action] ?? action;
        return typeof rules === "string" ? [{ action, resource: "*", effect: rules }] :
          Object.entries(rules).map(([resource, effect]) => ({ action, resource, effect }));
      }),
    };
  }
  return JSON.parse(JSON.stringify(config));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!process.argv[2]) throw new Error("Usage: node scripts/build-config.mjs OUTPUT");
  await writeFile(process.argv[2], JSON.stringify(await buildConfig(), null, 2) + "\n");
}
