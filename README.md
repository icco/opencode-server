# OpenCode Server

Self-hosted [OpenCode](https://opencode.ai) web UI and API with Gemini, GitHub
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

Connect both providers, then restart. The default model is **Auto Router (quality-first)**:

```sh
docker compose exec opencode opencode auth login
docker compose restart opencode
```

- **Copilot:** choose GitHub Copilot and complete device login. Requires a subscription.
- **Gemini:** choose Google → **Manually enter API Key**. Organization-backed Code
  Assist can use OAuth: open the login URL and paste the full localhost redirect
  URL into the prompt. Set `OPENCODE_GEMINI_PROJECT_ID` in the container environment.
  Consumer OAuth is discontinued; see the [Gemini plugin docs](https://github.com/jenslys/opencode-gemini-auth).

For automated hosting, inject `OPENCODE_SERVER_PASSWORD` and
`GOOGLE_GENERATIVE_AI_API_KEY` through the container environment.

For [WakaTime](https://github.com/angristan/opencode-wakatime), create
`/data/.wakatime.cfg` owned by `1000:1000`, mode `600`:

```ini
[settings]
api_key = <your key from https://wakatime.com/api-key>
```

## Automatic model routing

[`opencode-auto-router`](https://github.com/leecoder/opencode-auto-router) selects
a model by prompt complexity without an LLM call. Choose **Auto Router
(quality-first)** in Build or Plan; choose a real model to bypass routing.
Existing sessions may need to select it explicitly. API clients must send
`model: { providerID: "auto-router", modelID: "quality" }` on each routed turn.

The editable preferences in [`opencode-auto-router.json`](opencode-auto-router.json):

| Tier | First preference | Ordered fallbacks |
| --- | --- | --- |
| SIMPLE | Gemini 3.8 Flash | GPT-5.4 Mini, Claude Sonnet 5 |
| MEDIUM | GPT-6 Astra | Claude Sonnet 5, Gemini 3.1 Pro Preview |
| COMPLEX / REASONING | Claude Opus 5.5 | GPT-6 Astra, Gemini 3.1 Pro Preview |

Model failures, including quota errors, advance the chain **on the next retry in
the same session and tier**. Success resets it; exhausting it returns to the
primary. Auth/context errors do not advance it. Configure models your accounts
can use: the router does not pre-check availability or context compatibility.
Internal title/summary and compaction requests use fixed Copilot models.

**Quota reporting is separate from routing.**
[`OpenCode Quota`](https://github.com/slkiser/opencode-quota) provides `/quota` and
`/quota_status`; remaining balances do not influence selection. Proactive
quota-threshold routing still needs upstream integration. Gemini Code Assist
quota requires [organization setup](https://github.com/slkiser/opencode-quota/blob/main/docs/readme/providers.md#gemini-cli).

The server seeds its policy at `/data/.config/opencode/opencode-auto-router.json`
once. Edit or bind-mount that file; existing JSON/JSONC policies survive updates.
Working-directory policies take precedence (the server's directory, not each API
request's directory). Restart after edits: `docker compose restart opencode`.

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

- Includes Go, TypeScript, pnpm 12.6.0, and common shell tools; see [`Dockerfile`](Dockerfile).
  Go tools and pnpm global installs persist under `/data/go` and `/data/.local/share/pnpm`.
- Defaults live in [`opencode.json`](opencode.json), loaded at
  `/etc/opencode/opencode.json`. Mount a replacement there read-only to customize.
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

The integration check needs OpenCode and connected providers; it uses port 4197
(`ROUTER_TEST_PORT` overrides) and requests no inference. Image smoke tests need
Docker, Bash, curl, jq, OpenSSL, and `timeout`.
