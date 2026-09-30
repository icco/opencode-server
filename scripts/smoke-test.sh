#!/usr/bin/env bash
set -euo pipefail

image=${1:?Usage: smoke-test.sh IMAGE}
name="opencode-test-$$"
password=$(openssl rand -hex 24)

# Exercise the actual packaged proxy and supervisor, without provider inference.
docker run --rm --entrypoint sh -v "$PWD:/tests:ro" "$image" -ec \
  'node --test --test-timeout=30000 /tests/tests/web/*.test.mjs'

# Check script dependencies as the non-root runtime user, without starting the server.
docker run --rm --entrypoint sh "$image" -ec '
  for tool in ag rg fd fdfind fzf tree zoxide jq yq sponge envsubst file rsync \
    wget zip unzip xz zsh shellcheck git-lfs less tmux vim openssl ps pgrep watch pnpm haproxy; do
    command -v "$tool"
  done
  test "$(pnpm --version)" = 12.6.0
  opencode --version
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
timeout 15 docker run --rm -e OPENCODE_SERVER_PASSWORD=short "$image" || status=$?
test "$status" = 1

secret_file=$(mktemp)
printf '%s\n' "$password" > "$secret_file"
# Disposable CI credential; runner UID differs from the image's UID 1000.
chmod 444 "$secret_file"
cleanup() {
  docker logs "$name" || true
  docker exec "$name" sh -c 'for log in "$XDG_DATA_HOME"/opencode/log/*.log; do [ ! -f "$log" ] || cat "$log"; done' || true
  docker rm -f "$name" || true
  rm -f "$secret_file"
}
trap cleanup EXIT
docker run -d --name "$name" \
  --cap-drop ALL --security-opt no-new-privileges:true \
  --pids-limit 512 --memory 4g --cpus 2 \
  -p 127.0.0.1::4096 \
  --mount "type=bind,source=$secret_file,target=/run/secrets/opencode_password,readonly" \
  -e OPENCODE_SERVER_PASSWORD_FILE=/run/secrets/opencode_password \
  "$image"
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
for path in /api/info /api/integration /api/session /api/config /openapi.json; do
  test "$(curl -s -H 'Host: localhost:4096' -o /dev/null -w '%{http_code}' "$url$path")" = 401
  test "$(curl -s -H 'Host: localhost:4096' -o /dev/null -w '%{http_code}' --user opencode:wrong-password "$url$path")" = 401
done
test "$(curl -s -H 'Host: localhost:4096' -H 'Origin: https://attacker.example' -o /dev/null -w '%{http_code}' "$url/api/info")" = 403
# Even from the container's network address, only the gateway is reachable.
ip=$(docker inspect --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$name")
test "$(docker exec "$name" curl -s -H 'Host: localhost:4096' -o /dev/null -w '%{http_code}' "http://$ip:4096/api/info")" = 401
if docker exec "$name" curl -s --max-time 2 "http://$ip:4097/api/info"; then
  echo 'Backend is exposed outside loopback' >&2
  exit 1
fi

docker exec "$name" sh -ec '
  cmp /etc/opencode/orchestra.jsonc "$XDG_CONFIG_HOME/opencode/orchestra.jsonc"
'
OPENCODE_TEST_URL="$url" OPENCODE_TEST_HOST=localhost:4096 OPENCODE_SERVER_PASSWORD="$password" \
  node scripts/test-router-integration.mjs

# Credentials and workspaces must be writable by the non-root runtime user.
docker exec "$name" sh -c 'test "$(id -u)" = 1000 && test -w /data/workspace && test -w /data/.local/share/opencode'

# Losing the real packaged gateway must also stop OpenCode/the container.
docker exec "$name" pkill -x haproxy || true
test "$(timeout 30 docker wait "$name")" = 1
