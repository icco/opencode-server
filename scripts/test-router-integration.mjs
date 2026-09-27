// Uses connected providers but saves noReply messages: no inference is requested.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

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
  assert.equal(config.model, "auto-router/quality");
  const commands = await request("/command");
  assert.ok(commands.some((command) => command.name === "quota"), "upstream quota commands registered");
  session = await request("/session", { title: "Model-router no-inference integration test" });
  const message = await request(`/session/${session.id}/message`, {
    agent: "build", noReply: true,
    model: { providerID: "auto-router", modelID: "quality" },
    parts: [{ type: "text", text: "Think carefully, weigh the options, and evaluate the architecture." }],
  });
  assert.equal(message.info.agent, "build");
  assert.deepEqual(message.info.model, { providerID: "github-copilot", modelID: "claude-opus-5.5" });
  console.log("Live hook selected:", message.info.model.providerID, message.info.model.modelID);
  const history = await request(`/session/${session.id}/message`);
  assert.equal(history.length, 1);
  assert.equal(history[0].info.role, "user");
  const manual = await request(`/session/${session.id}/message`, {
    agent: "build", noReply: true, model: message.info.model,
    parts: [{ type: "text", text: "Design a database migration" }],
  });
  assert.deepEqual(manual.info.model, message.info.model);
  const simple = await request(`/session/${session.id}/message`, {
    agent: "build", noReply: true, model: { providerID: "auto-router", modelID: "quality" },
    parts: [{ type: "text", text: "hello" }],
  });
  assert.deepEqual(simple.info.model, { providerID: "google", modelID: "gemini-3.8-flash" });
  console.log("Manual selection preserved; no model inference requested.");
} finally {
  if (session) await request(`/session/${session.id}`, undefined, "DELETE").catch(() => {});
  server.kill("SIGTERM");
}
