/**
 * Integration tests: Full HTTP server + API + DB + JSONL pipeline
 * Tests the real Hono app with SQLite and file system.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { existsSync, rmSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";

const TEST_DIR = join(import.meta.dir, "../.test-data-integration");
const TEST_DB_PATH = join(TEST_DIR, "test.db");
const TEST_SESSIONS_DIR = join(TEST_DIR, "sessions");
const TEST_MEMORY_DIR = join(TEST_DIR, "memory");

let app: any;
let sqlite: any;

beforeAll(async () => {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  mkdirSync(TEST_DIR, { recursive: true });

  // Init memory
  const { initMemory } = await import("../../src/memory");
  await initMemory(TEST_MEMORY_DIR);

  // Init DB
  const { createDB, initDB } = await import("../../src/db");
  const result = createDB(TEST_DB_PATH);
  sqlite = result.sqlite;
  await initDB(sqlite);

  // Create Hono app
  const { Hono } = await import("hono");
  const { registerRoutes } = await import("../../src/api");
  app = new Hono();
  registerRoutes(app, sqlite, TEST_SESSIONS_DIR, TEST_MEMORY_DIR);
});

afterAll(() => {
  if (sqlite) sqlite.close();
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
});

describe("Integration: Full API pipeline", () => {
  // ── Session lifecycle ───────────────────────────

  test("complete session lifecycle: create → messages → query", async () => {
    // 1. Create session via DB (simulating feishu-ws handler)
    const now = Date.now();
    sqlite
      .query(
        `INSERT INTO sessions (id, thread_id, user_id, status, message_count, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run("int_sess_001", "thread_int_1", "user_int", "idle", 0, now, now);

    // 2. Append messages via JSONL (simulating session manager)
    mkdirSync(TEST_SESSIONS_DIR, { recursive: true });
    const msgs = [
      { role: "user", content: "帮我查明天的会议", timestamp: now },
      { role: "assistant", content: "好的，正在查看日历...", timestamp: now + 100 },
      { role: "assistant", content: "明天有3个会议：\n1. 09:30 周会\n2. 14:00 设计评审\n3. 16:00 1:1", timestamp: now + 5000 },
    ];
    writeFileSync(
      join(TEST_SESSIONS_DIR, "int_sess_001.jsonl"),
      msgs.map((m) => JSON.stringify(m)).join("\n") + "\n"
    );

    // Update message count
    sqlite
      .query("UPDATE sessions SET message_count = ?, status = ? WHERE id = ?")
      .run(3, "completed", "int_sess_001");

    // 3. Query via API
    const listRes = await app.request("/api/sessions");
    expect(listRes.status).toBe(200);
    const sessions = await listRes.json();
    expect(sessions.some((s: any) => s.id === "int_sess_001")).toBe(true);

    // 4. Get detail
    const detailRes = await app.request("/api/sessions/int_sess_001");
    const detail = await detailRes.json();
    expect(detail.status).toBe("completed");
    expect(detail.message_count).toBe(3);

    // 5. Get messages
    const msgsRes = await app.request("/api/sessions/int_sess_001/messages");
    const messages = await msgsRes.json();
    expect(messages).toHaveLength(3);
    expect(messages[0].content).toBe("帮我查明天的会议");
    expect(messages[2].content).toContain("周会");
  });

  // ── Task CRUD full cycle ────────────────────────

  test("task CRUD: create → list → update → delete", async () => {
    // Create
    const createRes = await app.request("/api/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: "int_task_001",
        name: "Daily Briefing",
        cronExpr: "0 9 * * 1-5",
        prompt: "Summarize today's calendar and tasks",
      }),
    });
    expect(createRes.status).toBe(201);
    const created = await createRes.json();
    expect(created.name).toBe("Daily Briefing");

    // List
    const listRes = await app.request("/api/tasks");
    const tasks = await listRes.json();
    expect(tasks.some((t: any) => t.id === "int_task_001")).toBe(true);

    // Update
    const updateRes = await app.request("/api/tasks/int_task_001", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Morning Briefing", enabled: false }),
    });
    const updated = await updateRes.json();
    expect(updated.name).toBe("Morning Briefing");
    expect(updated.enabled).toBe(0);

    // Delete
    const deleteRes = await app.request("/api/tasks/int_task_001", { method: "DELETE" });
    expect(deleteRes.status).toBe(200);

    // Verify deleted
    const afterDelete = await app.request("/api/tasks");
    const remaining = await afterDelete.json();
    expect(remaining.every((t: any) => t.id !== "int_task_001")).toBe(true);
  });

  // ── Logs pipeline ───────────────────────────────

  test("logs: insert → query with filter", async () => {
    const now = Date.now();

    // Insert various logs
    const insertLog = sqlite.prepare(
      `INSERT INTO logs (level, source, message, metadata, created_at) VALUES (?, ?, ?, ?, ?)`
    );
    insertLog.run("info", "cron", "Heartbeat started", null, now);
    insertLog.run("info", "agent", "Session sess_001 started", '{"sessionId":"sess_001"}', now + 1);
    insertLog.run("warn", "feishu-ws", "Rate limit at 80%", null, now + 2);
    insertLog.run("error", "agent", "CLI timeout after 120s", '{"sessionId":"sess_002"}', now + 3);

    // Query all
    const allRes = await app.request("/api/logs");
    const allLogs = await allRes.json();
    expect(allLogs.length).toBeGreaterThanOrEqual(4);

    // Query with limit
    const limitRes = await app.request("/api/logs?limit=2");
    const limited = await limitRes.json();
    expect(limited).toHaveLength(2);
    // Should be ordered by created_at DESC
    expect(limited[0].created_at).toBeGreaterThanOrEqual(limited[1].created_at);
  });

  // ── Memory integration ──────────────────────────

  test("memory: init → core → recall", async () => {
    // Core memory should exist from beforeAll init
    const coreRes = await app.request("/api/memory");
    expect(coreRes.status).toBe(200);
    const core = await coreRes.json();
    expect(core.soul).toContain("Identity");
    expect(core.user).toContain("Name");

    // Add a topic file
    writeFileSync(
      join(TEST_MEMORY_DIR, "topics/project-demo.md"),
      "# Project Demo\nBuilding an AI agent with Bun and Hono\nDeadline is next Friday"
    );

    // Recall should find it
    const recallRes = await app.request("/api/memory/recall?q=project+demo+agent");
    const recalled = await recallRes.json();
    expect(recalled.length).toBeGreaterThanOrEqual(1);
    expect(recalled[0].name).toBe("project-demo.md");
    expect(recalled[0].content).toContain("Bun and Hono");
  });
});

describe("Integration: Session Manager + JSONL", () => {
  test("full session flow via session manager", async () => {
    const { createDB, initDB } = await import("../../src/db");
    const sessDir = join(TEST_DIR, "sessions-sm");

    const { db: db2, sqlite: sqlite2 } = createDB(join(TEST_DIR, "sm-test.db"));
    await initDB(sqlite2);

    const { createSessionManager } = await import("../../src/session");
    const sm = createSessionManager(db2, sqlite2, sessDir);

    // Create session
    const s = await sm.getOrCreateSession("thread_sm_1", "user_sm");
    expect(s.status).toBe("idle");

    // Append messages
    await sm.appendMessage(s.id, { role: "user", content: "Hello" });
    await sm.updateStatus(s.id, "active");
    await sm.appendMessage(s.id, { role: "assistant", content: "Hi there!" });
    await sm.updateStatus(s.id, "completed");

    // Verify state
    const msgs = await sm.getMessages(s.id);
    expect(msgs).toHaveLength(2);

    const row = sqlite2.query("SELECT * FROM sessions WHERE id = ?").get(s.id) as any;
    expect(row.message_count).toBe(2);
    expect(row.status).toBe("completed");

    // Same threadId returns same session
    const s2 = await sm.getOrCreateSession("thread_sm_1", "user_sm");
    expect(s2.id).toBe(s.id);

    sqlite2.close();
  });
});

describe("Integration: Memory lifecycle", () => {
  test("init → write → compress → recall", async () => {
    const memDir = join(TEST_DIR, "memory-lifecycle");
    const { initMemory, getCoreMemory, compressToMemory, recallMemories } =
      await import("../../src/memory");

    // Init
    await initMemory(memDir);
    const core = await getCoreMemory(memDir);
    expect(core.soul).toContain("SOUL");
    expect(core.user).toContain("USER");

    // Write topics
    await compressToMemory("User prefers dark mode and terse responses", "preferences", memDir);
    await compressToMemory("Working on Project Alpha, deadline March 15", "project-alpha", memDir);
    await compressToMemory("Learning Rust for systems programming", "learning", memDir);

    // Recall
    const results = await recallMemories("project deadline", memDir);
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].name).toBe("project-alpha.md");

    // Append to existing topic
    await compressToMemory("Deadline moved to March 22", "project-alpha", memDir);
    const updated = await recallMemories("project alpha", memDir);
    expect(updated[0].content).toContain("March 15");
    expect(updated[0].content).toContain("March 22");
    expect(updated[0].content).toContain("---"); // separator
  });
});
