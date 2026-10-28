# OpenCode Server

Self-hosted [OpenCode V2](https://opencode.ai/v2/docs/) behind the [OpenChamber](https://docs.openchamber.dev/) web UI. The image `ghcr.io/icco/opencode-server:main` supports amd64 and arm64.

## Run

From this checkout, with Docker Compose and OpenSSL installed:

```sh
mkdir -p "$HOME/.ssh"
export OPENCODE_PASSWORD="$(openssl rand -hex 32)"
export OPENCHAMBER_UI_PASSWORD="$(openssl rand -hex 32)"
docker compose up -d
```

Open <http://localhost:3000> and sign in with `OPENCHAMBER_UI_PASSWORD`. Keep both passwords in your deployment's secret store and export them for later Compose commands; startup requires at least 32 characters for each. OpenCode has no host port; only OpenChamber reaches it, over the Compose network.

All state lives in the `/data` volume, and startup exits if `/data` is not a volume or bind mount. Bind mounts must be writable by UID/GID 1000. Compose also mounts the host's `~/.ssh` read-only; keys must be readable by UID 1000, and `known_hosts` must be maintained on the host.

| Path under `/data` | Contents |
| --- | --- |
| `.local/share/opencode/opencode.db` | Sessions and provider credentials |
| `.local/share/opencode/log/opencode.log` | OpenCode server log |
| `.local/state/opencode` | Service registration, locks, and quota budget counters |
| `.config/opencode`, `.config/gh` | Global `AGENTS.md` (replaced on each start), GitHub CLI login |
| `.config/openchamber` | OpenChamber settings, passkeys, and login secret |
| `workspace` | Repositories, worktrees, and OpenChamber chats in `workspace/.chats` |

Back up the whole volume. To restore, stop both containers, replace the volume contents, and start them again. The servers keep files open or cached in memory, so deleting one from a running volume takes effect at the next restart.

To update the image or apply changed environment variables:

```sh
docker compose pull
docker compose up -d --force-recreate
```

## Connect accounts

Connect providers in OpenCode or run:

```sh
docker compose exec opencode opencode auth login google --method key --server http://127.0.0.1:4096
docker compose exec opencode opencode auth login anthropic --method key --server http://127.0.0.1:4096
docker compose exec opencode opencode auth login openai --method key --server http://127.0.0.1:4096
```

- **Gemini:** enter a key or set `GOOGLE_GENERATIVE_AI_API_KEY`.
- **Anthropic:** enter a [Console API key](https://console.anthropic.com/settings/keys) or set `ANTHROPIC_API_KEY`.
- **OpenAI:** enter a [platform key](https://platform.openai.com/api-keys) or set `OPENAI_API_KEY`.
- **Git access:** set `GH_TOKEN` or run `docker compose exec opencode gh auth login --hostname github.com --git-protocol https --web`; stored credentials persist in `/data/.config/gh`. `GH_TOKEN` also authenticates pnpm to `@icco` packages on GitHub Packages via [`config/npmrc`](config/npmrc).
- **WakaTime:** put your API key in `/data/.wakatime.cfg`, owned by `1000:1000` with mode `600`, using the [plugin's configuration format](https://github.com/angristan/opencode-wakatime#prerequisites).

## Budgets and fallback

Build defaults to `anthropic/claude-opus-5-5`. The general, explore, title, and compaction agents use `openai/fast-agent`, a [LiteLLM](https://docs.litellm.ai/) model group, so they need the `openai` provider's `baseURL` pointed at a LiteLLM proxy that defines it. Point the `anthropic` provider at the proxy too, and let the proxy choose the model behind `claude-opus-5-5` with [key-level router settings](https://docs.litellm.ai/docs/proxy/keys_teams_router_settings), so a spent provider is skipped before the call. Keep each provider console's spend limit above the proxy's budget, so the proxy stops a provider before the console does.

`/quota` shows a $50 rolling 30-day row each for Anthropic, OpenAI, and Google, estimated from this server's requests with [models.dev](https://models.dev) prices. The rows come from [`config/quota-toast.jsonc`](config/quota-toast.jsonc), which each start copies to `/data/.config/opencode/opencode-quota/`, replacing local edits.

## MCP integrations

Set the variables below before creating the container. For remote servers, open `/mcps`, select the server, and sign in when prompted; OAuth credentials persist in `/data`.

| Integration | Setup |
| --- | --- |
| [Context7](https://mcp.context7.com/mcp) | Remote library documentation. |
| [Gmail](https://developers.google.com/workspace/gmail/api/guides/configure-mcp-server) | Remote server at `https://gmailmcp.googleapis.com/mcp/v1` (Developer Preview). Create a Web application OAuth client with redirect URI `http://127.0.0.1:19876/callback` and set `GMAIL_MCP_CLIENT_ID` and `GMAIL_MCP_CLIENT_SECRET`; read and draft only, no send. The callback listener is on the container loopback, so after consent copy the failed `127.0.0.1:19876` URL from the browser and run `docker compose exec opencode curl -fsS "<url>"`. |
| [Grafana](https://github.com/grafana/mcp-grafana) | `GRAFANA_URL` and `GRAFANA_SERVICE_ACCOUNT_TOKEN`; bundled tools are read-only. |
| [Karakeep](https://docs.karakeep.app/integrations/mcp) | `KARAKEEP_API_KEY` and `KARAKEEP_API_ADDR` (defaults to `https://hoard.natwelch.com`); includes write tools. |
| [Lunch Money](https://github.com/akutishevsky/lunchmoney-mcp) | `LUNCHMONEY_API_TOKEN` from [developer settings](https://my.lunchmoney.app/developers); required to start its MCP server. |
| [Notion](https://developers.notion.com/guides/mcp/overview) | Remote server at `https://mcp.notion.com/mcp`. |
| [Robinhood](https://robinhood.com/us/en/support/articles/onboarding-an-external-agent/) | Remote trading server at `https://agent.robinhood.com/mcp/trading`; complete account onboarding during sign-in. |

Check connections with:

```sh
docker compose exec opencode opencode api get /api/mcp --server http://127.0.0.1:4096
```

Grafana and Karakeep can connect before their credentials are validated; check a small read query too. Disable unused integrations with `disabled: true` in their `mcp.servers` entries; see [MCP configuration](https://opencode.ai/v2/docs/mcp-servers).

## Agents and configuration

- **Build** is the default agent and can use all configured tools. **General** can implement and test; **Explore** is read-only. Both subagents may use Context7 but deny Gmail, Grafana, Lunch Money, Karakeep, Notion, Robinhood, and further delegation. Build and General ask before `rm` commands whose text contains `.config`, `.local`, `HOME`, `~`, or `/data/.`, or ends in `/data`. Tool permissions do not sandbox shell access.
- [Superpowers](https://github.com/obra/superpowers) supplies planning, debugging, testing, and review skills. The image also ships [`commit-push-pr`, `go-repo`, and `observability-graph`](skills/), with the graph renderer's dependencies preinstalled. [`AGENTS.md`](AGENTS.md) requires repository edits in `/data/workspace/.worktrees/<repository>/<task>`.
- [OpenCode Quota](https://github.com/slkiser/opencode-quota) provides `/quota` and `/quota_status`.
- Defaults and pinned plugins live in [`config/system.jsonc`](config/system.jsonc). The image converts it to `/etc/opencode/opencode.json`, which overrides matching settings in global and project `opencode.json(c)` files. Keeping the source file out of `opencode.json(c)` prevents OpenCode from auto-discovering this repository as a second project configuration. See the [V2 configuration guide](https://opencode.ai/v2/docs/config).
- Each startup copies the image's [`AGENTS.md`](AGENTS.md) to `/data/.config/opencode/AGENTS.md`, replacing local edits. Change instructions in this repository and rebuild.

To replace the image defaults, install dependencies, edit `config/system.jsonc`, run `node scripts/build-config.mjs runtime.json`, and mount the output read-only at `/etc/opencode/opencode.json`. Restart the container after replacing it.

## Hosting

Compose binds OpenChamber only to `127.0.0.1:3000`. Put an HTTPS reverse proxy in front for remote access, following [OpenChamber's reverse proxy guide](https://docs.openchamber.dev/reverse-proxy/). With Caddy:

```caddyfile
code.example.com {
	respond /health* 404
	reverse_proxy 127.0.0.1:3000 {
		flush_interval -1
	}
}
```

`/health` is unauthenticated and reports diagnostics, so keep it off the internet. OpenChamber runs in [enterprise mode](https://docs.openchamber.dev/security/#enterprise-mode), which disables the relay and untrusted extensions. [Resource Monitor](https://github.com/openchamber/openchamber-resource-monitor) is allowed in `/etc/openchamber/policy.json`; install it once from Settings, Extensions with that URL. Login is rate limited; add a passkey under Settings after first sign-in.

The container runs as UID 1000 with dropped capabilities and resource limits. Login grants code execution and access to stored credentials; this is a trusted-user service, not a multi-tenant sandbox.

## Development

The image includes Go, TypeScript, pnpm, go-task, golangci-lint, and shell tools. See [`Dockerfile`](Dockerfile) for pinned versions. Additional Go tools and pnpm global installs persist under `/data/go` and `/data/.local/share/pnpm`.

With the Node.js and pnpm versions pinned in `Dockerfile` and `package.json`:

```sh
pnpm install --frozen-lockfile --ignore-scripts --no-optional
pnpm test
docker build -t opencode-server .
bash scripts/smoke-test.sh opencode-server
```

Smoke tests require Docker, Bash, Node.js, curl, jq, OpenSSL, and `timeout`. They exercise the real server, authentication, plugins, permissions, MCP connections, and quota commands without model inference. CI runs both architectures before publishing `main` with provenance attestations.
