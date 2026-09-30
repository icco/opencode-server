# OpenCode Server

Self-hosted [OpenCode V2](https://opencode.ai/v2/docs) with a bundled Caddy gateway,
Gemini, GitHub Copilot, Orchestra, quota reporting, and WakaTime.

**Image:** `ghcr.io/icco/opencode-server:main` · amd64 / arm64

## Run locally

```sh
cp .env.example .env
chmod 600 .env
$EDITOR .env
docker compose up -d
```

Set `OPENCODE_SERVER_PASSWORD` to a random password of at least 32 characters
(`openssl rand -hex 32`). Open <http://localhost:4096>; the username is `opencode`.

The supplied Compose file mounts `${HOME}/.ssh` read-only. Create it before
startup and populate `known_hosts`, or remove the mount if you only use HTTPS Git.

`/data` persists workspaces, sessions, credentials, and caches. Keep it backed up;
bind mounts must be accessible to UID/GID 1000. Repositories belong in `/data/workspace`.

## Host behind HTTPS

Set these variables in the OpenCode service's environment:

```dotenv
OPENCODE_PUBLIC_URL=https://code.example.com
OPENCODE_TRUSTED_PROXIES=172.20.0.2/32
```

Replace the example IP with your TLS proxy's actual, stable source address.
Multiple IPs/CIDRs can be comma-separated; trust only the proxy, not its entire
shared network. Configure these **before updating an existing public deployment**;
the localhost default rejects other hostnames.

For Caddy running on the host:

```caddyfile
code.example.com {
    reverse_proxy 127.0.0.1:4096 {
        flush_interval -1
    }
}
```

For a container proxy, join its Docker network, remove the Compose `ports`
mapping, and proxy to `opencode:4096`. The proxy must preserve Host and send
`X-Forwarded-Proto: https` and `X-Forwarded-For`.

Bundled Caddy handles origin checks, failed-login limits, security headers, and
redacted logs. OpenCode authenticates requests on container loopback port 4097.
Keep the image's default command and expose only port 4096.

Disable or redact credential-bearing URLs in the **outer proxy's** access and
error logs too; the image cannot alter those logs. Rotate any credentials
previously committed to Git. Login grants access to mounted code and credentials,
so use a dedicated GitHub SSH key and a repository-scoped token.

## Credentials and providers

Secrets can come from environment variables or mounted files. Supported file
variables are `OPENCODE_SERVER_PASSWORD_FILE`, `GOOGLE_GENERATIVE_AI_API_KEY_FILE`,
`GH_TOKEN_FILE`, and `GITHUB_TOKEN_FILE`. Mount files read-only outside the workspace,
make them readable by UID 1000, and set either the direct value or `_FILE`, not both.
Recreate the container after changing credentials.

- **Copilot:** connect through the web UI using GitHub's device login.
- **Gemini:** connect Google with an API key, or supply `GOOGLE_GENERATIVE_AI_API_KEY`
  in the service environment. See the [plugin docs](https://github.com/jenslys/opencode-gemini-auth)
  for organization-backed OAuth.
- **GitHub CLI:** set `GH_TOKEN` in `.env`, or sign in once; credentials persist in `/data`:

  ```sh
  docker compose exec opencode gh auth login --hostname github.com --git-protocol https --web
  ```

- **WakaTime:** create `/data/.wakatime.cfg`, owned by UID 1000 with mode `600`:

  ```ini
  [settings]
  api_key = <your WakaTime API key>
  ```

## Configure and operate

- [`opencode.json`](opencode.json) contains the server defaults, plugins, and agents.
  Mount a replacement at `/etc/opencode/opencode.json` to customize them.
- [`orchestra.jsonc`](orchestra.jsonc) seeds `/data/.config/opencode/orchestra.jsonc`
  on first startup. Edit the persisted copy for routing changes; project
  `.opencode/orchestra.jsonc` takes precedence. Use `/orchestra`, `/quota`, and `/quota_status`.
- Caddy and OpenCode are supervised together; either process exiting stops the
  container. Health checks go through the gateway.

Update the image or apply environment changes:

```sh
docker compose up -d --pull always --force-recreate opencode
docker compose logs --tail 100 opencode
```

Native application diagnostics are in `/data/.local/state/opencode-web/server.log`
(private, rotated at 4 MiB). They may contain sensitive data.

| Response | Check |
| --- | --- |
| 401 | OpenCode credentials; password rotation invalidates existing sessions. |
| 403 | Origin, trusted proxy address, and `X-Forwarded-Proto`. |
| 421 | Host must match `OPENCODE_PUBLIC_URL`. |
| 429 | That client IP reached 20 authentication failures in ten minutes; respect `Retry-After`. |

## Development

Requires Node, pnpm, Go, and OpenCode V2. Image smoke tests also require Docker.

```sh
pnpm install --frozen-lockfile --ignore-scripts --no-optional
pnpm test
(cd gateway && go test -race ./... && go build -o /tmp/opencode-caddy .)
CADDY_BIN=/tmp/opencode-caddy node --test --test-timeout=30000 tests/web/*.test.mjs
node scripts/test-router-integration.mjs
docker build -t opencode-server .
bash scripts/smoke-test.sh opencode-server
```

CI tests both architectures and publishes `main` with provenance attestations.
