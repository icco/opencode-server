// Uses connected providers but saves noReply messages: no inference is requested.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const password = randomBytes(32).toString("hex");
const root = fileURLToPath(new URL("../", import.meta.url));
const port = process.env.ROUTER_TEST_PORT || "4197";
const server = spawn("opencode", ["serve", "--hostname", "127.0.0.1", "--port", port], {
  cwd: root,
  env: { ...process.env, OPENCODE_CONFIG: `${root}opencode.json`,
    OPENCODE_SERVER_PASSWORD: password, OPENCODE_SERVER_USERNAME: "opencode" },
  stdio: ["ignore", "pipe", "pipe"],
});
let logs = "";
server.stdout.on("data", (chunk) => { logs += chunk; });
server.stderr.on("data", (chunk) => { logs += chunk; });
const url = `http://127.0.0.1:${port}`;
async function request(path, body, method = body ? "POST" : "GET") {
  const result = await fetch(url + path, { method, headers: {
    Authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`,
    "Content-Type": "application/json",
  }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(60000) });
  if (!result.ok) throw new Error(`${path}: ${result.status} ${await result.text()}`);
  return result.json();
}
let session;
try {
  for (let i = 0; i < 100; i++) {
    try { await request("/global/health"); break; } catch {
      if (server.exitCode !== null) throw new Error(logs);
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
  }
  const config = await request("/config");
  assert.equal(config.default_agent, "auto");
  session = await request("/session", { title: "Model-router no-inference integration test" });
  const message = await request(`/session/${session.id}/message`, {
    agent: "auto", noReply: true,
    model: { providerID: "google", modelID: "gemini-flash-latest" },
    parts: [{ type: "text", text: "Design a database migration and review its security" }],
  });
  assert.equal(message.info.agent, "auto");
  assert.ok(message.info.model.modelID);
  const policy = JSON.parse(await readFile(new URL("../model-routing.json", import.meta.url)));
  assert.ok([...policy.rules.flatMap((rule) => rule.models), ...policy.defaultModels]
    .includes(`${message.info.model.providerID}/${message.info.model.modelID}`));
  console.log("Live hook selected:", message.info.model.providerID, message.info.model.modelID);
  const history = await request(`/session/${session.id}/message`);
  assert.equal(history.length, 1);
  assert.equal(history[0].info.role, "user");
  const manual = await request(`/session/${session.id}/message`, {
    agent: "build", noReply: true, model: message.info.model,
    parts: [{ type: "text", text: "Design a database migration" }],
  });
  assert.deepEqual(manual.info.model, message.info.model);
  console.log("Manual selection preserved; no model inference requested.");
} finally {
  if (session) await request(`/session/${session.id}`, undefined, "DELETE").catch(() => {});
  server.kill("SIGTERM");
}
