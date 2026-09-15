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

The image includes `gh` and configures it as Git's HTTPS credential helper.
Authenticate once using device login:

```sh
docker compose exec opencode gh auth login --hostname github.com --git-protocol https --web
docker compose exec opencode gh auth status
docker compose exec opencode gh api user --jq .login
```

GitHub CLI credentials live in `/data/.config/gh` and survive container updates.
This login is separate from the GitHub Copilot provider login below.

For automated hosting, set `GH_TOKEN` in the untracked `.env` file, then run
`docker compose up -d --force-recreate opencode`. The token takes precedence over
stored logins and needs access to the repositories and operations you intend to
use. Keep it out of the image and tracked configuration.

Compose also mounts the host's `${HOME}/.ssh` at `/data/.ssh` read-only for SSH
Git remotes. The host directory must exist, with keys readable by UID 1000 and
permissions accepted by OpenSSH. Add required host keys to the host's
`known_hosts` before use; the container cannot update the read-only mount.
SSH remotes use those keys; HTTPS remotes use the `gh` credential helper.

## Connect providers

Run for each provider, then restart and select a model in the UI:

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

- The image includes Go (`go`, `gofmt`) and TypeScript (`tsc`). Go-installed tools
  in `/data/go/bin` are on `PATH`; Go modules and build caches persist under `/data`.
- Defaults live in [`opencode.json`](opencode.json), loaded at
  `/etc/opencode/opencode.json`. Mount a replacement there read-only to customize.
- Restart OpenCode after config changes. After environment/password changes, run
  `docker compose up -d --force-recreate opencode`.
- Versions are pinned in `Dockerfile` and `opencode.json`. CI tests both
  architectures and publishes `main` with provenance attestations.

```sh
docker build -t opencode-server .
bash scripts/smoke-test.sh opencode-server
gh attestation verify oci://ghcr.io/icco/opencode-server:main --owner icco
```

Local smoke tests require Docker, Bash, curl, jq, OpenSSL, and `timeout`.
