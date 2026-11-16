#!/bin/sh
set -eu

# Healthy only when OpenChamber reaches its managed OpenCode with the shared password.
curl --fail --silent --show-error --max-time 4 http://127.0.0.1:3000/health |
  jq -e '.isOpenCodeReady == true and .openCodeSecureConnection == true' >/dev/null
exec curl --fail --silent --show-error --max-time 4 --output /dev/null \
  --user "opencode:${OPENCODE_PASSWORD:?}" \
  "http://127.0.0.1:${OPENCHAMBER_OPENCODE_PORT:?}/api/info"
