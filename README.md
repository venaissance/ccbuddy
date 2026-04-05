# CCBuddy

[![Bun](https://img.shields.io/badge/Bun-%3E%3D1.3-f9f1e1?logo=bun)](https://bun.sh)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-3178c6?logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

[English](README.md) | [中文](README_ZH.md)

> Personal AI assistant daemon on Feishu, powered by Claude Code CLI. 1.6K LOC, 9 modules, zero Docker dependency.

CCBuddy runs as a single Bun process that connects to Feishu via WebSocket, spawns Claude Code CLI for each conversation, and streams replies back as interactive cards with a typewriter effect. A cron heartbeat keeps the agent alive and proactive.

## Features

- **Streaming replies** -- CardKit-based typewriter effect with debounced updates, automatic fallback to message.patch
- **Feishu WebSocket** -- Persistent long connection, no webhook server needed, handles text and rich-text messages
- **Three-layer memory** -- SOUL (personality) + USER (profile) + topics (keyword-recalled per conversation)
- **Heartbeat cron** -- Triggers the agent every 30 minutes; the agent decides autonomously what to do
- **Session management** -- Per-chat sessions with JSONL message history and SQLite metadata
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

# Install dependencies
bun install

# Configure environment
cp .env.example .env
# Edit .env with your credentials:
#   FEISHU_APP_ID=cli_xxxxxxxxxxxx
#   FEISHU_APP_SECRET=xxxxxxxxxxxxxxxxxxxxxxxx
#   PORT=3001  (optional, defaults to 3000)

# Run (development, with hot reload)
bun run dev

# Run (production)
bun run start
```

The server starts on `http://localhost:3000`. The dashboard is served at the root path.

### Production with PM2

```bash
pm2 start ecosystem.config.cjs
```

## How It Works

### Message Flow

```
User sends message on Feishu
  -> Feishu WebSocket delivers event
    -> extractText() parses text/post content
      -> addReaction("OnIt") for instant feedback
        -> getOrCreateSession() by chat ID
          -> spawn `claude` CLI with --output-format stream-json
            -> parse NDJSON stream line by line
              -> StreamingCard.pushContent() (debounced, typewriter)
                -> StreamingCard.complete() on finish
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
  index.ts          Bootstrap: DB, memory, HTTP, WebSocket, cron
  agent.ts          Spawn Claude CLI, parse NDJSON stream, manage processes
  feishu-ws.ts      WebSocket init, text extraction, StreamingCard (CardKit)
  feishu-auth.ts    OAuth Device Flow via lark-cli
  session.ts        Session CRUD, JSONL message append
  memory.ts         Three-layer memory: SOUL, USER, topic recall
  db.ts             SQLite schema (Drizzle ORM), WAL mode
  api.ts            Hono REST routes: sessions, tasks, logs, memory
  cron.ts           Heartbeat scheduler with concurrency guard

web/                React dashboard (Vite + React)
tests/              169 tests across 11 files
  unit/             8 files — agent, API, cron, DB, feishu-auth, feishu-ws, memory, session
  integration/      2 files — API E2E, message pipeline
  e2e/              1 file  — server lifecycle
data/               Runtime data (gitignored)
  openclaw.db       SQLite database
  sessions/         JSONL message files
  memory/           SOUL.md, USER.md, topics/
```

## Testing

```
169 tests | 0 failures | 447 assertions
11 files: 8 unit + 2 integration + 1 E2E
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
