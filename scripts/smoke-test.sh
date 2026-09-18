#!/usr/bin/env bash
set -euo pipefail

image=${1:?Usage: smoke-test.sh IMAGE}
name="opencode-test-$$"
password=$(openssl rand -hex 24)

# Check script dependencies as the non-root runtime user, without starting the server.
docker run --rm --entrypoint sh "$image" -ec '
  for tool in ag rg fd fdfind fzf tree zoxide jq yq sponge envsubst file rsync \
    wget zip unzip xz zsh shellcheck git-lfs less tmux vim openssl ps pgrep watch; do
    command -v "$tool"
  done
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

docker run -d --name "$name" \
  --cap-drop ALL --security-opt no-new-privileges:true \
  --pids-limit 512 --memory 4g --cpus 2 \
  -p 127.0.0.1::4096 \
  -e "OPENCODE_SERVER_PASSWORD=$password" \
  "$image"
trap 'docker logs "$name"; docker rm -f "$name"' EXIT
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
for path in / /provider/auth; do
  test "$(curl -s -o /dev/null -w '%{http_code}' "$url$path")" = 401
  test "$(curl -s -o /dev/null -w '%{http_code}' --user opencode:wrong-password "$url$path")" = 401
done

curl --fail --silent --show-error --max-time 120 \
  --user "opencode:$password" "$url/provider/auth" \
  | jq -e '.google | any(.label == "OAuth with Google (Gemini CLI)")'
curl --fail --silent --show-error --max-time 120 \
  --user "opencode:$password" "$url/provider/auth" \
  | jq -e '.["github-copilot"] | any(.type == "oauth")'
curl --fail --silent --show-error --max-time 120 \
  --user "opencode:$password" "$url/config" \
  | jq -e '.plugin | any(contains("opencode-wakatime"))'

# Credentials and workspaces must be writable by the non-root runtime user.
docker exec "$name" sh -c 'test "$(id -u)" = 1000 && test -w /data/workspace && test -w /data/.local/share/opencode'
