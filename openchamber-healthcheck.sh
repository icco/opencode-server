#!/bin/sh
set -eu

# Healthy only when OpenChamber reaches OpenCode with its password.
curl --fail --silent --show-error --max-time 4 http://127.0.0.1:3000/health |
  jq -e '.isOpenCodeReady == true and .openCodeSecureConnection == true' >/dev/null
