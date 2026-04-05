import { appendFile, readFile, mkdir } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";
import type { Database } from "bun:sqlite";

// ── Types ───────────────────────────────────────────

export type SessionStatus = "idle" | "active" | "streaming" | "completed" | "error";

export interface Session {
  id: string;
  threadId: string;
  userId: string;
  status: SessionStatus;
  messageCount: number;
  createdAt: number;
  updatedAt: number;
}

export interface Message {
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: number;
  metadata?: Record<string, unknown>;
}

// ── Factory ─────────────────────────────────────────

export function createSessionManager(db: any, sqlite: Database, sessionsDir: string) {
  return {
    getOrCreateSession: (threadId: string, userId: string) =>
      getOrCreateSession(sqlite, sessionsDir, threadId, userId),
    appendMessage: (sessionId: string, message: Omit<Message, "timestamp">) =>
      appendMessage(sqlite, sessionsDir, sessionId, message),
    getMessages: (sessionId: string) =>
      getMessages(sessionsDir, sessionId),
    updateStatus: (sessionId: string, status: SessionStatus) =>
      updateStatus(sqlite, sessionId, status),
  };
}

// ── Implementation ──────────────────────────────────

async function getOrCreateSession(
  sqlite: Database,
  sessionsDir: string,
  threadId: string,
  userId: string
): Promise<Session> {
  const existing = sqlite
    .query("SELECT * FROM sessions WHERE thread_id = ? LIMIT 1")
    .get(threadId) as any;

  if (existing) {
    return {
      id: existing.id,
      threadId: existing.thread_id,
      userId: existing.user_id,
      status: existing.status,
      messageCount: existing.message_count,
      createdAt: existing.created_at,
      updatedAt: existing.updated_at,
    };
  }

  const id = `sess_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const now = Date.now();

  sqlite
    .query(
      `INSERT INTO sessions (id, thread_id, user_id, status, message_count, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(id, threadId, userId, "idle", 0, now, now);

  await mkdir(sessionsDir, { recursive: true });

  return { id, threadId, userId, status: "idle", messageCount: 0, createdAt: now, updatedAt: now };
}

async function appendMessage(
  sqlite: Database,
  sessionsDir: string,
  sessionId: string,
  message: Omit<Message, "timestamp">
): Promise<void> {
  await mkdir(sessionsDir, { recursive: true });

  const fullMessage: Message = { ...message, timestamp: Date.now() };
  const line = JSON.stringify(fullMessage) + "\n";
  await appendFile(join(sessionsDir, `${sessionId}.jsonl`), line);

  const now = Date.now();
  sqlite
    .query(
      "UPDATE sessions SET message_count = message_count + 1, updated_at = ? WHERE id = ?"
    )
    .run(now, sessionId);
}

async function getMessages(sessionsDir: string, sessionId: string): Promise<Message[]> {
  const path = join(sessionsDir, `${sessionId}.jsonl`);
  if (!existsSync(path)) return [];

  const content = await readFile(path, "utf-8");
  return content
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

async function updateStatus(
  sqlite: Database,
  sessionId: string,
  status: SessionStatus
): Promise<void> {
  const now = Date.now();
  sqlite
    .query("UPDATE sessions SET status = ?, updated_at = ? WHERE id = ?")
    .run(status, now, sessionId);
}
