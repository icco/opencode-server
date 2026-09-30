#!/bin/sh
set -eu
umask 077

exec node /usr/local/lib/opencode-server/start.mjs "$@"
