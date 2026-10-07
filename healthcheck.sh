#!/bin/sh
set -eu

# Check the agent with the same credentials used by browser/API clients.
exec curl --fail --silent --show-error --max-time 4 \
  --user "opencode:${OPENCODE_PASSWORD:?}" \
  http://127.0.0.1:4096/api/info
