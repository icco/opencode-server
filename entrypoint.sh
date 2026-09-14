#!/bin/sh
set -eu
umask 077

if [ -z "${OPENCODE_SERVER_PASSWORD:-}" ]; then
  echo "OPENCODE_SERVER_PASSWORD must be set" >&2
  exit 1
fi

if [ "${#OPENCODE_SERVER_PASSWORD}" -lt 32 ]; then
  echo "OPENCODE_SERVER_PASSWORD must contain at least 32 characters; generate it with openssl rand -hex 32" >&2
  exit 1
fi

mkdir -p "$XDG_CONFIG_HOME/opencode" "$XDG_DATA_HOME/opencode" \
  "$XDG_STATE_HOME/opencode" "$XDG_CACHE_HOME/opencode" "$HOME/workspace"

exec "$@"
