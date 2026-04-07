#!/usr/bin/env bash
# PM2 启动入口 — 先跑 preflight 再启动 CCBuddy
set -eo pipefail

PREFLIGHT="$HOME/.claude/hooks/preflight.sh"

if [ -f "$PREFLIGHT" ]; then
  echo "[start] Running preflight..."
  if ! bash "$PREFLIGHT"; then
    echo "[start] Preflight failed, aborting."
    exit 1
  fi
else
  echo "[start] No preflight script found, skipping."
fi

echo "[start] Launching CCBuddy..."
exec bun run src/index.ts
