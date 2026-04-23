# CCBuddy

[![Bun](https://img.shields.io/badge/Bun-%3E%3D1.3-f9f1e1?logo=bun)](https://bun.sh)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-3178c6?logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

[English](README.md) | [中文](README_ZH.md)

> Personal AI assistant daemon on Feishu, powered by Claude Code CLI. ~2.1K LOC, 10 modules, zero Docker dependency.

CCBuddy runs as a single Bun process that connects to Feishu via WebSocket, spawns Claude Code CLI for each conversation, and streams replies back as interactive cards with a typewriter effect. A cron heartbeat keeps the agent alive and proactive.

## Features

- **Streaming replies** -- Token-level streaming via `--include-partial-messages`, smart FlushController (300ms + 30 char threshold), lazy card creation on first content, thinking state display
- **Slash commands** -- `/model` (interactive card with model + effort picker), `/cost` (usage stats in ¥), `/new`, `/stop`, `/compact`, `/context`, `/status`, `/help`, `/daily-report` (on-demand AI briefing)
- **Daily AI briefing** -- Cron at 07:00 wakes agent to produce a high-density Feishu card (≥9 AI news + 5 Product Hunt + 5 GitHub Trending), appends to a wiki doc, captures cost footer. 80+ curated sources, deterministic daemon-side distribution, 5-min agent watchdog.
- **Production-grade resilience** -- `ensureDataDirs()` prevents fresh-install ENOENT, global unhandled-error handlers keep the process alive through Feishu 5xx, a WS network supervisor rebuilds the WebSocket on connectivity changes and exits for PM2 restart after 15 min of unreachability.
- **Usage tracking** -- Per-turn token counts, API-equivalent cost in CNY, persistent historical totals in SQLite, rate limit reset countdowns
- **Feishu WebSocket** -- Persistent long connection, no webhook server needed, card action callbacks (`card.action.trigger`)
- **Three-layer memory** -- SOUL (personality) + USER (profile) + topics (keyword-recalled per conversation)
- **Heartbeat cron** -- Triggers the agent every 30 minutes; the agent decides autonomously what to do
- **Session management** -- Per-chat sessions with JSONL message history and SQLite metadata, model/effort per session
- **OAuth Device Flow** -- `/auth` command for user-scoped Feishu API access (calendar, tasks, docs)
- **Two-layer skills** -- Project-level and global skills loaded by Claude Code from `CLAUDE.md`
- **React dashboard** -- Web UI for sessions, tasks, logs, and memory inspection
- **REST API** -- CRUD endpoints for sessions, tasks, logs, and memory recall

## Architecture

```
                         +-----------+
                         |   Feishu  |
                         |  Platform |
                         +-----+-----+
                               |
                          WebSocket (persistent)
                               |
+------------------------------+------------------------------+
|                        Bun Process                          |
|                                                             |
|  +---------+     +-----------+     +--------+               |
|  |  Hono   |     | Feishu WS |     |  Cron  |               |
|  |  HTTP   |     | Receiver  |     | (30m)  |               |
|  +----+----+     +-----+-----+     +---+----+               |
|       |                |               |                    |
|       |     +----------+----------+    |                    |
|       |     |                     |    |                    |
|  +----+-----+----+          +-----+----+----+               |
|  |   REST API    |          |    Agent      |               |
|  | sessions      |          | spawn claude  |               |
|  | tasks/logs    |          | NDJSON stream |               |
|  | memory        |          | parse chunks  |               |
|  +---------------+          +-------+-------+               |
|                                     |                       |
|       +-----------------------------+---+                   |
|       |              |                  |                    |
|  +----+----+   +-----+------+   +------+-------+           |
|  | Session |   |   Memory   |   | StreamingCard |           |
|  |  JSONL  |   | SOUL/USER/ |   |  CardKit API  |           |
|  | +SQLite |   |  topics/   |   |  + fallback   |           |
|  +---------+   +------------+   +--------------+            |
+-------------------------------------------------------------+
```

Three IO channels, one process: **HTTP** (dashboard + API), **WebSocket** (Feishu events), **Cron** (heartbeat).

## Quick Start

### Prerequisites

- [Bun](https://bun.sh) >= 1.3
- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) installed and authenticated
- A Feishu App with **WebSocket long connection** enabled (Developer Console > Events & Callbacks > Use Long Connection)

### Setup

```bash
# Clone
git clone <repo-url> ccbuddy && cd ccbuddy

# One-command setup (install deps, configure, start PM2)
bash scripts/setup.sh
```

Or step by step:

```bash
bun install
cp .env.example .env          # then edit with your Feishu credentials
cp ecosystem.config.example.cjs ecosystem.config.cjs

# Development (hot reload)
bun run dev

# Production (PM2 daemon)
pm2 start ecosystem.config.cjs
```

The server starts on `http://localhost:3000`. The dashboard is served at the root path.

### Preflight (optional)

The PM2 entry point (`scripts/start.sh`) looks for a preflight script at `~/.claude/hooks/preflight.sh` before launching CCBuddy. If found, it runs the script and aborts on failure. This is useful for environment checks (e.g. network connectivity, required services). If no preflight script exists, it is skipped silently.

### Auto-start on boot

```bash
pm2 startup       # prints a sudo command — run it
pm2 save           # persist process list
```

## How It Works

### Message Flow

```
User sends message on Feishu
  -> WebSocket event
    -> /auth, /model, /cost...? → slash command handler (direct reply)
    -> normal message:
      -> addReaction("OnIt")
      -> spawn claude CLI (--include-partial-messages --model --effort)
        -> thinking_delta → lazy create card "💭 思考中..."
        -> text_delta → accumulate + smart flush to CardKit
        -> result → record tokens/cost to SQLite, build statusline
        -> card.complete() with statusline footer
```

### Memory System

| Layer | File | Loaded | Purpose |
|-------|------|--------|---------|
| SOUL | `data/memory/SOUL.md` | Always | Agent personality, core traits, lessons learned |
| USER | `data/memory/USER.md` | Always | User profile, preferences, accumulated context |
| Topics | `data/memory/topics/*.md` | On keyword match | Conversation-specific knowledge, recalled by relevance scoring |

The agent reads and writes these files through Claude Code's filesystem tools. Topic recall uses keyword extraction (stop-word filtered) and a filename + content scoring heuristic.

### Heartbeat

Every 30 minutes, the cron scheduler fires a heartbeat. The agent receives a wake-up prompt and executes its `/heartbeat` skill -- checking pending tasks, reviewing calendar, or doing nothing if idle. A guard prevents concurrent heartbeat runs.

### Daily AI Briefing

Every day at 07:00 (`DAILY_REPORT_CRON`, timezone `DAILY_REPORT_TZ`) the daemon wakes an agent with the `daily-report` skill. The agent curates the past 24h from 80+ sources (labs, arXiv, HuggingFace, Hacker News, Chinese AI media) and writes a structured JSON to `data/daily-report/YYYY-MM-DD.json`. The daemon then:

1. Loads the JSON and builds a dedicated Feishu card (blue header, metadata strip, flat news lists, collapsible sources panel, wiki button)
2. Persists a `.cost.json` sidecar with tokens/cost/duration
3. Sends the card to `DAILY_REPORT_CHAT_ID`
4. Appends the markdown to the wiki at `DAILY_REPORT_WIKI_TOKEN` via `lark-cli`

A 5-minute watchdog kills runaway agents but still delivers whatever was written. Manual debug entry points: `/daily-report demo` (built-in sample), `/daily-report render` (reuse today's JSON), `/daily-report YYYY-MM-DD` (rerender historical).

### OAuth

When a user sends `/auth`, CCBuddy initiates a Device Flow via `lark-cli`:

1. Runs `lark-cli auth login --no-wait` to get a verification URL
2. Sends an interactive card with an "Authorize" button
3. Polls in the background until the user completes authorization
4. Sends a success notification card

This grants user-scoped access to calendar, tasks, docs, contacts, and messages.

## Project Structure

```
src/
  index.ts          Bootstrap: ensureDataDirs, DB, memory, HTTP, WebSocket, cron; process error handlers
  agent.ts          Spawn Claude CLI, parse NDJSON stream, manage processes, SessionMeta
  commands.ts       Slash commands (/model, /cost, /new, /stop, /daily-report...), statusline builder
  feishu-ws.ts      WebSocket init, StreamingCard (CardKit), card actions, network supervisor (rebuild on outage)
  feishu-auth.ts    OAuth Device Flow via lark-cli
  usage.ts          Persistent usage tracking (SQLite), cost formatting (CNY)
  session.ts        Session CRUD, JSONL message append
  memory.ts         Three-layer memory: SOUL, USER, topic recall
  db.ts             SQLite schema (Drizzle ORM), WAL mode
  api.ts            Hono REST routes: sessions, tasks, logs, memory
  cron.ts           Heartbeat scheduler with concurrency guard
  daily-report.ts   07:00 AI briefing: agent runner + JSON contract + card builder + wiki append

scripts/
  setup.sh          One-command install and PM2 setup
  start.sh          PM2 entry point (preflight + bun)
  claude-wrapper.sh Proxy preflight check wrapper (optional)
web/                React dashboard (Vite + React)
tests/              193 tests across 12 files
  unit/             9 files — agent, API, cron, daily-report, DB, feishu-auth, feishu-ws, memory, session
  integration/      2 files — API E2E, message pipeline
  e2e/              1 file  — server lifecycle
data/               Runtime data (gitignored)
  ccbuddy.db        SQLite database
  sessions/         JSONL message files
  memory/           SOUL.md, USER.md, topics/
  daily-report/     YYYY-MM-DD.json + YYYY-MM-DD.cost.json
```

## Testing

```
193 tests | 0 failures | 488 assertions
12 files: 9 unit + 2 integration + 1 E2E
```

```bash
# Run all tests
bun test

# Watch mode
bun run test:watch

# CI mode (no watch, strict)
bun run test:ci
```

## Tech Stack

| Component | Technology |
|-----------|-----------|
| Runtime | Bun 1.3 |
| Framework | Hono 4.7 |
| Database | SQLite (bun:sqlite) + Drizzle ORM 0.45 |
| Feishu SDK | @larksuiteoapi/node-sdk 1.60 |
| LLM Engine | Claude Code CLI (spawn, NDJSON stream) |
| Scheduler | node-cron |
| Dashboard | React + Vite |
| Linter | Biome |
| Process Manager | PM2 (optional) |

## License

MIT
