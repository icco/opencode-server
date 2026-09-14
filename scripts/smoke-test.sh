#!/bin/sh
set -eu

image=${1:?Usage: smoke-test.sh IMAGE}
name="opencode-test-$$"
password=$(openssl rand -hex 24)

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
