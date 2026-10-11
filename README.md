# OpenCode Server

Self-hosted [OpenCode V2](https://opencode.ai/v2/docs) web UI and API with Gemini, GitHub
Copilot, and WakaTime. Image: `ghcr.io/icco/opencode-server:main` (amd64/arm64).

## Quick start

```sh
export OPENCODE_PASSWORD="$(openssl rand -hex 32)"
docker compose up -d
```

For this local run, `OPENCODE_PASSWORD` is a random password of at least 32
characters. Open <http://localhost:4096> and log in as
`opencode`. Keep repositories under `/data/workspace`.

The same `OPENCODE_PASSWORD` authenticates commands run with `docker compose exec`.
The icco.me deployment loads it and integration tokens from Google Secret Manager
through its existing updater; no production `.env` file is used.

The `/data` volume preserves workspaces, sessions, credentials, and caches.
Back it up. Host bind mounts must be writable by UID/GID 1000.

## GitHub CLI and Git access

Authenticate `gh` once for HTTPS Git access (separate from Copilot login):

```sh
docker compose exec opencode gh auth login --hostname github.com --git-protocol https --web
docker compose exec opencode gh auth status
```

Credentials persist in `/data/.config/gh`. For automation, inject `GH_TOKEN` into
the container environment; it overrides stored logins.

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

For automated hosting, inject `GOOGLE_GENERATIVE_AI_API_KEY` into the container environment.

For [WakaTime](https://github.com/angristan/opencode-wakatime), create
`/data/.wakatime.cfg` owned by `1000:1000`, mode `600`:

```ini
[settings]
api_key = <your key from https://wakatime.com/api-key>
```

## MCP integrations

- **Lunch Money:** inject `LUNCHMONEY_API_TOKEN` using a token from
  [developer settings](https://my.lunchmoney.app/developers). The pinned
  [Lunch Money MCP](https://github.com/akutishevsky/lunchmoney-mcp) v3.0.0 provides
  finance queries and updates through Lunch Money's v2 API. Recreate the container
  after setting the token.
- **Grafana:** the image bundles [Grafana MCP](https://github.com/grafana/mcp-grafana)
  v2.0.2 for read-only dashboards, alerts, annotations, Loki logs (LogQL), and
  Prometheus metrics (PromQL). Set `GRAFANA_URL` and
  `GRAFANA_SERVICE_ACCOUNT_TOKEN` in the container environment, then recreate it. Use a
  Grafana service account with the Viewer role and access to the required
  datasources. Include Grafana's subpath in the URL when applicable, and use an
  endpoint that accepts service-account authentication without a browser-login
  proxy. Loki and Prometheus use Grafana's existing datasource configuration.
- **Context7:** current library documentation via `https://mcp.context7.com/mcp`.
  If OpenCode reports authentication is needed, open `/mcps`, select Context7,
  and sign in. OAuth credentials persist in `/data`.
- **Karakeep:** the official [MCP](https://docs.karakeep.app/integrations/mcp) v0.33.1
  uses `KARAKEEP_API_ADDR` (Compose defaults to `https://hoard.natwelch.com`) and
  `KARAKEEP_API_KEY` from Karakeep's **Settings → API Keys**. Inject the key and
  recreate the container. It supports search/read and **create, update, and delete**
  operations. Verify with a small bookmark search; connection status alone does
  not validate the key.
- **Notion:** Notion's hosted [MCP](https://developers.notion.com/guides/mcp/overview) at `https://mcp.notion.com/mcp`. Open `/mcps`, select Notion, and sign in once. OAuth credentials persist in `/data`.

All five integrations use V2 Code Mode. The default **Build** agent can use them. Without a Lunch Money token its server cannot start. Check connections with:

```sh
docker compose exec opencode opencode api get /api/mcp --server http://127.0.0.1:4096
```

Grafana can advertise tools before credentials are configured; verify access by
listing datasources and running a small query, not just checking MCP connection
status. To turn an integration off, set `disabled: true` on its entry under
`mcp.servers` in your replacement config.

## Superpowers, worktrees, and quota

[`Superpowers`](https://github.com/obra/superpowers) v7.0.0 replaces Orchestra,
pinned to its full Git commit for reproducible installs. The default **Build**
agent uses native skills for planning, debugging, TDD, review, and verification.
Superpowers registers its skills and injects its bootstrap into top-level sessions;
native subagents can load skills without restarting the controller workflow.

Skills in [`skills/`](skills) ship in the image at `/etc/opencode/skills` and update with it: `commit-push-pr` for the commit and PR workflow, and `go-repo` for Go repository scaffolding, lint, and release plumbing.

Only Build receives the blanket tool allow. General can implement and test, while Explore remains read-only; both native subagents are denied Grafana, Lunch Money, Karakeep, Notion, and further delegation. They may use Context7 through Code Mode, whose nested calls enforce each tool's permissions. These are tool boundaries, not OS isolation: General's shell still runs with the server user's authority.

Repository edits must run in Git worktrees under the shared workspace root:
`/data/workspace/.worktrees/<repository>/<task>`. Create the task branch before
editing and move the session there. OpenCode's native worktree API also uses
`/data/workspace/.worktrees` as its parent (and appends its requested/generated name).
The directory setting chooses placement; the global `AGENTS.md` supplies the
always-use-worktrees rule. It does not sandbox arbitrary shell commands.

[`OpenCode Quota`](https://github.com/slkiser/opencode-quota) provides `/quota` and
`/quota_status`; remaining balances do not influence routing. It replaces the
deprecated Cardinal fork; existing quota configuration remains compatible. Gemini Code Assist
quota requires [organization setup](https://github.com/slkiser/opencode-quota/blob/main/docs/readme/providers.md#gemini-cli).

Old persistent `orchestra.jsonc` files are left untouched for rollback, but the
new image does not load Orchestra or generate its agents. Existing sessions that
selected `orch-lead` should switch to **Build** after deploying the image.

### Additional plugin proposals

Research checked on 2026-10-11; these are **not installed**:

| Candidate | Recommendation | V2 and deployment considerations |
| --- | --- | --- |
| [opencode-dcp](https://github.com/arafays/opencode-dcp) | Best next trial for long Copilot sessions: model-directed compression and pruning. | Explicit V2 implementation. Pin a compatible version and test alongside Superpowers/native compaction; summaries can drop important context and alter prompt-cache behavior. |
| [opencode-notifier](https://github.com/mohak34/opencode-notifier) | Useful for unattended tasks if you want a server-side webhook/notification command. | Explicit dual V1/V2 support. Web clients do not receive its desktop sounds/popups; remote alerts need an explicitly configured server command. Native terminal notifications may already suffice. |
| [opencode-security-guard](https://www.npmjs.com/package/opencode-security-guard) | Optional shell-approval layer, not a default addition. | Supports V2 `>=2.0.14 <3`, but sends eligible command text to OpenRouter/Jev and needs a credential. Requires a privacy/cost decision; classifications are not a sandbox. |

Keep Quota, WakaTime, and the current MCP integrations. Avoid adding another
orchestrator such as Oh My OpenCode alongside Superpowers. The popular
[`@tarquinen/opencode-dcp`](https://github.com/Opencode-DCP/opencode-dynamic-context-pruning)
is distinct from the V2-native `opencode-dcp` above; do not infer V2 compatibility
from its own package major version.

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

- Includes Go, TypeScript, pnpm, go-task, golangci-lint, and common shell tools; see [`Dockerfile`](Dockerfile) for versions. Go tools and pnpm global installs persist under `/data/go` and `/data/.local/share/pnpm`.
- Defaults live in [`opencode.jsonc`](opencode.jsonc), loaded at
  `/etc/opencode/opencode.json` after JSONC conversion. To replace this file,
  edit the source config, run `node scripts/build-config.mjs runtime.json`, and
  mount `runtime.json` there read-only. Project `opencode.json(c)` files can override settings normally.
- [`AGENTS.md`](AGENTS.md) is the global instruction file. Each startup copies it to `/data/.config/opencode/AGENTS.md` and overwrites local edits, so change it here instead. OpenCode V2 loads the global file before project instructions and detects ambient edits before the next model request. These are model instructions, not hard permission enforcement. V2 ignores the old `instructions` array and does not run language servers; use each project's lint, typecheck, and compiler commands.
- Restart OpenCode after config changes. After environment/password changes, run
  `docker compose up -d --force-recreate opencode`.
- Versions are pinned in `Dockerfile` and `opencode.jsonc`. CI tests both
  architectures and publishes `main` with provenance attestations.

```sh
pnpm install --frozen-lockfile --ignore-scripts --no-optional
pnpm test
node scripts/test-router-integration.mjs
docker build -t opencode-server .
bash scripts/smoke-test.sh opencode-server
gh attestation verify oci://ghcr.io/icco/opencode-server:main --owner icco
```

The integration check needs the OpenCode version pinned in `Dockerfile`; it uses isolated data on port 4197 (`ROUTER_TEST_PORT` overrides) and requests no inference. It checks every plugin, Superpowers and image skill registration, Build/MCP permissions, worktree settings, Lunch Money/Karakeep stdio handshakes, and quota commands. Image smoke tests also check Grafana and need Node.js 26, Docker, Bash, curl, jq, OpenSSL, and `timeout`. CI runs them on amd64 and arm64.
