#!/usr/bin/env bash
set -euo pipefail

image=${1:?Usage: smoke-test.sh IMAGE}
name="opencode-test-$$"
password=$(openssl rand -hex 24)
secret_dir=$(mktemp -d)
trap 'docker logs "$name" 2>/dev/null || true; docker rm -f "$name" >/dev/null 2>&1 || true; rm -rf "$secret_dir"' EXIT
printf '%s' "$password" > "$secret_dir/password"
# The host directory is private; the container sees only the mounted file.
chmod 644 "$secret_dir/password"

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
  -e OPENCODE_SERVER_PASSWORD_FILE=/run/secrets/opencode_password \
  --mount "type=bind,src=$secret_dir/password,dst=/run/secrets/opencode_password,readonly" \
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
# The credential is loaded inside the process, not stored in Docker's environment config.
docker inspect "$name" | jq -e '.[0].Config.Env | all(startswith("OPENCODE_SERVER_PASSWORD=") | not)'
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
