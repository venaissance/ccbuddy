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
# Daemon must have NO proxy — Feishu open-apis are domestic and Clash routes
# them through overseas exit, breaking tenant_access_token. Spawned `claude`
# subprocesses get their own proxy via ~/.claude/settings.json.
unset ALL_PROXY HTTP_PROXY HTTPS_PROXY all_proxy http_proxy https_proxy

# Strip pm2's IPC env vars — pm2 sets NODE_CHANNEL_FD=3 + friends to enable
# Node.js IPC via fd 3 with parent. bun inherits this fd and somehow it
# corrupts TLS handshakes against open.feishu.cn (ECONNRESET on auth/token).
# Direct `bun run` doesn't have these vars and works; pm2 does and fails.
# Closing fd 3 + clearing the vars makes pm2-wrapped bun behave identically.
unset NODE_CHANNEL_FD NODE_CHANNEL_SERIALIZATION_MODE NODE_APP_INSTANCE PM2_HOME
exec 3<&- 3>&- 2>/dev/null || true
exec bun run src/index.ts
