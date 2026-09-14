#!/bin/sh
set -eu

# Check the agent with the same credentials used by browser/API clients.
exec curl --fail --silent --show-error --max-time 4 \
  --user "${OPENCODE_SERVER_USERNAME:-opencode}:${OPENCODE_SERVER_PASSWORD:?}" \
  http://127.0.0.1:4096/global/health
