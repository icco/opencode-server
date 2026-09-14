#!/bin/sh
set -eu
umask 077

if [ -n "${OPENCODE_SERVER_PASSWORD_FILE:-}" ]; then
  if [ -n "${OPENCODE_SERVER_PASSWORD:-}" ]; then
    echo "Set only one of OPENCODE_SERVER_PASSWORD or OPENCODE_SERVER_PASSWORD_FILE" >&2
    exit 1
  fi
  OPENCODE_SERVER_PASSWORD=$(cat "$OPENCODE_SERVER_PASSWORD_FILE")
  export OPENCODE_SERVER_PASSWORD
fi

if [ -n "${GOOGLE_GENERATIVE_AI_API_KEY_FILE:-}" ]; then
  if [ -n "${GOOGLE_GENERATIVE_AI_API_KEY:-}" ]; then
    echo "Set only one of GOOGLE_GENERATIVE_AI_API_KEY or GOOGLE_GENERATIVE_AI_API_KEY_FILE" >&2
    exit 1
  fi
  GOOGLE_GENERATIVE_AI_API_KEY=$(cat "$GOOGLE_GENERATIVE_AI_API_KEY_FILE")
  if [ -z "$GOOGLE_GENERATIVE_AI_API_KEY" ]; then
    echo "GOOGLE_GENERATIVE_AI_API_KEY_FILE must contain an API key" >&2
    exit 1
  fi
  export GOOGLE_GENERATIVE_AI_API_KEY
fi

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
