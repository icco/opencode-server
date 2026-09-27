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

Run for each provider, then restart. New sessions default to the **auto** agent:

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

The default **auto** agent uses a local plugin to select a model before each user
turn. Existing sessions can opt in by selecting **auto** in the agent picker.
Choose **build** or **plan** to use OpenCode's normal manual model selection.
The model picker is overridden while using **auto**; the assistant message records
the actual model used, and OpenCode logs the routing rule, model, and quota fraction.

Edit [`model-routing.json`](model-routing.json) to change the ordered preferences:

| Task | First preference | Fallbacks |
| --- | --- | --- |
| Design, debugging, security, reviews, migrations | Copilot Claude Opus 5.5 | GPT-6 Astra, Opus 5, Gemini Pro, general list |
| Short standalone summaries, explanations, typo fixes, renames | Gemini 3.8 Flash | Claude Sonnet 5, GPT-5.4 Mini, general list |
| General implementation and other work | Copilot GPT-6 Astra | Opus 5.5, Sonnet 5, Gemini Pro, Gemini Flash |

These are editable preferences, not a benchmark-based quality assessment. Rules
are case-insensitive regular expressions, evaluated in order. Follow-up prompts
include the previous user prompt for classification; the simple-work rule applies
only to the first turn. Routing itself makes no LLM calls. New model releases must
be added to the lists explicitly.

The router filters against connected providers, their current model catalogs,
tool support, attachment modalities, and an estimated context budget. Candidates
are ranked in three tiers: known quota above the reserve, unknown quota, then low
but nonzero quota. Quality order is preserved within each tier. The default reserve
is 10%; depleted or cooling-down candidates are skipped. If no candidate qualifies,
Auto returns an error explaining how to proceed.

### Quota sources and limitations

- **Copilot:** best-effort lookup of GitHub's internal subscription quota endpoint
  using the existing Copilot login. Premium/chat buckets are treated conservatively
  as provider-wide limits; this does not infer per-model request multipliers or
  paid overage. Enterprise quota is unknown.
- **Gemini Code Assist OAuth:** model-specific `retrieveUserQuota` buckets using
  the existing unexpired access token and project ID. Set
  `OPENCODE_GEMINI_PROJECT_ID` or use a project recorded by the Gemini auth plugin.
  Token refresh remains the auth plugin's responsibility; an expired token means
  quota is temporarily unknown.
- **Gemini API keys**, missing buckets, failed lookups, and unsupported response
  formats produce **unknown**, never an invented remaining balance. Some accounts
  return no buckets. Unknown quota is allowed by default; set `unknownQuota` to
  `"deny"` for strict routing using only reported balances.
- Lookups are cached for 60 seconds per OpenCode workspace instance, with a
  five-second timeout. They are advisory: concurrent usage can consume quota
  between lookup and inference.
- HTTP 402, 429, and 503 errors put the affected model on a five-minute cooldown,
  extended by `Retry-After` when present. Send another prompt (for example,
  “continue”) to select a fallback. The plugin does not switch mid-turn or replay
  tool actions. Cooldowns are in memory and reset on restart.
- Internal title/compaction requests and other agents retain OpenCode's normal
  model handling. This is turn-level routing for the agents listed in the policy.

To override the policy in a deployed container, add a read-only bind mount:

```yaml
services:
  opencode:
    volumes:
      - ./model-routing.json:/etc/opencode/model-routing.json:ro
```

Build/deploy the updated image to install the plugin. Quit and restart OpenCode
after configuration or policy changes (`docker compose restart opencode` for this
server). A Compose mount change requires `docker compose up -d --force-recreate opencode`.

Run the policy and hook tests without provider requests:

```sh
node --test tests/*.test.mjs
```

For a local integration check with OpenCode installed and providers connected:

```sh
node scripts/test-router-integration.mjs
```

This starts a separate loopback server on port 4197 (`ROUTER_TEST_PORT` overrides
it), checks routing with `noReply` messages, and deletes its test session. It can
query model catalogs and quota but requests no inference.

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
- Script and shell tools include:
  - Search/navigation: `ag`, `rg`, `fd` (also available as `fdfind`), `fzf`, `tree`,
    and `zoxide`.
  - Data/text processing: `jq`, Mike Farah's `yq` v4 (`eval-all`/`ireduce`
    compatible), `sponge` (from `moreutils`), and `envsubst`.
  - Files/transfers: `file`, `rsync`, `wget`, `zip`, `unzip`, and `xz`.
  - Shell/development: `zsh`, Bash completion, `shellcheck`, `git-lfs`, `less`,
    `tmux`, `vim`, `openssl`, and procps tools (`ps`, `pgrep`, `watch`).
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
