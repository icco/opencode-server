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

For automated hosting, inject `OPENCODE_SERVER_PASSWORD` and
`GOOGLE_GENERATIVE_AI_API_KEY` through the container environment.

For [WakaTime](https://github.com/angristan/opencode-wakatime), create
`/data/.wakatime.cfg` owned by `1000:1000`, mode `600`:

```ini
[settings]
api_key = <your key from https://wakatime.com/api-key>
```

## Specialist routing and quota

[`Orchestra`](https://github.com/Oeronteros/opencode-orchestra) runs quality-first
specialist workflows. Use `/orchestra <task>` or the default **orch-lead** agent;
choose **Build** or **Plan** for the normal single-agent workflow.

[`orchestra.jsonc`](orchestra.jsonc) assigns GPT-6 Astra to the lead/tests/merge,
Sonnet 5 to repository exploration, Gemini to docs/research, and Opus 5.5 to
review/security/judging. Subagents have ordered fallback chains; the lead uses
OpenCode's native request path. Two workers run concurrently, with eight total.

**Quota reporting is separate from routing.**
The V2 [`Cardinal quota fork`](https://github.com/cardin/opencode-quota) provides `/quota` and
`/quota_status`; remaining balances do not influence selection. Proactive
quota-threshold routing still needs upstream integration. Gemini Code Assist
quota requires [organization setup](https://github.com/slkiser/opencode-quota/blob/main/docs/readme/providers.md#gemini-cli).

The server seeds `/data/.config/opencode/orchestra.jsonc` once and preserves it.
Project `.opencode/orchestra.jsonc` overrides it. Restart after edits. Agent prompts
and default model assignments are generated from upstream during the image build;
override an agent's model in `opencode.json` when changing its default selection.

### Upgrading from V1

Back up `/data` before first V2 startup; V2 migrates legacy data. The old per-turn
router is replaced by specialist delegation, and its policy file is no longer used.
Select **orch-lead** and a real model in existing sessions. V2 fixes the login name
to `opencode`, uses `/api/*` endpoints, and has a new plugin/config API. Migrate
custom config mounts and plugins using the [V2 docs](https://opencode.ai/v2/docs).

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

The integration check needs OpenCode V2; it uses isolated data on port 4197
(`ROUTER_TEST_PORT` overrides) and requests no inference. Image smoke tests need
Docker, Bash, curl, jq, OpenSSL, and `timeout`.
