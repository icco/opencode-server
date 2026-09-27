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

Routing uses the MIT-licensed upstream
[`opencode-auto-router@0.1.4`](https://github.com/leecoder/opencode-auto-router).
Select **Auto Router (quality-first)** (`auto-router/quality`) in the model picker
to enable it with either Build or Plan. Select a real model to bypass routing.
Existing sessions may retain their previous model selection. API clients should
send `model: { providerID: "auto-router", modelID: "quality" }` on each routed turn;
otherwise OpenCode may reuse the actual model saved on the previous message.

The local heuristic classifier scores each prompt and selects a tier without an
LLM call. [`opencode-auto-router.json`](opencode-auto-router.json) configures:

| Tier | First preference | Ordered fallbacks |
| --- | --- | --- |
| SIMPLE | Gemini 3.8 Flash | GPT-5.4 Mini, Claude Sonnet 5 |
| MEDIUM | GPT-6 Astra | Claude Sonnet 5, Gemini 3.1 Pro Preview |
| COMPLEX / REASONING | Claude Opus 5.5 | GPT-6 Astra, Gemini 3.1 Pro Preview |

These are quality-first preferences, not benchmark rankings. The upstream
classifier supports keyword, weight, and tier-boundary overrides. This deployment
uses its default heuristic; optional BERT and Apple classifiers are not enabled.
Short prompts can classify as SIMPLE even when the underlying job is substantial;
choose a real model explicitly when needed.

On a model-failure event (including quota/rate-limit API errors), the upstream
router advances to the next model **on the next retry in the same session and
tier**. It does not replay the current turn. Successful completion clears the
failure state; exhausting the chain returns to its primary. Auth, context-overflow,
output-length, and abort errors do not advance the chain. Model availability and
context/modality suitability are not proactively filtered: configure models your
accounts can use, and keep the tier models suitable for the workload.

Internal title/summary requests use `github-copilot/gpt-5.4-mini`; compaction uses
`github-copilot/gpt-6-astra`, avoiding requests to the virtual router provider.
These internal requests are not automatically routed or failed over.

### Quota reporting and the remaining integration gap

[`@slkiser/opencode-quota@4.10.5`](https://github.com/slkiser/opencode-quota)
(MIT) supplies `/quota` and `/quota_status` in the Web UI. The 4.x release line
supports OpenCode 1.x. Copilot usage is detected from the existing login;
organization-backed Gemini CLI quota requires the upstream
[provider setup](https://github.com/slkiser/opencode-quota/blob/main/docs/readme/providers.md#gemini-cli).
Gemini API-key access does not imply a readable Code Assist quota balance.

**Remaining balances do not drive routing in this setup.** The router reacts to
failures; the quota plugin reports usage independently. Proactive selection at a
quota threshold requires an upstream integration. OpenCode Quota provides
`show --json` and an optional export file as supported integration surfaces, but
neither is consumed by the router. Missing quota data is not a claim of unlimited
capacity. See the upstream [external integration guide](https://github.com/slkiser/opencode-quota/blob/main/docs/readme/external-integration.md).

### Configuration and deployment

On first startup the entrypoint copies the bundled router policy to
`/data/.config/opencode/opencode-auto-router.json`. Existing JSON or JSONC policies
are preserved across image updates. Edit that file, or mount a policy directly:

```yaml
services:
  opencode:
    volumes:
      - ./opencode-auto-router.json:/data/.config/opencode/opencode-auto-router.json:ro
```

Upstream also searches the server process working directory and its `.opencode/`
directory before the home config. It uses the process directory, not the directory
parameter of each API request. For this multi-workspace server, use the home policy
as the server-wide default. Quota settings can be placed in
`/data/.config/opencode/opencode-quota/quota-toast.json` using the upstream guide.

Build/deploy the updated image to install the plugins. Quit and restart OpenCode
after configuration or policy changes (`docker compose restart opencode` for this
server). A Compose mount change requires `docker compose up -d --force-recreate opencode`.

Run the configuration contract tests against the pinned upstream router:

```sh
pnpm install --frozen-lockfile --ignore-scripts --no-optional
pnpm test
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
- pnpm 10.34.5 is installed in the image and pinned in `package.json` for local
  development and CI. Runtime global installs use `/data/.local/share/pnpm`.
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
