/**
 * Integration tests: Core business pipeline
 * message received → session created → agent executed → response captured
 *
 * Uses real SQLite and real filesystem (temp directories).
 * Does NOT spawn actual claude CLI — tests the pipeline plumbing only.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, rmSync, mkdirSync, readFileSync } from "fs";
import { mkdtemp } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";

let TEST_DIR: string;
let TEST_DB_PATH: string;
let TEST_SESSIONS_DIR: string;

let sqlite: any;
let db: any;

// ── Setup / Teardown ───────────────────────────────

beforeEach(async () => {
  TEST_DIR = await mkdtemp(join(tmpdir(), "openclaw-pipeline-"));
  TEST_DB_PATH = join(TEST_DIR, "test.db");
  TEST_SESSIONS_DIR = join(TEST_DIR, "sessions");

  const { createDB, initDB } = await import("../../src/db");
  const result = createDB(TEST_DB_PATH);
  db = result.db;
  sqlite = result.sqlite;
  await initDB(sqlite);
});

afterEach(() => {
  if (sqlite) sqlite.close();
  if (TEST_DIR && existsSync(TEST_DIR)) {
    rmSync(TEST_DIR, { recursive: true });
  }
});

// ── Test 1: Message creates session and stores it ──

describe("Pipeline: session lifecycle via message", () => {
  test("getOrCreateSession persists in SQLite, appendMessage creates JSONL, updateStatus writes to DB", async () => {
    const { createSessionManager } = await import("../../src/session");
    const sm = createSessionManager(db, sqlite, TEST_SESSIONS_DIR);

    // 1. Create session
    const threadId = "thread_pipeline_001";
    const userId = "user_pipeline";
    const session = await sm.getOrCreateSession(threadId, userId);

    expect(session.id).toMatch(/^sess_/);
    expect(session.status).toBe("idle");

    // Verify session exists in SQLite
    const row = sqlite
      .query("SELECT * FROM sessions WHERE id = ?")
      .get(session.id) as any;
    expect(row).not.toBeNull();
    expect(row.thread_id).toBe(threadId);
    expect(row.user_id).toBe(userId);
    expect(row.status).toBe("idle");
    expect(row.message_count).toBe(0);

    // 2. Append a user message
    await sm.appendMessage(session.id, { role: "user", content: "hello" });

    // Verify JSONL file created with correct content
    const jsonlPath = join(TEST_SESSIONS_DIR, `${session.id}.jsonl`);
    expect(existsSync(jsonlPath)).toBe(true);

    const rawContent = readFileSync(jsonlPath, "utf-8");
    const lines = rawContent.split("\n").filter(Boolean);
    expect(lines).toHaveLength(1);

    const parsed = JSON.parse(lines[0]);
    expect(parsed.role).toBe("user");
    expect(parsed.content).toBe("hello");
    expect(parsed.timestamp).toBeGreaterThan(0);

    // Verify message_count incremented in SQLite
    const rowAfterMsg = sqlite
      .query("SELECT message_count FROM sessions WHERE id = ?")
      .get(session.id) as any;
    expect(rowAfterMsg.message_count).toBe(1);

    // 3. Update status to "active"
    await sm.updateStatus(session.id, "active");

    const rowAfterStatus = sqlite
      .query("SELECT status FROM sessions WHERE id = ?")
      .get(session.id) as any;
    expect(rowAfterStatus.status).toBe("active");
  });
});

// ── Test 2: Agent args for new vs resume session ───

describe("Pipeline: agent args for new vs resume", () => {
  test("buildAgentArgs omits --resume for new session, includes it after setClaudeSessionId", async () => {
    const { buildAgentArgs, setClaudeSessionId, getClaudeSessionId } =
      await import("../../src/agent");

    const sessionId = "sess_args_test";

    // New session: no --resume
    const newArgs = buildAgentArgs({ sessionId, prompt: "What is 2+2?" });
    expect(newArgs).not.toContain("--resume");
    expect(newArgs).toContain("--output-format");
    expect(newArgs).toContain("stream-json");
    expect(newArgs).toContain("--print");
    expect(newArgs).toContain("--verbose");
    expect(newArgs[newArgs.length - 1]).toBe("What is 2+2?");

    // Map session to a Claude UUID
    setClaudeSessionId(sessionId, "uuid-123");
    expect(getClaudeSessionId(sessionId)).toBe("uuid-123");

    // Resume session: has --resume
    const resumeArgs = buildAgentArgs({
      sessionId,
      prompt: "Follow up question",
      claudeSessionUuid: "uuid-123",
    });
    const resumeIdx = resumeArgs.indexOf("--resume");
    expect(resumeIdx).toBeGreaterThanOrEqual(0);
    expect(resumeArgs[resumeIdx + 1]).toBe("uuid-123");
    expect(resumeArgs[resumeArgs.length - 1]).toBe("Follow up question");
  });
});

// ── Test 3: Stream parsing pipeline ────────────────

describe("Pipeline: stream parsing", () => {
  test("parseStreamLine handles assistant text, tool_use, and result events", async () => {
    const { parseStreamLine } = await import("../../src/agent");

    // Session init event (should return null — no content blocks)
    const initLine = JSON.stringify({
      type: "system",
      session_id: "abc-def-123",
    });
    expect(parseStreamLine(initLine)).toBeNull();

    // Assistant text chunk
    const textLine = JSON.stringify({
      type: "assistant",
      message: {
        content: [{ type: "text", text: "Here is the answer" }],
      },
    });
    const textResult = parseStreamLine(textLine);
    expect(textResult).toEqual({
      type: "assistant",
      content: "Here is the answer",
    });

    // Tool use event
    const toolLine = JSON.stringify({
      type: "assistant",
      message: {
        content: [
          { type: "tool_use", name: "Bash", input: { command: "ls -la" } },
        ],
      },
    });
    const toolResult = parseStreamLine(toolLine);
    expect(toolResult).toEqual({ type: "tool_use", tool: "Bash" });

    // Result event
    const resultLine = JSON.stringify({
      type: "result",
      duration_ms: 12345,
      total_cost_usd: 0.08,
    });
    const resultEvent = parseStreamLine(resultLine);
    expect(resultEvent).toEqual({
      type: "result",
      duration: 12345,
      cost: 0.08,
    });
  });

  test("processStreamBuffer splits lines and preserves incomplete buffer", async () => {
    const { processStreamBuffer } = await import("../../src/agent");

    const line1 = JSON.stringify({ type: "system", session_id: "sess-uuid" });
    const line2 = JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "text", text: "Hi" }] },
    });
    const incompleteLine = '{"type":"result","duration_ms":50';

    const buffer = `${line1}\n${line2}\n${incompleteLine}`;
    const { lines, remaining } = processStreamBuffer(buffer);

    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe(line1);
    expect(lines[1]).toBe(line2);
    expect(remaining).toBe(incompleteLine);
  });

  test("TCP fragmentation: JSON line split across two buffer chunks", async () => {
    const { processStreamBuffer, parseStreamLine } =
      await import("../../src/agent");

    const fullEvent = JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "text", text: "fragmented response" }] },
    });

    // Simulate TCP fragmentation: split the JSON line at an arbitrary byte offset
    const splitPoint = Math.floor(fullEvent.length / 2);
    const chunk1 = fullEvent.slice(0, splitPoint);
    const chunk2 = fullEvent.slice(splitPoint) + "\n";

    // First chunk arrives: no complete line, everything goes to remaining
    const result1 = processStreamBuffer(chunk1);
    expect(result1.lines).toHaveLength(0);
    expect(result1.remaining).toBe(chunk1);

    // Second chunk arrives: concatenate with remaining, now we have a complete line
    const combined = result1.remaining + chunk2;
    const result2 = processStreamBuffer(combined);
    expect(result2.lines).toHaveLength(1);
    expect(result2.remaining).toBe("");

    // Parse the reassembled line
    const parsed = parseStreamLine(result2.lines[0]);
    expect(parsed).toEqual({
      type: "assistant",
      content: "fragmented response",
    });
  });

  test("full stream sequence: session_id capture → text → tool_use → result", async () => {
    const { processStreamBuffer, parseStreamLine } =
      await import("../../src/agent");

    // Simulate a realistic NDJSON stream from claude CLI
    const events = [
      JSON.stringify({ type: "system", session_id: "claude-uuid-456", message: "Session started" }),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Let me check that file." }] } }),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Read", input: { file_path: "/tmp/test.ts" } }] } }),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "The file contains a test." }] } }),
      JSON.stringify({ type: "result", duration_ms: 8200, total_cost_usd: 0.03 }),
    ];

    const fullStream = events.join("\n") + "\n";

    // Process entire buffer at once
    const { lines, remaining } = processStreamBuffer(fullStream);
    expect(lines).toHaveLength(5);
    expect(remaining).toBe("");

    // Parse each line and collect results
    const chunks = lines.map(parseStreamLine).filter(Boolean);

    // system event returns null from parseStreamLine (no content blocks)
    // so we get 4 parsed chunks
    expect(chunks).toHaveLength(4);
    expect(chunks[0]!.type).toBe("assistant");
    expect(chunks[0]!.content).toBe("Let me check that file.");
    expect(chunks[1]!.type).toBe("tool_use");
    expect(chunks[1]!.tool).toBe("Read");
    expect(chunks[2]!.type).toBe("assistant");
    expect(chunks[2]!.content).toBe("The file contains a test.");
    expect(chunks[3]!.type).toBe("result");
    expect(chunks[3]!.duration).toBe(8200);
    expect(chunks[3]!.cost).toBe(0.03);

    // Verify session_id can be extracted from the raw first line
    const initEvent = JSON.parse(lines[0]);
    expect(initEvent.session_id).toBe("claude-uuid-456");
  });
});

// ── Test 4: Session completion flow ────────────────

describe("Pipeline: session completion flow", () => {
  test("create session → user msg → assistant msg → completed, messages returned in order", async () => {
    const { createSessionManager } = await import("../../src/session");
    const sm = createSessionManager(db, sqlite, TEST_SESSIONS_DIR);

    // 1. Create session
    const session = await sm.getOrCreateSession("thread_complete_001", "user_complete");
    expect(session.status).toBe("idle");

    // 2. Append user message
    await sm.appendMessage(session.id, {
      role: "user",
      content: "What meetings do I have tomorrow?",
    });
    await sm.updateStatus(session.id, "active");

    // 3. Append assistant message (simulating agent response)
    await sm.appendMessage(session.id, {
      role: "assistant",
      content: "You have 3 meetings tomorrow:\n1. 09:30 Standup\n2. 14:00 Design review\n3. 16:00 1:1",
    });
    await sm.updateStatus(session.id, "completed");

    // 4. Verify messages are returned in order
    const messages = await sm.getMessages(session.id);
    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe("user");
    expect(messages[0].content).toBe("What meetings do I have tomorrow?");
    expect(messages[1].role).toBe("assistant");
    expect(messages[1].content).toContain("Standup");
    expect(messages[1].content).toContain("Design review");

    // Verify timestamps are ordered
    expect(messages[1].timestamp).toBeGreaterThanOrEqual(messages[0].timestamp);

    // 5. Verify session status is "completed" in SQLite
    const row = sqlite
      .query("SELECT * FROM sessions WHERE id = ?")
      .get(session.id) as any;
    expect(row.status).toBe("completed");
    expect(row.message_count).toBe(2);

    // 6. Verify idempotency: same threadId returns same session
    const sameSession = await sm.getOrCreateSession("thread_complete_001", "user_complete");
    expect(sameSession.id).toBe(session.id);
    expect(sameSession.status).toBe("completed");
  });
});
