# OpenCode Server

Self-hosted [OpenCode V2](https://opencode.ai/v2/docs/) web UI and API. The image `ghcr.io/icco/opencode-server:main` supports amd64 and arm64.

## Run

From this checkout, with Docker Compose and OpenSSL installed:

```sh
mkdir -p "$HOME/.ssh"
export OPENCODE_PASSWORD="$(openssl rand -hex 32)"
docker compose up -d
```

Open <http://localhost:4096> and sign in as `opencode` with that password. Keep the password in your deployment's secret store and export it for later Compose commands; startup requires at least 32 characters.

The `/data` volume preserves repositories, sessions, credentials, and caches. Keep repositories in `/data/workspace` and back up the volume. Bind mounts must be writable by UID/GID 1000. Compose also mounts the host's `~/.ssh` read-only; keys must be readable by UID 1000, and `known_hosts` must be maintained on the host.

To update the image or apply changed environment variables:

```sh
docker compose pull
docker compose up -d --force-recreate opencode
```

## Connect accounts

Connect providers in OpenCode or run:

```sh
docker compose exec opencode opencode auth login github-copilot --server http://127.0.0.1:4096
docker compose exec opencode opencode auth login google --server http://127.0.0.1:4096
```

- **GitHub Copilot:** complete device login with a subscribed account.
- **Gemini:** choose the API-key method or set `GOOGLE_GENERATIVE_AI_API_KEY`. Organization-backed Code Assist OAuth also needs `OPENCODE_GEMINI_PROJECT_ID`; see the [Gemini plugin's account requirements](https://github.com/jenslys/opencode-gemini-auth).
- **Git access:** set `GH_TOKEN` or run `docker compose exec opencode gh auth login --hostname github.com --git-protocol https --web`. This is separate from Copilot login; stored credentials persist in `/data/.config/gh`.
- **WakaTime:** put your API key in `/data/.wakatime.cfg`, owned by `1000:1000` with mode `600`, using the [plugin's configuration format](https://github.com/angristan/opencode-wakatime#prerequisites).

## MCP integrations

Set the variables below before creating the container. For remote servers, open `/mcps`, select the server, and sign in when prompted; OAuth credentials persist in `/data`.

| Integration | Setup |
| --- | --- |
| [Context7](https://mcp.context7.com/mcp) | Remote library documentation. |
| [Grafana](https://github.com/grafana/mcp-grafana) | `GRAFANA_URL` and `GRAFANA_SERVICE_ACCOUNT_TOKEN`; bundled tools are read-only. |
| [Karakeep](https://docs.karakeep.app/integrations/mcp) | `KARAKEEP_API_KEY` and `KARAKEEP_API_ADDR` (defaults to `https://hoard.natwelch.com`); includes write tools. |
| [Lunch Money](https://github.com/akutishevsky/lunchmoney-mcp) | `LUNCHMONEY_API_TOKEN` from [developer settings](https://my.lunchmoney.app/developers); required to start its MCP server. |
| [Notion](https://developers.notion.com/guides/mcp/overview) | Remote server at `https://mcp.notion.com/mcp`. |
| Robinhood | Remote trading server at `https://agent.robinhood.com/mcp/trading`. |

Check connections with:

```sh
docker compose exec opencode opencode api get /api/mcp --server http://127.0.0.1:4096
```

Grafana and Karakeep can connect before their credentials are validated; check a small read query too. Disable unused integrations with `disabled: true` in their `mcp.servers` entries; see [MCP configuration](https://opencode.ai/v2/docs/mcp-servers).

## Agents and configuration

- **Build** is the default agent and can use all configured tools. **General** can implement and test; **Explore** is read-only. Both subagents may use Context7 but deny Grafana, Lunch Money, Karakeep, Notion, Robinhood, and further delegation. Tool permissions do not sandbox shell access.
- [Superpowers](https://github.com/obra/superpowers) supplies planning, debugging, testing, and review skills. The image also ships [`commit-push-pr` and `go-repo`](skills/). [`AGENTS.md`](AGENTS.md) requires repository edits in `/data/workspace/.worktrees/<repository>/<task>`.
- [OpenCode Quota](https://github.com/slkiser/opencode-quota) provides `/quota` and `/quota_status`.
- Defaults and pinned plugins live in [`opencode.jsonc`](opencode.jsonc). The image converts it to `/etc/opencode/opencode.json`; project `opencode.json(c)` files can override settings. See the [V2 configuration guide](https://opencode.ai/v2/docs/config).
- Each startup copies the image's [`AGENTS.md`](AGENTS.md) to `/data/.config/opencode/AGENTS.md`, replacing local edits. Change instructions in this repository and rebuild.

To replace the image defaults, install dependencies, edit `opencode.jsonc`, run `node scripts/build-config.mjs runtime.json`, and mount the output read-only at `/etc/opencode/opencode.json`. Restart the container after replacing it.

## Hosting

Compose binds only to `127.0.0.1:4096`. Put an HTTPS reverse proxy in front for remote access. A containerized proxy can share a network and use `opencode:4096` instead of the host port mapping.

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
