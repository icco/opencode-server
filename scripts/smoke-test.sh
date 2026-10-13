#!/usr/bin/env bash
set -euo pipefail

image=${1:?Usage: smoke-test.sh IMAGE}
name="opencode-test-$$"
password=$(openssl rand -hex 24)
expected_pnpm=$(node -p 'require("./package.json").packageManager.split("@")[1]')

# Check script dependencies as the non-root runtime user, without starting the server.
docker run --rm -e "EXPECTED_PNPM=$expected_pnpm" --entrypoint sh "$image" -ec '
  for tool in ag rg fd fdfind fzf tree zoxide jq yq sponge envsubst file rsync \
    wget zip unzip xz zsh shellcheck git-lfs less tmux vim openssl ps pgrep watch pnpm mcp-grafana \
    task golangci-lint; do
    command -v "$tool"
  done
  test "$(pnpm --version)" = "$EXPECTED_PNPM"
  opencode --version
  mcp-grafana --version
  task --version
  golangci-lint version
  tsc --version
  test -w "$(dirname "$PNPM_HOME")"
'

# Exercise the yq v4 merge syntax used by generate_mappings.sh, with sponge
# writing back to an input file from a zsh pipeline.
docker run --rm --entrypoint zsh "$image" -euc '
  set -o pipefail
  tmp=$(mktemp -d)
  trap '\''rm -rf "$tmp"'\'' EXIT
  printf "entries:\n  - guid: example\n    title: original\n" > "$tmp/base.yaml"
  printf "entries:\n  - guid: example\n    title: override\n" > "$tmp/local.yaml"
  yq eval-all '\''
    .entries[] as $entry ireduce ({}; .[$entry.guid // $entry.title] = $entry) |
    {"entries": (to_entries | map(.value) | sort_by(.title))} |
    ... comments=""
  '\'' "$tmp/base.yaml" "$tmp/local.yaml" | sponge "$tmp/base.yaml"
  yq -iP . "$tmp/base.yaml"
  yq -o=json . "$tmp/base.yaml" |
    jq -e '\''.entries == [{"guid": "example", "title": "override"}]'\''
'

# Startup must fail promptly when no password is provided.
status=0
timeout 15 docker run --rm "$image" || status=$?
test "$status" = 1
status=0
timeout 15 docker run --rm -e OPENCODE_PASSWORD=short "$image" || status=$?
test "$status" = 1

docker run -d --name "$name" \
  --cap-drop ALL --security-opt no-new-privileges:true \
  --pids-limit 512 --memory 4g --cpus 2 \
  -p 127.0.0.1::4096 \
  -e "OPENCODE_PASSWORD=$password" \
  -e LUNCHMONEY_API_TOKEN=catalog-test-only \
  -e KARAKEEP_API_ADDR=http://127.0.0.1:1 \
  -e KARAKEEP_API_KEY=catalog-test-only \
  "$image"
cleanup() {
  docker logs "$name"
  docker exec "$name" sh -c 'for log in "$XDG_DATA_HOME"/opencode/log/*.log; do [ ! -f "$log" ] || cat "$log"; done' || true
  docker rm -f "$name"
}
trap cleanup EXIT
port=$(docker port "$name" 4096/tcp | cut -d: -f2)
url="http://127.0.0.1:$port"

for attempt in $(seq 1 60); do
  if docker exec "$name" /usr/local/bin/healthcheck.sh; then
    break
  fi
  printf 'Waiting for OpenCode (%s/60)\n' "$attempt"
  sleep 3
done
docker exec "$name" /usr/local/bin/healthcheck.sh
for path in /api/info /api/integration; do
  test "$(curl -s -o /dev/null -w '%{http_code}' "$url$path")" = 401
  test "$(curl -s -o /dev/null -w '%{http_code}' --user opencode:wrong-password "$url$path")" = 401
done

docker exec "$name" sh -ec '
  test -d "$HOME/workspace/.worktrees"
  cmp /etc/opencode/AGENTS.md "$XDG_CONFIG_HOME/opencode/AGENTS.md"
  opencode api get /api/info --server http://127.0.0.1:4096
'
OPENCODE_TEST_URL="$url" OPENCODE_PASSWORD="$password" \
  node scripts/test-router-integration.mjs

curl --fail --silent --show-error --user "opencode:$password" \
  "$url/api/plugin?location%5Bdirectory%5D=/data/workspace" \
  | jq -e '.data[] | select(.id == "i-have-adhd") | .state.status == "active"'
curl --fail --silent --show-error --user "opencode:$password" \
  "$url/api/skill?location%5Bdirectory%5D=/data/workspace" \
  | jq -e '.data[] | select(.id == "i-have-adhd") | .content | contains("## Persistence") and contains("### 10.")'
curl --fail --silent --show-error --user "opencode:$password" \
  "$url/api/command?location%5Bdirectory%5D=/data/workspace" \
  | jq -e '.data[] | select(.name == "i-have-adhd")'

# Credentials and workspaces must be writable by the non-root runtime user.
docker exec "$name" sh -c 'test "$(id -u)" = 1000 && test -w /data/workspace && test -w /data/.local/share/opencode'

# Re-entering startup must restore the image's instructions over a stale copy.
docker exec "$name" sh -ec '
  printf "\nStale instructions\n" >> "$XDG_CONFIG_HOME/opencode/AGENTS.md"
  /usr/local/bin/entrypoint.sh true
  cmp /etc/opencode/AGENTS.md "$XDG_CONFIG_HOME/opencode/AGENTS.md"
'
