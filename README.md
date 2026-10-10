# OpenCode Server

Self-hosted [OpenCode V2](https://opencode.ai/v2/docs) with a bundled Caddy gateway,
Gemini, GitHub Copilot, Orchestra, quota reporting, and WakaTime.

**Image:** `ghcr.io/icco/opencode-server:main` · amd64 / arm64

## Run locally

```sh
export OPENCODE_PASSWORD="$(openssl rand -hex 32)"
docker compose up -d
```

Open <http://localhost:4096>; the username is `opencode`. `/data` preserves
workspaces, sessions, credentials, and caches. Back it up; keep repositories in
`/data/workspace`. Bind mounts must be accessible to UID/GID 1000.

The icco.me deployment loads credentials from Google Secret Manager through its
existing updater; no production `.env` file is used.

## Host behind HTTPS

Set these variables **before updating an existing public deployment**; the
localhost default rejects other hostnames:

```dotenv
OPENCODE_PUBLIC_URL=https://code.example.com
OPENCODE_TRUSTED_PROXIES=172.20.0.2/32
```

Use the TLS proxy's actual, stable source address. Multiple IPs/CIDRs can be
comma-separated; trust only the proxy, not its entire shared network.

For Caddy running on the host:

```caddyfile
code.example.com {
    reverse_proxy 127.0.0.1:4096 {
        flush_interval -1
    }
}
```

For a container proxy, join its network, remove the Compose `ports` mapping, and
proxy to `opencode:4096`. Preserve Host and send `X-Forwarded-Proto: https` and
`X-Forwarded-For` with the actual client address appended on the right.

Bundled Caddy checks origins, throttles failed logins, adds security headers, and
redacts logs. OpenCode owns authentication on loopback port 4097. Keep the default
command and expose only port 4096. Both processes are supervised; either exiting
stops the container. Health checks exercise the gateway and backend.

Disable or redact credential-bearing URLs in the **outer proxy's** access and
error logs too. Rotate previously exposed credentials. Keep the non-root user,
dropped capabilities, and resource limits. **Login grants code execution and
access to mounted credentials.** Use dedicated SSH keys and scoped tokens; this
is not a multi-tenant sandbox, and outbound host/LAN access is unrestricted.

## Credentials and Git access

Secrets can come from environment variables or read-only files outside the
workspace. Supported file variables are `OPENCODE_PASSWORD_FILE`,
`GOOGLE_GENERATIVE_AI_API_KEY_FILE`, `GH_TOKEN_FILE`, `GITHUB_TOKEN_FILE`,
`LUNCHMONEY_API_TOKEN_FILE`, `GRAFANA_SERVICE_ACCOUNT_TOKEN_FILE`, and
`KARAKEEP_API_KEY_FILE`.
Make files readable by UID 1000; set either the direct value or `_FILE`, not both.
Recreate the container after changing credentials.

For CLI operations inside the container, use the entrypoint to load file secrets
and connect to the authenticated private backend (independent of the public Host):

```sh
docker compose exec opencode /usr/local/bin/entrypoint.sh opencode api get /api/mcp --server http://127.0.0.1:4097
```

Authenticate `gh` once for HTTPS Git access (separate from Copilot login):

```sh
docker compose exec opencode gh auth login --hostname github.com --git-protocol https --web
docker compose exec opencode gh auth status
```

Credentials persist in `/data/.config/gh`; `GH_TOKEN` overrides stored logins.
Compose mounts `${HOME}/.ssh` read-only at `/data/.ssh`. Create it before startup,
make keys readable by UID 1000 with SSH-compatible permissions, and populate
`known_hosts`. Remove the mount if you only use HTTPS Git.

## Providers and MCP integrations

Connect providers through the Web UI:

- **Copilot:** complete GitHub device login; requires a subscription.
- **Gemini:** choose Google → **Manually enter API Key**, or inject
  `GOOGLE_GENERATIVE_AI_API_KEY`. Organization-backed Code Assist can use OAuth;
  set `OPENCODE_GEMINI_PROJECT_ID` and paste the full localhost redirect URL into
  the prompt. Consumer OAuth is discontinued; see the
  [plugin docs](https://github.com/jenslys/opencode-gemini-auth).
- **WakaTime:** create `/data/.wakatime.cfg`, owned by `1000:1000`, mode `600`:

  ```ini
  [settings]
  api_key = <your key from https://wakatime.com/api-key>
  ```

MCP credentials belong in the container environment; recreate it after changes:

- **Lunch Money:** set `LUNCHMONEY_API_TOKEN` from
  [developer settings](https://my.lunchmoney.app/developers). The pinned
  [MCP v3.0.0](https://github.com/akutishevsky/lunchmoney-mcp) supports finance
  queries and updates through Lunch Money's v2 API; without a token it cannot start.
- **Grafana:** bundled [MCP v2.0.1](https://github.com/grafana/mcp-grafana) supports
  read-only dashboards, alerts, annotations, Loki, and Prometheus. Set `GRAFANA_URL`
  (including any subpath) and `GRAFANA_SERVICE_ACCOUNT_TOKEN`. Use a Viewer service
  account with datasource access and an endpoint accepting service-account auth
  without a browser-login proxy. Verify with a datasource listing and small query;
  connection status alone does not establish credential validity.
- **Context7:** library documentation via `https://mcp.context7.com/mcp`. If auth
  is needed, open `/mcps`, select Context7, and sign in; credentials persist in `/data`.
- **Karakeep:** the official [MCP v0.33.1](https://docs.karakeep.app/integrations/mcp)
  runs locally over stdio and connects to `KARAKEEP_API_ADDR` (Compose defaults to
  `https://hoard.natwelch.com`). Create a dedicated API key in that instance's
  **Settings → API Keys** and inject `KARAKEEP_API_KEY`, or mount a read-only secret
  and set `KARAKEEP_API_KEY_FILE` to its container path. Set the address explicitly
  when not using Compose. The MCP can search/read **and create, update, and delete**
  bookmarks, lists, and tags; it is not read-only. After recreating the container,
  check `/mcps` and run a small bookmark search to verify API authentication;
  a connected MCP alone does not validate the key. The icco.me deployment loads
  the key from `mist-opencode-karakeep-api-key` in Secret Manager; provision its
  value before running the host updater. Never put the key in this configuration.

All use V2 Code Mode. `orch-lead` can use all four; docs/research workers can use
Context7. Disable an integration with `disabled: true` under `mcp.servers` in your
replacement config.

## Specialist routing and quota

[`Orchestra`](https://github.com/Oeronteros/opencode-orchestra) provides `/orchestra`
and the default **orch-lead** agent; choose **Build** or **Plan** for a single-agent
workflow. [`orchestra.jsonc`](orchestra.jsonc) assigns GPT-6 Astra to lead/tests/merge,
Sonnet 5 to repository exploration, Gemini to docs/research, and Opus 5.5 to
review/security/judging. Workers have ordered fallbacks, two concurrent/eight total.
Superpowers compatibility is disabled because this image does not install its skills.

[`OpenCode Quota`](https://github.com/slkiser/opencode-quota) provides `/quota` and
`/quota_status`; balances do not influence routing. It replaces the deprecated
Cardinal fork, preserving quota configuration compatibility. Gemini Code Assist
quota requires [organization setup](https://github.com/slkiser/opencode-quota/blob/main/docs/readme/providers.md#gemini-cli).

The server seeds `/data/.config/opencode/orchestra.jsonc` once and preserves it.
Project `.opencode/orchestra.jsonc` overrides it; restart after edits. Agent prompts
and native model defaults are materialized during the build: regenerate the config
or override `agents.<name>.model` in project configuration to change them.

## Configure and operate

- Defaults live in [`opencode.jsonc`](opencode.jsonc). To replace the materialized
  `/etc/opencode/opencode.json`, run `node scripts/build-config.mjs runtime.json`
  and mount the result read-only. The raw source omits generated Orchestra agents.
  Project `opencode.json(c)` files can override settings normally.
- [`AGENTS.md`](AGENTS.md) seeds `/data/.config/opencode/AGENTS.md` once; edit the
  persistent copy for global instructions. V2 ignores the old `instructions` array
  and does not run language servers; use project lint/typecheck/compiler commands.
- Go tools and pnpm global installs persist under `/data/go` and
  `/data/.local/share/pnpm`. See [`Dockerfile`](Dockerfile) for pinned tool versions.

```sh
docker compose up -d --pull always --force-recreate opencode
docker compose logs --tail 100 opencode
```

Native diagnostics are private, rotated at 4 MiB, in
`/data/.local/state/opencode-web/server.log`. They may contain sensitive data.

| Response | Check |
| --- | --- |
| 401 | OpenCode credentials; password rotation invalidates sessions. |
| 403 | Origin, trusted proxy address, and `X-Forwarded-Proto`. |
| 421 | Host must match `OPENCODE_PUBLIC_URL`. |
| 429 | Client IP reached 20 authentication failures in ten minutes; respect `Retry-After`. Shared NAT clients share this limit. |

## Development

```sh
pnpm install --frozen-lockfile --ignore-scripts --no-optional
pnpm test
(cd gateway && go test -race ./... && go build -o ../node_modules/.cache/opencode-caddy .)
CADDY_BIN="$PWD/node_modules/.cache/opencode-caddy" node --test --test-timeout=30000 tests/web/*.test.mjs
node scripts/test-router-integration.mjs
docker build -t opencode-server .
bash scripts/smoke-test.sh opencode-server
gh attestation verify oci://ghcr.io/icco/opencode-server:main --owner icco
```

Use the OpenCode version pinned in `Dockerfile`. Integration tests isolate data
on port 4197 (`ROUTER_TEST_PORT` overrides), verify plugins/permissions/MCPs/quota,
and request no inference. Image smoke tests require Node.js 26, Docker, Bash, curl,
jq, OpenSSL, and `timeout`; CI runs on amd64 and arm64 and publishes attested `main`.
