// Convert source JSONC to the image's runtime JSON without adding agent overrides.
import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { parse, printParseErrorCode } from "jsonc-parser";

export async function readConfig(path = new URL("../opencode.jsonc", import.meta.url)) {
  const errors = [];
  const config = parse((await readFile(path, "utf8")).replace(/^\uFEFF/, ""), errors, { allowTrailingComma: true });
  if (errors.length) {
    throw new Error(`Invalid config ${path}: ${errors.map(error =>
      `${printParseErrorCode(error.error)} at offset ${error.offset}`).join(", ")}`);
  }
  return config;
}

export async function buildConfig({
  configPath = new URL("../opencode.jsonc", import.meta.url),
} = {}) {
  const config = await readConfig(configPath);
  return JSON.parse(JSON.stringify(config));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!process.argv[2]) throw new Error("Usage: node scripts/build-config.mjs OUTPUT");
  await writeFile(process.argv[2], JSON.stringify(await buildConfig(), null, 2) + "\n");
}
