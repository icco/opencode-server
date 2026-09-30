import { authorization, loadSecrets, settings } from "./settings.mjs";
import { request } from "node:http";

try {
  const env = loadSecrets(process.env);
  const s = settings(env);
  // Node's fetch does not permit overriding Host. The health probe connects
  // through loopback but must use the configured public virtual host.
  const healthy = await new Promise((resolve, reject) => {
    const req = request({ hostname: "127.0.0.1", port: s.webPort, path: "/api/info",
      headers: { Authorization: authorization(env), Host: s.host, "X-Forwarded-Proto": s.secure ? "https" : "http" },
      signal: AbortSignal.timeout(4000),
    }, response => { response.resume(); resolve(response.statusCode === 200); });
    req.on("error", reject);
    req.end();
  });
  if (!healthy) throw new Error();
} catch {
  console.error("Protected OpenCode endpoint is unhealthy");
  process.exitCode = 1;
}
