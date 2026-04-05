import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, rmSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";

const TEST_DIR = join(import.meta.dir, "../.test-data");
const TEST_DB_PATH = join(TEST_DIR, "test.db");
const TEST_SESSIONS_DIR = join(TEST_DIR, "sessions");
const TEST_MEMORY_DIR = join(TEST_DIR, "memory");

describe("api", () => {
  let app: any;
  let sqlite: any;

  beforeEach(async () => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_SESSIONS_DIR, { recursive: true });
    mkdirSync(join(TEST_MEMORY_DIR, "topics"), { recursive: true });

    // Create memory files
    writeFileSync(join(TEST_MEMORY_DIR, "SOUL.md"), "# SOUL\nI am OpenClaw");
    writeFileSync(join(TEST_MEMORY_DIR, "USER.md"), "# USER\nAlice");

    const { createDB, initDB } = await import("../../src/db");
    const result = createDB(TEST_DB_PATH);
    sqlite = result.sqlite;
    await initDB(sqlite);

    // Seed test data
    const now = Date.now();
    sqlite
      .query(
        `INSERT INTO sessions (id, thread_id, user_id, status, message_count, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run("sess_001", "thread_abc", "user_123", "completed", 5, now, now);

    sqlite
      .query(
        `INSERT INTO logs (level, source, message, created_at)
         VALUES (?, ?, ?, ?)`
      )
      .run("info", "cron", "Heartbeat done", now);

    // Create JSONL for session
    writeFileSync(
      join(TEST_SESSIONS_DIR, "sess_001.jsonl"),
      '{"role":"user","content":"Hello","timestamp":1000}\n{"role":"assistant","content":"Hi!","timestamp":1001}\n'
    );

    const { Hono } = await import("hono");
    const { registerRoutes } = await import("../../src/api");
    app = new Hono();
    registerRoutes(app, sqlite, TEST_SESSIONS_DIR, TEST_MEMORY_DIR);
  });

  afterEach(() => {
    if (sqlite) sqlite.close();
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  describe("GET /api/sessions", () => {
    test("returns session list", async () => {
      const res = await app.request("/api/sessions");
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(Array.isArray(data)).toBe(true);
      expect(data.length).toBeGreaterThanOrEqual(1);
      expect(data[0].id).toBe("sess_001");
    });
  });

  describe("GET /api/sessions/:id", () => {
    test("returns session detail", async () => {
      const res = await app.request("/api/sessions/sess_001");
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data.id).toBe("sess_001");
      expect(data.status).toBe("completed");
    });

    test("returns 404 for non-existent session", async () => {
      const res = await app.request("/api/sessions/nonexistent");
      expect(res.status).toBe(404);
    });
  });

  describe("GET /api/sessions/:id/messages", () => {
    test("returns JSONL messages", async () => {
      const res = await app.request("/api/sessions/sess_001/messages");
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data).toHaveLength(2);
      expect(data[0].role).toBe("user");
      expect(data[1].role).toBe("assistant");
    });

    test("returns empty array for session without messages", async () => {
      const res = await app.request("/api/sessions/nonexistent/messages");
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data).toEqual([]);
    });
  });

  describe("GET /api/logs", () => {
    test("returns log list", async () => {
      const res = await app.request("/api/logs");
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data.length).toBeGreaterThanOrEqual(1);
      expect(data[0].source).toBe("cron");
    });

    test("respects limit parameter", async () => {
      const res = await app.request("/api/logs?limit=1");
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data).toHaveLength(1);
    });
  });

  describe("GET /api/memory", () => {
    test("returns core memory", async () => {
      const res = await app.request("/api/memory");
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data.soul).toContain("OpenClaw");
      expect(data.user).toContain("Alice");
    });
  });

  describe("Tasks CRUD", () => {
    test("POST /api/tasks creates a task", async () => {
      const res = await app.request("/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: "task_001",
          name: "Heartbeat",
          cronExpr: "*/30 * * * *",
          prompt: "Execute /heartbeat",
        }),
      });
      expect(res.status).toBe(201);

      const data = await res.json();
      expect(data.id).toBe("task_001");
    });

    test("GET /api/tasks returns task list", async () => {
      // Create a task first
      const now = Date.now();
      sqlite
        .query(
          `INSERT INTO tasks (id, name, cron_expr, prompt, enabled, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`
        )
        .run("task_002", "Cleanup", "0 2 * * *", "Clean old logs", 1, now);

      const res = await app.request("/api/tasks");
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data.length).toBeGreaterThanOrEqual(1);
    });

    test("DELETE /api/tasks/:id removes a task", async () => {
      const now = Date.now();
      sqlite
        .query(
          `INSERT INTO tasks (id, name, prompt, enabled, created_at)
           VALUES (?, ?, ?, ?, ?)`
        )
        .run("task_del", "ToDelete", "test", 1, now);

      const res = await app.request("/api/tasks/task_del", { method: "DELETE" });
      expect(res.status).toBe(200);

      const row = sqlite.query("SELECT * FROM tasks WHERE id = ?").get("task_del");
      expect(row).toBeNull();
    });
  });
});
