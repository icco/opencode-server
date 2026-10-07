import { readFileSync, statSync } from "node:fs";
import { isIP } from "node:net";

export function loadSecrets(input) {
  const env = { ...input };
  for (const name of ["OPENCODE_PASSWORD", "GOOGLE_GENERATIVE_AI_API_KEY", "GH_TOKEN", "GITHUB_TOKEN",
    "LUNCHMONEY_API_TOKEN", "GRAFANA_SERVICE_ACCOUNT_TOKEN"]) {
    const file = env[`${name}_FILE`];
    if (!file) continue;
    if (env[name]) throw new Error(`Set either ${name} or ${name}_FILE, not both`);
    try {
      const stat = statSync(file);
      if (!stat.isFile() || stat.size > 16384) throw new Error();
      env[name] = readFileSync(file, "utf8").replace(/\r?\n$/, "");
    } catch {
      throw new Error(`Cannot read ${name}_FILE`);
    }
    if (!env[name] || /[\r\n\0]/.test(env[name])) throw new Error(`Invalid ${name}_FILE contents`);
    delete env[`${name}_FILE`];
  }
  const password = env.OPENCODE_PASSWORD;
  if (!password || password.length < 32 || password.length > 4096 || /[\r\n\0]/.test(password)) {
    throw new Error("OPENCODE_PASSWORD must be 32–4096 characters; generate it with openssl rand -hex 32");
  }
  if (env.OPENCODE_SERVER_USERNAME && env.OPENCODE_SERVER_USERNAME !== "opencode") {
    throw new Error("OpenCode V2 requires username opencode");
  }
  return env;
}

export function settings(env) {
  function port(name, fallback) {
    const value = env[name] || String(fallback);
    if (!/^\d+$/.test(value) || +value < 1024 || +value > 65535) throw new Error(`Invalid ${name}`);
    return +value;
  }
  const webPort = port("OPENCODE_WEB_PORT", 4096);
  const backendPort = port("OPENCODE_BACKEND_PORT", 4097);
  if (webPort === backendPort) throw new Error("Web and backend ports must differ");
  let url;
  try { url = new URL(env.OPENCODE_PUBLIC_URL || `http://localhost:${webPort}`); } catch {
    throw new Error("Invalid OPENCODE_PUBLIC_URL");
  }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  const hostname = /^[a-z0-9.-]+$/.test(url.hostname) ||
    (url.hostname.startsWith("[") && isIP(url.hostname.slice(1, -1)) === 6);
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash ||
      !hostname || !["https:", "http:"].includes(url.protocol) || (url.protocol === "http:" && !loopback)) {
    throw new Error("OPENCODE_PUBLIC_URL must be an HTTPS origin, or HTTP on loopback; subpaths are unsupported");
  }
  const proxies = (env.OPENCODE_TRUSTED_PROXIES || "").split(/[\s,]+/).filter(Boolean);
  for (const cidr of proxies) {
    const [ip, bits, extra] = cidr.split("/");
    const family = isIP(ip);
    if (!family || !/^[a-fA-F0-9:.]+$/.test(ip) || extra !== undefined ||
        (bits !== undefined && (!/^\d+$/.test(bits) || +bits < 1 || +bits > (family === 4 ? 32 : 128)))) {
      throw new Error("OPENCODE_TRUSTED_PROXIES must contain explicit IPs/CIDRs; trust-all ranges are forbidden");
    }
  }
  if (url.protocol === "https:" && !proxies.length) {
    throw new Error("HTTPS hosting requires OPENCODE_TRUSTED_PROXIES set to the TLS proxy's addresses");
  }
  return { webPort, backendPort, origin: url.origin, host: url.host, secure: url.protocol === "https:", proxies };
}

export function authorization(env) {
  return `Basic ${Buffer.from(`opencode:${env.OPENCODE_PASSWORD}`).toString("base64")}`;
}
