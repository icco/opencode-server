#!/bin/sh
set -eu

# Exercise the gateway and backend, with file-secret support and no password in argv.
exec node /usr/local/lib/opencode-server/healthcheck.mjs
