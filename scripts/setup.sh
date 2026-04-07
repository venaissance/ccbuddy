#!/usr/bin/env bash
# CCBuddy — one-command setup script
# Usage: bash scripts/setup.sh
set -eo pipefail

GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[0;33m'
BOLD='\033[1m'
RESET='\033[0m'

pass() { printf "${GREEN}  ✓ %s${RESET}\n" "$1"; }
fail() { printf "${RED}  ✗ %s${RESET}\n" "$1"; }
warn() { printf "${YELLOW}  ! %s${RESET}\n" "$1"; }
step() { printf "\n${BOLD}[$1/$TOTAL] %s${RESET}\n" "$2"; }

TOTAL=5

printf "${BOLD}CCBuddy Setup${RESET}\n"

# ── 1. Check prerequisites ──────────────────────────

step 1 "Checking prerequisites"

if ! command -v bun &>/dev/null; then
  fail "Bun not found. Install: https://bun.sh"
  exit 1
fi
pass "Bun $(bun --version)"

if ! command -v claude &>/dev/null; then
  fail "Claude Code CLI not found. Install: https://docs.anthropic.com/en/docs/claude-code"
  exit 1
fi
pass "Claude Code CLI found"

# ── 2. Install dependencies ─────────────────────────

step 2 "Installing dependencies"
bun install --frozen-lockfile 2>/dev/null || bun install
pass "Dependencies installed"

# ── 3. Configure environment ────────────────────────

step 3 "Configuring environment"

if [ ! -f .env ]; then
  cp .env.example .env
  warn ".env created from template — edit it with your Feishu credentials"
  warn "  FEISHU_APP_ID=cli_xxxxxxxxxxxx"
  warn "  FEISHU_APP_SECRET=xxxxxxxxxxxxxxxxxxxxxxxx"
else
  pass ".env already exists"
fi

if [ ! -f ecosystem.config.cjs ]; then
  cp ecosystem.config.example.cjs ecosystem.config.cjs
  pass "ecosystem.config.cjs created from template"
  warn "Edit it if you need custom settings (e.g. proxy, memory limit)"
else
  pass "ecosystem.config.cjs already exists"
fi

# ── 4. Setup PM2 ────────────────────────────────────

step 4 "Setting up PM2"

if ! command -v pm2 &>/dev/null; then
  echo "  Installing PM2..."
  npm install -g pm2 2>&1 | tail -1
fi
pass "PM2 $(pm2 --version)"

# Stop existing instance if running
pm2 delete ccbuddy 2>/dev/null || true

pm2 start ecosystem.config.cjs
pm2 save --force 2>/dev/null
pass "CCBuddy started and saved"

# ── 5. Verify ───────────────────────────────────────

step 5 "Verifying"

sleep 3
STATUS=$(pm2 jq 0 2>/dev/null | python3 -c "import sys,json; print(json.load(sys.stdin)[0]['pm2_env']['status'])" 2>/dev/null || pm2 show ccbuddy 2>/dev/null | grep status | awk '{print $4}')

if [ "$STATUS" = "online" ]; then
  pass "CCBuddy is running"
else
  fail "CCBuddy failed to start. Check: pm2 logs ccbuddy"
  exit 1
fi

printf "\n${GREEN}${BOLD}  Setup complete!${RESET}\n\n"
echo "  Useful commands:"
echo "    pm2 logs ccbuddy       View logs"
echo "    pm2 restart ccbuddy    Restart"
echo "    pm2 stop ccbuddy       Stop"
echo "    pm2 monit              Monitor dashboard"
echo ""
echo "  Optional — auto-start on boot:"
echo "    pm2 startup"
echo "    (then run the sudo command it prints)"
echo ""
