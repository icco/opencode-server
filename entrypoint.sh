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

mkdir -p "$XDG_CONFIG_HOME/opencode" "$XDG_CONFIG_HOME/gh" "$XDG_DATA_HOME/opencode" \
  "$XDG_STATE_HOME/opencode" "$XDG_CACHE_HOME/opencode" "$HOME/workspace"

# The upstream router discovers config under HOME, not beside OPENCODE_CONFIG.
# Seed once so persistent user overrides (including JSONC) survive image updates.
router_config="$HOME/.config/opencode"
mkdir -p "$router_config"
if [ ! -e "$router_config/opencode-auto-router.json" ] && \
   [ ! -e "$router_config/opencode-auto-router.jsonc" ]; then
  cp /etc/opencode/opencode-auto-router.json "$router_config/opencode-auto-router.json"
fi

# Use gh credentials for HTTPS Git operations, including before the first login.
# Both the helper configuration and interactive logins persist in /data.
for host in github.com gist.github.com; do
  git config --global --replace-all "credential.https://$host.helper" ''
  git config --global --add "credential.https://$host.helper" '!gh auth git-credential'
done

exec "$@"
