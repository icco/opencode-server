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

Port 4096 is the bundled HAProxy gateway. OpenCode listens on **127.0.0.1:4097
inside the container**, so neighboring containers cannot connect directly to the
backend. The default `web` command supervises both processes and stops the
container if either exits. Health checks exercise both through the gateway.

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

Set the public origin and the exact source address(es) of your TLS reverse proxy:

```dotenv
OPENCODE_PUBLIC_URL=https://code.example.com
OPENCODE_TRUSTED_PROXIES=172.20.0.2/32
```

Use the proxy's actual, stable address; the address above is an example. Do not
trust an entire shared Docker/LAN network. Update this value and recreate OpenCode
if the proxy's address changes. Multiple IPs/CIDRs can be comma-separated. The
gateway uses only the rightmost `X-Forwarded-For` address appended by that trusted
proxy; client-supplied forwarding headers from other peers are discarded.

HTTPS hosting requires trusted proxies to be configured. Non-loopback requests
must come from those peers with `X-Forwarded-Proto: https`. The configured Host
must match; a supplied Origin must exactly match the configured public origin.
CLI/API clients may omit Origin, but still need OpenCode credentials. HTTP is
allowed only for a configured loopback origin (the default local Compose setup).

With Caddy on the host, keep ordinary HTTPS reverse proxying:

```caddyfile
code.example.com {
    reverse_proxy 127.0.0.1:4096 {
        flush_interval -1
    }
}
```

For a container proxy, join its network, remove the Compose `ports` mapping,
and proxy to `opencode:4096`. Only the gateway is network-accessible; do not publish
4097 or override the image's default command with a direct `opencode serve` command.
`OPENCODE_WEB_PORT` and `OPENCODE_BACKEND_PORT` optionally override these two ports.

### Built-in protections

- Native OpenCode password/pairing authentication, preserved through the proxy.
- Foreign/null/duplicate Origin rejection, including terminal WebSocket upgrades.
- Clickjacking protection, nosniff, no-referrer, HSTS for HTTPS, and no-store for
  API/authentication/error responses. A second CSP adds framing/base/form limits
  without replacing OpenCode's script hashes or WebAssembly policy.
- Per-client throttling after 20 backend HTTP 401 responses in a rolling ten-minute
  window. The gateway responds 429 with `Retry-After: 600`; successful traffic and
  cross-origin 403s do not increment the counter. Clients sharing an IP share its
  bucket. Counters are bounded/in-memory and reset when the gateway restarts.
- Streaming and WebSocket support, with one-hour idle timeouts.
- Gateway logs contain only client IP, status and byte count. They omit request
  URLs/headers and response headers, including on errors. OpenCode's native
  stdout/stderr is written to a private, mode-600 diagnostic file at
  `$XDG_STATE_HOME/opencode-web/server.log` instead of Docker logs. It rotates at
  4 MiB or on restart, retaining one `server.log.previous`. Treat these diagnostics
  and OpenCode's own data-directory logs as sensitive.

No host Fail2Ban installation or special Caddy authentication rules are needed.
The outer proxy sees requests before the image: disable its access logging for
this virtual host or redact URLs/credentials there, including error logs. For the
existing mist deployment, remove the `caddy.log` label to disable its access log;
that alone does not redact Caddy's independently emitted error logs. Prefer native
password login and avoid password-bearing `auth_token` URLs. Terminal/pairing
tickets in URLs remain short-lived credentials and should not be retained in logs.

### Secret files

The entrypoint and health check accept these `_FILE` variables:

- `OPENCODE_SERVER_PASSWORD_FILE`
- `GOOGLE_GENERATIVE_AI_API_KEY_FILE`
- `GH_TOKEN_FILE` / `GITHUB_TOKEN_FILE`

Set either a direct value or its file variable, never both. Files must be readable
by UID 1000; use a read-only mount outside the workspace and keep host permissions
restrictive. A single trailing newline is accepted. Missing/invalid passwords stop
startup before any listener opens. Changing a file requires recreating the
container to update the running process.

For example, add this override to the supplied Compose configuration:

```yaml
services:
  opencode:
    environment:
      OPENCODE_SERVER_PASSWORD: ""
      OPENCODE_SERVER_PASSWORD_FILE: /run/secrets/opencode_password
    secrets:
      - opencode_password
secrets:
  opencode_password:
    file: /home/nat/creds/opencode-password
```

### Existing mist deployment

Before publishing/deploying this image to the automatically updated `main` tag:

1. Add `OPENCODE_PUBLIC_URL=https://opencode.natwelch.com` and the Caddy container's
   trusted source IP to the OpenCode service environment. The safe localhost
   default will reject the public hostname until this is configured.
2. Replace the previously committed server password and Gemini key with fresh
   values supplied through private environment configuration or mounted secret
   files. Revoke the old provider key; removing a value from Git does not revoke
   it. A fresh password invalidates OpenCode's native signed sessions.
3. Keep the existing `reverse_proxy` to port 4096 and streaming setting. Recreate
   OpenCode, then verify old credentials fail, current credentials work, and a
   browser prompt/stream/terminal works. No separate backend network is required
   to prevent access to the loopback-only server, although isolation still limits
   what authenticated agent code can reach.

The superseded multi-repository auth/hardening PRs are not required by this image.

The container runs non-root with dropped capabilities and resource limits.
Keep these controls. **Login grants code execution and
access to stored credentials.** Shared networks permit service-to-service access;
outbound host/LAN access is unrestricted. This is not a multi-tenant sandbox.
Use a GitHub-only SSH identity and repository-scoped token rather than general
host-login keys, and keep unrelated deployment secrets outside mounted workspaces.

## Configuration and development

- Includes Go, TypeScript, pnpm 12.6.0, and common shell tools; see [`Dockerfile`](Dockerfile).
  Go tools and pnpm global installs persist under `/data/go` and `/data/.local/share/pnpm`.
- Defaults live in [`opencode.json`](opencode.json), loaded at
  `/etc/opencode/opencode.json`. Mount a replacement there read-only to customize.
- Restart OpenCode after config changes. After environment/password changes, run
  `docker compose up -d --force-recreate opencode`.
- OpenCode/tool/plugin versions are pinned in `Dockerfile` and `opencode.json`;
  HAProxy receives the Debian base distribution's security updates during image
  builds. CI tests both
  architectures and publishes `main` with provenance attestations.

```sh
pnpm install --frozen-lockfile --ignore-scripts --no-optional
pnpm test
HAPROXY_BIN=/path/to/haproxy node --test --test-timeout=30000 tests/web/*.test.mjs
node scripts/test-router-integration.mjs
docker build -t opencode-server .
bash scripts/smoke-test.sh opencode-server
gh attestation verify oci://ghcr.io/icco/opencode-server:main --owner icco
```

The web tests require HAProxy 3.0+ and OpenCode V2 and use disposable data/ports.
They test the actual proxy, failure throttling, forwarded-header trust, WebSockets,
streaming, secret handling, process failure/shutdown, and a real native server
without inference. Docker smoke tests run them against the packaged HAProxy on
both architectures and test a real file-secret deployment.

The routing integration check needs OpenCode V2; it uses isolated data on port 4197
(`ROUTER_TEST_PORT` overrides) and requests no inference. Image smoke tests need
Docker, Bash, curl, jq, OpenSSL, and `timeout`.
