// Caddy's standard handlers own proxying, response headers and safe logging.
// The small opencode_guard module checks requests and counts native backend 401s.
export function proxyConfig(s) {
  const filter = {
    format: "filter", wrap: { format: "json" },
    fields: {
      "request>uri": { filter: "delete" }, "request>headers": { filter: "delete" },
      "request>tls": { filter: "delete" }, resp_headers: { filter: "delete" },
    },
  };
  const security = {
    "X-Content-Type-Options": ["nosniff"], "Referrer-Policy": ["no-referrer"], "X-Frame-Options": ["DENY"],
    ...(s.secure ? { "Strict-Transport-Security": ["max-age=31536000"] } : {}),
  };
  const noStore = match => ({ handler: "headers", response: {
    set: { "Cache-Control": ["no-store"] }, require: match, deferred: true,
  } });
  const protect = { handler: "headers", response: { set: security, deferred: true,
    add: { "Content-Security-Policy": ["frame-ancestors 'none'; base-uri 'self'; form-action 'self'"] },
  } };
  return JSON.stringify({
    admin: { disabled: true },
    logging: { logs: {
      default: { writer: { output: "stdout" }, encoder: filter, exclude: ["http.log.access.gateway"] },
      gateway: { writer: { output: "stdout" }, encoder: filter, include: ["http.log.access.gateway"] },
    } },
    apps: { http: { servers: { gateway: {
      listen: [`0.0.0.0:${s.webPort}`], automatic_https: { disable: true },
      read_header_timeout: 15000000000, idle_timeout: 30000000000,
      logs: { default_logger_name: "gateway" },
      routes: [
        { handle: [protect, noStore({ status_code: [4, 5] })] },
        { match: [{ path: ["/api", "/api/*", "/auth", "/auth/*", "/openapi.json"] }], handle: [noStore({})] },
        { handle: [
          { handler: "opencode_guard", origin: s.origin, trusted_proxies: s.proxies },
          { handler: "reverse_proxy", upstreams: [{ dial: `127.0.0.1:${s.backendPort}` }], flush_interval: -1,
            transport: { protocol: "http", dial_timeout: 5000000000 },
            headers: { request: { set: {
              "X-Forwarded-For": ["{http.vars.opencode_client_ip}"],
              "X-Forwarded-Host": [s.host], "X-Forwarded-Proto": [s.secure ? "https" : "http"],
            } } },
          },
        ] },
      ],
      errors: { routes: [{ handle: [
        protect, noStore({}),
        { handler: "static_response", status_code: "{http.error.status_code}", body: "Request failed" },
      ] }] },
    } } } },
  }, null, 2);
}
