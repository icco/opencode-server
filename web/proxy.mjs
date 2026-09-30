// All interpolated values come from settings.mjs validation; no secrets enter
// this file. HAProxy implements HTTP, WebSockets and failure counters itself.
export function proxyConfig(s) {
  return `global
  log stdout format raw local0
  maxconn 512
  nbthread 2

defaults
  mode http
  log global
  timeout connect 5s
  timeout http-request 15s
  timeout http-keep-alive 30s
  timeout client 1h
  timeout server 1h
  timeout tunnel 1h
  log-format '{"component":"gateway","client":"%[var(txn.client_ip)]","status":%ST,"bytes":%B}'
  error-log-format '{"component":"gateway","status":%ST}'

frontend web
  bind 0.0.0.0:${s.webPort}
  acl local_peer src 127.0.0.0/8 ::1/128
  ${s.proxies.length ? `acl trusted_proxy src ${s.proxies.join(" ")}` : "acl trusted_proxy always_false"}
  http-request set-var(txn.client_ip) src
  ${s.secure ? `http-request deny deny_status 403 if !trusted_proxy !local_peer
  http-request deny deny_status 403 if trusted_proxy !{ req.hdr(X-Forwarded-Proto) -m str https }
  http-request deny deny_status 403 if trusted_proxy !{ req.hdr_cnt(X-Forwarded-Proto) eq 1 }` : ""}
  http-request deny deny_status 421 unless { req.hdr(host),lower -m str ${s.host} }
  http-request deny deny_status 403 if { req.hdr_cnt(origin) gt 1 }
  http-request deny deny_status 403 if { req.hdr(origin) -m found } !{ req.hdr(origin) -m str ${s.origin} }

  # Use only the rightmost address appended by our explicitly trusted edge.
  http-request set-var(txn.client_ip) req.hdr_ip(X-Forwarded-For,-1) if trusted_proxy { req.hdr_ip(X-Forwarded-For,-1) -m found }
  http-request del-header Forwarded
  http-request del-header X-Real-IP
  http-request set-header X-Forwarded-For %[var(txn.client_ip)]
  http-request set-header X-Forwarded-Host ${s.host}
  http-request set-header X-Forwarded-Proto ${s.secure ? "https" : "http"}

  # Only backend 401s increment this bounded, per-client counter. Successful
  # requests, normal traffic volume and cross-origin 403s do not incur failures.
  stick-table type ip size 100k expire 10m store gpc0_rate(10m)
  http-request track-sc0 var(txn.client_ip)
  http-request return status 429 content-type text/plain string "Too many authentication failures" hdr Retry-After 600 if { sc_gpc0_rate(0) ge 20 }
  http-response sc-inc-gpc0(0) if { status 401 }

  http-request set-var(txn.sensitive) bool(true) if { path_beg /api/ /auth/ } || { path -m str /api /auth /openapi.json }
  http-after-response set-header X-Content-Type-Options nosniff
  http-after-response set-header Referrer-Policy no-referrer
  http-after-response set-header X-Frame-Options DENY
  http-after-response add-header Content-Security-Policy "frame-ancestors 'none'; base-uri 'self'; form-action 'self'"
  http-after-response set-header Cache-Control no-store if { var(txn.sensitive) -m bool } || { status ge 400 }
  ${s.secure ? 'http-after-response set-header Strict-Transport-Security "max-age=31536000"' : ""}
  default_backend opencode

backend opencode
  server local 127.0.0.1:${s.backendPort}
`;
}
