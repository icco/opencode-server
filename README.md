# OpenCode Server

Self-hosted [OpenCode V2](https://opencode.ai/v2/docs) web UI and API with Gemini, GitHub
Copilot, and WakaTime. Image: `ghcr.io/icco/opencode-server:main` (amd64/arm64).

## Quick start

```sh
cp .env.example .env
chmod 600 .env
$EDITOR .env
docker compose up -d
```

Set `OPENCODE_SERVER_PASSWORD` in `.env` to a random password of at least 32
characters (`openssl rand -hex 32`). Open <http://localhost:4096> and log in as
`opencode`. Keep repositories under `/data/workspace`.

Compose passes this password as V2's `OPENCODE_PASSWORD`, so commands run with
`docker compose exec` can also authenticate. For direct `docker run`, set
`OPENCODE_PASSWORD`; the old `OPENCODE_SERVER_PASSWORD` image variable is still accepted.

The `/data` volume preserves workspaces, sessions, credentials, and caches.
Back it up. Host bind mounts must be writable by UID/GID 1000.

## GitHub CLI and Git access

Authenticate `gh` once for HTTPS Git access (separate from Copilot login):

```sh
docker compose exec opencode gh auth login --hostname github.com --git-protocol https --web
docker compose exec opencode gh auth status
```

Credentials persist in `/data/.config/gh`. For automation, set `GH_TOKEN` in the
untracked `.env` file and recreate the container; it overrides stored logins.

SSH remotes use the host's `${HOME}/.ssh`, mounted read-only at `/data/.ssh`.
Create it before startup, make keys readable by UID 1000 with SSH-compatible
permissions, and add required hosts to `known_hosts` on the host.

## Connect providers

Connect both providers through the Web UI or the running server:

```sh
docker compose exec opencode opencode auth login github-copilot --server http://127.0.0.1:4096
docker compose exec opencode opencode auth login google --server http://127.0.0.1:4096
```

- **Copilot:** choose GitHub Copilot and complete device login. Requires a subscription.
- **Gemini:** choose Google → **Manually enter API Key**. Organization-backed Code
  Assist can use OAuth: open the login URL and paste the full localhost redirect
  URL into the prompt. Set `OPENCODE_GEMINI_PROJECT_ID` in the container environment.
  Consumer OAuth is discontinued; see the [Gemini plugin docs](https://github.com/jenslys/opencode-gemini-auth).

For automated hosting, set `GOOGLE_GENERATIVE_AI_API_KEY` in `.env`.

For [WakaTime](https://github.com/angristan/opencode-wakatime), create
`/data/.wakatime.cfg` owned by `1000:1000`, mode `600`:

```ini
[settings]
api_key = <your key from https://wakatime.com/api-key>
```

## MCP integrations

- **Lunch Money:** set `LUNCHMONEY_API_TOKEN` in `.env` using a token from
  [developer settings](https://my.lunchmoney.app/developers). The pinned
  [Lunch Money MCP](https://github.com/akutishevsky/lunchmoney-mcp) v3.0.0 provides
  finance queries and updates through Lunch Money's v2 API. Recreate the container
  after setting the token.
- **Grafana:** the image bundles [Grafana MCP](https://github.com/grafana/mcp-grafana)
  v2.0.1 for read-only dashboards, alerts, annotations, Loki logs (LogQL), and
  Prometheus metrics (PromQL). Set `GRAFANA_URL` and
  `GRAFANA_SERVICE_ACCOUNT_TOKEN` in `.env`, then recreate the container. Use a
  Grafana service account with the Viewer role and access to the required
  datasources. Include Grafana's subpath in the URL when applicable, and use an
  endpoint that accepts service-account authentication without a browser-login
  proxy. Loki and Prometheus use Grafana's existing datasource configuration.
- **Context7:** current library documentation via `https://mcp.context7.com/mcp`.
  If OpenCode reports authentication is needed, open `/mcps`, select Context7,
  and sign in. OAuth credentials persist in `/data`.

All three integrations use V2 Code Mode. The default `orch-lead` agent can use them;
docs/research workers can use Context7. Without a Lunch Money token its server
cannot start. Check connections with:

```sh
docker compose exec opencode opencode api get /api/mcp --server http://127.0.0.1:4096
```

Grafana can advertise tools before credentials are configured; verify access by
listing datasources and running a small query, not just checking MCP connection
status. To turn an integration off, set `disabled: true` on its entry under
`mcp.servers` in your replacement config.

## Specialist routing and quota

[`Orchestra`](https://github.com/Oeronteros/opencode-orchestra) runs quality-first
specialist workflows. Use `/orchestra <task>` or the default **orch-lead** agent;
choose **Build** or **Plan** for the normal single-agent workflow.

[`orchestra.jsonc`](orchestra.jsonc) assigns GPT-6 Astra to the lead/tests/merge,
Sonnet 5 to repository exploration, Gemini to docs/research, and Opus 5.5 to
review/security/judging. Subagents have ordered fallback chains; the lead uses
OpenCode's native request path. Two workers run concurrently, with eight total.

[`OpenCode Quota`](https://github.com/slkiser/opencode-quota) provides `/quota` and
`/quota_status`; remaining balances do not influence routing. It replaces the
deprecated Cardinal fork; existing quota configuration remains compatible. Gemini Code Assist
quota requires [organization setup](https://github.com/slkiser/opencode-quota/blob/main/docs/readme/providers.md#gemini-cli).

The server seeds `/data/.config/opencode/orchestra.jsonc` once and preserves it.
Project `.opencode/orchestra.jsonc` overrides it. Restart after edits. The policy
controls Orchestra dispatch and fallbacks. Agent prompts and native default model
assignments are materialized during the image build, so changing those requires
regenerating the config or setting `agents.<name>.model` in a project config.
Superpowers compatibility is disabled because this image does not install its skills.

### Upgrading from V1

Back up `/data` before first V2 startup; V2 migrates legacy data. V2 fixes the login
name to `opencode`, uses `/api/*` endpoints, and changes the plugin API. Migrate
custom config mounts and plugins using the [migration guide](https://opencode.ai/v2/docs/migrate-v1).

## Public hosting

Use HTTPS. With Caddy on the host:

```caddyfile
code.example.com {
    reverse_proxy 127.0.0.1:4096 {
        flush_interval -1
    }
}
```

For a container proxy, join its network, remove the Compose `ports` mapping,
and proxy to `opencode:4096`.

The container runs non-root with dropped capabilities and resource limits.
Keep these controls. **Login grants code execution and
access to stored credentials.** Shared networks permit service-to-service access;
outbound host/LAN access is unrestricted. This is not a multi-tenant sandbox.

## Configuration and development

- Includes Go, TypeScript, pnpm, and common shell tools; see [`Dockerfile`](Dockerfile) for versions.
  Go tools and pnpm global installs persist under `/data/go` and `/data/.local/share/pnpm`.
- Defaults live in [`opencode.json`](opencode.json), loaded at
  `/etc/opencode/opencode.json` after agent materialization. To replace this file,
  edit the source config, run `node scripts/build-config.mjs runtime.json`, and
  mount `runtime.json` there read-only. The raw source omits generated Orchestra
  definitions. Project `opencode.json(c)` files can override settings normally.
- [`AGENTS.md`](AGENTS.md) is seeded to `/data/.config/opencode/AGENTS.md` on first
  startup and preserved thereafter. Edit that persistent file for global instructions.
  V2 ignores the old `instructions` array and does not run language servers;
  use each project's lint, typecheck, and compiler commands.
- Restart OpenCode after config changes. After environment/password changes, run
  `docker compose up -d --force-recreate opencode`.
- Versions are pinned in `Dockerfile` and `opencode.json`. CI tests both
  architectures and publishes `main` with provenance attestations.

```sh
pnpm install --frozen-lockfile --ignore-scripts --no-optional
pnpm test
node scripts/test-router-integration.mjs
docker build -t opencode-server .
bash scripts/smoke-test.sh opencode-server
gh attestation verify oci://ghcr.io/icco/opencode-server:main --owner icco
```

The integration check needs the OpenCode version pinned in `Dockerfile`; it uses
isolated data on port 4197 (`ROUTER_TEST_PORT` overrides) and requests no inference.
It checks every plugin, agent/MCP permissions, Lunch Money's stdio handshake, and
quota commands. Image smoke tests also check Grafana and need Node.js 26, Docker,
Bash, curl, jq, OpenSSL, and `timeout`. CI runs them on amd64 and arm64.
