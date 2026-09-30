import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { loadSecrets } from "./settings.mjs";
import { supervise } from "./supervisor.mjs";

process.umask(0o077);
try {
  const env = loadSecrets(process.env);
  for (const path of [join(env.XDG_CONFIG_HOME, "opencode"), join(env.XDG_CONFIG_HOME, "gh"),
    env.XDG_DATA_HOME, env.XDG_STATE_HOME, env.XDG_CACHE_HOME, join(env.HOME, "workspace")]) {
    mkdirSync(path, { recursive: true, mode: 0o700 });
  }
  const policy = join(env.XDG_CONFIG_HOME, "opencode/orchestra.jsonc");
  if (!existsSync(policy) && !existsSync(policy.replace(/jsonc$/, "json"))) {
    copyFileSync("/etc/opencode/orchestra.jsonc", policy);
  }
  for (const host of ["github.com", "gist.github.com"]) {
    for (const args of [["--replace-all", `credential.https://${host}.helper`, ""],
      ["--add", `credential.https://${host}.helper`, "!gh auth git-credential"]]) {
      const result = spawnSync("git", ["config", "--global", ...args], { env, stdio: "pipe" });
      if (result.error || result.status !== 0) throw new Error("Could not configure the GitHub credential helper");
    }
  }
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "web") {
    process.exitCode = await supervise(env);
  } else {
    if (!args.length) throw new Error("No command supplied");
    const child = spawn(args[0], args.slice(1), { env, stdio: "inherit" });
    for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => child.kill(signal));
    child.once("error", () => { console.error("Command could not start"); process.exitCode = 1; });
    child.once("exit", (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); });
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
