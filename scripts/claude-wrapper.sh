#!/usr/bin/env bash
# Wrapper around `claude` CLI — runs a lightweight proxy health check before each invocation.
# Used by CCBuddy so that agent.ts stays proxy-unaware.
# The actual proxy URL is read from ~/.claude/settings.json by Claude CLI itself.
set -eo pipefail

PREFLIGHT="${CCBUDDY_PREFLIGHT:-$HOME/.claude/hooks/preflight.sh}"

if [ -f "$PREFLIGHT" ]; then
  if ! bash "$PREFLIGHT" 2>/dev/null; then
    echo "[claude-wrapper] Preflight failed, aborting." >&2
    exit 1
  fi
fi

exec claude "$@"
