#!/bin/sh
set -eu
umask 077

# Accept the old image variable for direct docker run users.
export OPENCODE_PASSWORD="${OPENCODE_PASSWORD:-${OPENCODE_SERVER_PASSWORD:-}}"
if [ -z "$OPENCODE_PASSWORD" ]; then
  echo "OPENCODE_PASSWORD must be set" >&2
  exit 1
fi

if [ "${#OPENCODE_PASSWORD}" -lt 32 ]; then
  echo "OPENCODE_PASSWORD must contain at least 32 characters; generate it with openssl rand -hex 32" >&2
  exit 1
fi

mkdir -p "$XDG_CONFIG_HOME/opencode" "$XDG_CONFIG_HOME/gh" "$XDG_DATA_HOME/opencode" \
  "$XDG_STATE_HOME/opencode" "$XDG_CACHE_HOME/opencode" "$HOME/workspace"

# OpenCode V2 fixes the HTTP username to opencode.
if [ "${OPENCODE_SERVER_USERNAME:-opencode}" != opencode ]; then
  echo "OpenCode V2 requires username opencode; remove OPENCODE_SERVER_USERNAME" >&2
  exit 1
fi

# V2 discovers global AGENTS.md; the legacy instructions config is ignored.
if [ ! -e "$XDG_CONFIG_HOME/opencode/AGENTS.md" ]; then
  cp /etc/opencode/AGENTS.md "$XDG_CONFIG_HOME/opencode/AGENTS.md"
fi

# Seed the upstream policy once, preserving persistent user overrides.
if [ ! -e "$XDG_CONFIG_HOME/opencode/orchestra.jsonc" ]; then
  if [ -f "$XDG_CONFIG_HOME/opencode/orchestra.json" ]; then
    cp "$XDG_CONFIG_HOME/opencode/orchestra.json" "$XDG_CONFIG_HOME/opencode/orchestra.jsonc"
  else
    cp /etc/opencode/orchestra.jsonc "$XDG_CONFIG_HOME/opencode/orchestra.jsonc"
  fi
fi

# Use gh credentials for HTTPS Git operations, including before the first login.
# Both the helper configuration and interactive logins persist in /data.
for host in github.com gist.github.com; do
  git config --global --replace-all "credential.https://$host.helper" ''
  git config --global --add "credential.https://$host.helper" '!gh auth git-credential'
done

exec "$@"
