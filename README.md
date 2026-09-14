# OpenCode Server

A reusable, non-root container for [OpenCode](https://opencode.ai)'s web UI and
API, with Google Gemini, GitHub Copilot, and WakaTime support.

Image: `ghcr.io/icco/opencode-server:main` (Linux amd64).

Includes Node.js 22/npm, Python 3, git/SSH, ripgrep, and C/C++ build tools.
OpenCode runs as UID/GID 1000 with `tini` reaping child processes. The image
requires a server password and stores all runtime state under `/data`.

## Quick start

```sh
cp .env.example .env
chmod 600 .env
$EDITOR .env
docker compose up -d
```

Set a unique random `OPENCODE_SERVER_PASSWORD` in `.env` (at least 32 characters;
generate one with `openssl rand -hex 32`). Open <http://localhost:4096>
and log in with username `opencode` and your password. Add `/data/workspace` as
a project, or clone repositories into its subdirectories and add those.

The example uses a named volume for sessions, workspaces, provider tokens,
configuration, and caches. For a host bind mount, create the directory owned by
UID/GID 1000 before starting the container:

```sh
sudo install -d -o 1000 -g 1000 -m 700 /srv/opencode
```

Mount that directory at `/data`. Back it up to preserve your work and logins.
Credentials belong in runtime environment variables or the data volume. The
Docker build context is allowlisted to exclude local credentials and data.

## Reverse proxy

The bundled Compose example binds port 4096 to host loopback. A host Caddy can
terminate TLS using:

```caddyfile
code.example.com {
    header {
        Strict-Transport-Security "max-age=31536000"
        X-Content-Type-Options nosniff
        Referrer-Policy no-referrer
    }
    reverse_proxy 127.0.0.1:4096 {
        flush_interval -1
    }
}
```

For Caddy running in Docker, join its network, remove the `ports` mapping,
and proxy to `opencode:4096`. With `caddy-docker-proxy`, add:

```yaml
labels:
  caddy: code.example.com
  caddy.reverse_proxy: '{{upstreams 4096}}'
  caddy.reverse_proxy.flush_interval: -1
```

Point your domain at the proxy host. Caddy handles HTTPS and WebSockets;
OpenCode validates HTTP basic authentication for browser and API requests.
The internal health check authenticates against `/global/health`.

## Public internet deployment

- Use HTTPS and a unique random server password, such as the output of
  `openssl rand -hex 32`. Keep `.env` mode 600. Anonymous UI/API requests are
  rejected; this is a single-user service whose login grants code execution
  and access to everything stored in its data volume.
- Keep port 4096 bound to loopback behind a host proxy. For a container proxy,
  publish no application ports and use a dedicated network containing only
  OpenCode and the proxy. Avoid a shared application network.
- Keep the supplied capability drop, `no-new-privileges`, and process/memory/CPU
  limits. Mount only the service's data. Do not mount a Docker socket, host SSH
  credentials, or unrelated host directories.
- Container networks do not block outbound access to the host/LAN. For untrusted
  users, use a separate VM and outbound firewall policy; this container is not a
  multi-tenant sandbox. The agent requires network access to model providers,
  package registries, and repositories.
- Rotate credentials by updating the environment and recreating the container.
  Update the pinned OpenCode/plugin versions regularly. Never enable Caddy's
  `log_credentials`; request authorization headers should remain redacted.

## Providers

Run this for each provider, then select a model in the web UI:

```sh
docker compose exec opencode opencode auth login
```

- **GitHub Copilot:** select GitHub Copilot and GitHub.com, open the device-login
  URL in your browser, and enter the displayed code. Requires a Copilot
  subscription. Git authentication for private repositories is configured
  separately.
- **Google Gemini API key:** select Google → **Manually enter API Key**.
  Alternatively, pass `GOOGLE_GENERATIVE_AI_API_KEY` into the container.
- **Google Gemini OAuth:** select Google → **OAuth with Google (Gemini CLI)**.
  The image sets `OPENCODE_HEADLESS=1`: open the supplied URL in your browser,
  then paste the full localhost redirect URL into the prompt, even if the
  browser displays a connection error. No callback port is needed. Pass
  `OPENCODE_GEMINI_PROJECT_ID` for organization-backed Code Assist subscriptions.

The [Gemini plugin](https://github.com/jenslys/opencode-gemini-auth) reports
consumer Code Assist OAuth ended June 18, 2026, including Google AI Pro/Ultra.
Use an API key for those accounts; Standard/Enterprise can use organization
OAuth. The plugin also provides `/gquota`.

Credentials persist in `/data/.local/share/opencode/auth.json`. After login,
restart OpenCode to reload credentials:

```sh
docker compose restart opencode
docker compose exec opencode opencode auth list
```

## WakaTime

The [WakaTime plugin](https://github.com/angristan/opencode-wakatime) installs
`wakatime-cli` automatically. Create `/data/.wakatime.cfg` in the volume, owned
by UID/GID 1000 with mode 600:

```ini
[settings]
api_key = <your WakaTime API key>
```

Get your key at <https://wakatime.com/api-key>. Logs and CLI state are stored in
`/data/.wakatime`. Add `debug = true` to the settings section to troubleshoot
heartbeats in `/data/.wakatime/opencode.log`.

## Configuration and upgrades

The image loads `/etc/opencode/opencode.json` via `OPENCODE_CONFIG`. It enables
Google and GitHub Copilot and pins both plugins. To use a different configuration,
mount your own file there read-only or change `OPENCODE_CONFIG` to its path.
OpenCode also loads global and project configuration using its normal merge rules.

Quit/restart OpenCode after configuration changes; existing sessions retain
their startup configuration. Recreate the container after environment changes:

```sh
docker compose up -d --force-recreate opencode
```

OpenCode is pinned in `Dockerfile`, and plugins in `opencode.json`. Change those
versions to upgrade. The GitHub Actions workflow builds and smoke-tests every PR
and publishes the `main` image after a successful main-branch build. Forks publish
under their own repository name. GHCR package visibility is separate from
repository visibility; set the package public for anonymous pulls.

Build and test locally (Docker, curl, jq, OpenSSL, and `timeout` required):

```sh
docker build -t opencode-server .
sh scripts/smoke-test.sh opencode-server
```

Inspired by the [OpenCode Railway template](https://railway.com/deploy/opencode-ai).
