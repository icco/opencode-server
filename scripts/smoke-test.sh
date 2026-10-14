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
timeout 15 docker run --rm -v /data "$image" || status=$?
test "$status" = 1
status=0
timeout 15 docker run --rm -v /data -e OPENCODE_PASSWORD=short "$image" || status=$?
test "$status" = 1
# Startup must also fail without a volume at /data.
status=0
timeout 15 docker run --rm -e "OPENCODE_PASSWORD=$password" "$image" || status=$?
test "$status" = 1

volume="opencode-test-data-$$"
start_opencode() {
  docker run -d --name "$name" \
    --cap-drop ALL --security-opt no-new-privileges:true \
    --pids-limit 2048 --memory 4g --cpus 2 \
    -p 127.0.0.1::4096 \
    -v "$volume:/data" \
    -e "OPENCODE_PASSWORD=$password" \
    -e LUNCHMONEY_API_TOKEN=catalog-test-only \
    -e KARAKEEP_API_ADDR=http://127.0.0.1:1 \
    -e KARAKEEP_API_KEY=catalog-test-only \
    "$image"
  url="http://127.0.0.1:$(docker port "$name" 4096/tcp | cut -d: -f2)"
  for attempt in $(seq 1 60); do
    if docker exec "$name" /usr/local/bin/healthcheck.sh; then
      break
    fi
    printf 'Waiting for OpenCode (%s/60)\n' "$attempt"
    sleep 3
  done
  docker exec "$name" /usr/local/bin/healthcheck.sh
}
cleanup() {
  docker logs "$name" || true
  docker exec "$name" sh -c 'for log in "$XDG_DATA_HOME"/opencode/log/*.log; do [ ! -f "$log" ] || cat "$log"; done' || true
  docker rm -f "$name" || true
  docker volume rm "$volume" || true
}
trap cleanup EXIT
start_opencode

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

# Credentials and workspaces must be writable by the non-root runtime user.
docker exec "$name" sh -c 'test "$(id -u)" = 1000 && test -w /data/workspace && test -w /data/.local/share/opencode'

# Re-entering startup must restore the image's instructions over a stale copy.
docker exec "$name" sh -ec '
  printf "\nStale instructions\n" >> "$XDG_CONFIG_HOME/opencode/AGENTS.md"
  /usr/local/bin/entrypoint.sh true
  cmp /etc/opencode/AGENTS.md "$XDG_CONFIG_HOME/opencode/AGENTS.md"
'

# Sessions, logs, config, and state must survive recreating the container on the same volume.
location='location%5Bdirectory%5D=/data/workspace'
session=$(curl --fail -s --user "opencode:$password" -H 'Content-Type: application/json' \
  -d '{"title":"Persistence check","agent":"build","location":{"directory":"/data/workspace"}}' \
  "$url/api/session?$location" | jq -er '.data.id')
docker exec "$name" sh -ec 'touch "$XDG_CONFIG_HOME/gh/persist-check" "$XDG_STATE_HOME/opencode/persist-check"'
docker rm -f "$name"
start_opencode
curl --fail -s --user "opencode:$password" "$url/api/session/$session?$location" |
  jq -e --arg id "$session" '.data.id == $id' >/dev/null
docker exec "$name" sh -ec '
  test -f "$XDG_CONFIG_HOME/gh/persist-check"
  test -f "$XDG_STATE_HOME/opencode/persist-check"
  starts=$(grep "message=\"cli starting\"" "$XDG_DATA_HOME/opencode/log/opencode.log" | grep -c -e --hostname)
  test "$starts" -ge 2
'

# OpenChamber must refuse to start without a strong UI password.
for ui in "" short " a                                    "; do
  status=0
  timeout 15 docker run --rm -v /data -e "OPENCODE_PASSWORD=$password" -e "OPENCHAMBER_UI_PASSWORD=$ui" \
    "$image" openchamber serve --foreground || status=$?
  test "$status" = 1
done

network="opencode-test-net-$$"
chamber="openchamber-test-$$"
ui_password=$(openssl rand -hex 24)
docker network create "$network"
docker network connect --alias opencode "$network" "$name"
docker run -d --name "$chamber" --network "$network" \
  --cap-drop ALL --security-opt no-new-privileges:true \
  -p 127.0.0.1::3000 \
  -v "$volume:/data" \
  -e OPENCODE_HOST=http://opencode:4096 \
  -e OPENCODE_SKIP_START=true \
  -e "OPENCODE_PASSWORD=$password" \
  -e "OPENCODE_SERVER_PASSWORD=$password" \
  -e "OPENCHAMBER_UI_PASSWORD=$ui_password" \
  -e OPENCHAMBER_ENTERPRISE_MODE=1 \
  -e OPENCHAMBER_ALLOW_NETWORK_ACCESS=1 \
  "$image" openchamber serve --foreground --host 0.0.0.0 --port 3000
trap 'docker logs "$chamber" || true; docker rm -f "$chamber" || true; cleanup; docker network rm "$network" || true' EXIT
chamber_url="http://127.0.0.1:$(docker port "$chamber" 3000/tcp | cut -d: -f2)"

for attempt in $(seq 1 40); do
  if docker exec "$chamber" /usr/local/bin/openchamber-healthcheck.sh; then
    break
  fi
  printf 'Waiting for OpenChamber (%s/40)\n' "$attempt"
  sleep 3
done
docker exec "$chamber" /usr/local/bin/openchamber-healthcheck.sh
docker exec "$chamber" test -d /data/workspace/.chats

test "$(curl -s -o /dev/null -w '%{http_code}' "$chamber_url/api/session")" = 401
test "$(curl -s -o /dev/null -w '%{http_code}' -H 'Content-Type: application/json' \
  -d '{"password":"wrong-password"}' "$chamber_url/auth/session")" = 401
jar=$(mktemp)
curl --fail -s -c "$jar" -H 'Content-Type: application/json' \
  -d "{\"password\":\"$ui_password\"}" "$chamber_url/auth/session" >/dev/null
curl --fail -s -b "$jar" "$chamber_url/api/session" | jq -e 'type == "array" or type == "object"' >/dev/null
rm -f "$jar"
