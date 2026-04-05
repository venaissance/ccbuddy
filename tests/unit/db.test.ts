import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, rmSync, mkdirSync } from "fs";
import { join } from "path";

// Use temp directory for test isolation
const TEST_DATA_DIR = join(import.meta.dir, "../.test-data");
const TEST_DB_PATH = join(TEST_DATA_DIR, "test.db");

describe("db", () => {
  beforeEach(() => {
    // Clean slate for each test
    if (existsSync(TEST_DATA_DIR)) {
      rmSync(TEST_DATA_DIR, { recursive: true });
    }
    mkdirSync(TEST_DATA_DIR, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(TEST_DATA_DIR)) {
      rmSync(TEST_DATA_DIR, { recursive: true });
    }
  });

  describe("initDB", () => {
    test("creates all tables on fresh database", async () => {
      const { createDB, initDB } = await import("../../src/db");
      const { db, sqlite } = createDB(TEST_DB_PATH);
      await initDB(sqlite);

      // Verify tables exist
      const tables = sqlite
        .query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
        .all() as { name: string }[];
      const tableNames = tables.map((t) => t.name);

      expect(tableNames).toContain("sessions");
      expect(tableNames).toContain("tasks");
      expect(tableNames).toContain("logs");

      sqlite.close();
    });

    test("enables WAL journal mode", async () => {
      const { createDB, initDB } = await import("../../src/db");
      const { db, sqlite } = createDB(TEST_DB_PATH);
      await initDB(sqlite);

      const result = sqlite.query("PRAGMA journal_mode").get() as {
        journal_mode: string;
      };
      expect(result.journal_mode).toBe("wal");

      sqlite.close();
    });

    test("creates indexes", async () => {
      const { createDB, initDB } = await import("../../src/db");
      const { db, sqlite } = createDB(TEST_DB_PATH);
      await initDB(sqlite);

      const indexes = sqlite
        .query("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%'")
        .all() as { name: string }[];
      const indexNames = indexes.map((i) => i.name);

      expect(indexNames).toContain("idx_sessions_thread");
      expect(indexNames).toContain("idx_logs_created");

      sqlite.close();
    });

    test("is idempotent — calling twice does not error", async () => {
      const { createDB, initDB } = await import("../../src/db");
      const { db, sqlite } = createDB(TEST_DB_PATH);

      await initDB(sqlite);
      await initDB(sqlite); // second call should not throw

      sqlite.close();
    });
  });

  describe("sessions table", () => {
    test("inserts and retrieves a session", async () => {
      const { createDB, initDB } = await import("../../src/db");
      const { db, sqlite } = createDB(TEST_DB_PATH);
      await initDB(sqlite);

      const now = Date.now();
      sqlite
        .query(
          `INSERT INTO sessions (id, thread_id, user_id, status, message_count, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .run("sess_001", "thread_abc", "user_123", "idle", 0, now, now);

      const row = sqlite
        .query("SELECT * FROM sessions WHERE id = ?")
        .get("sess_001") as any;

      expect(row.id).toBe("sess_001");
      expect(row.thread_id).toBe("thread_abc");
      expect(row.user_id).toBe("user_123");
      expect(row.status).toBe("idle");
      expect(row.message_count).toBe(0);

      sqlite.close();
    });

    test("thread_id index accelerates lookup", async () => {
      const { createDB, initDB } = await import("../../src/db");
      const { db, sqlite } = createDB(TEST_DB_PATH);
      await initDB(sqlite);

      // Insert test data
      const now = Date.now();
      for (let i = 0; i < 100; i++) {
        sqlite
          .query(
            `INSERT INTO sessions (id, thread_id, user_id, status, message_count, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`
          )
          .run(`sess_${i}`, `thread_${i}`, "user_1", "idle", 0, now, now);
      }

      // EXPLAIN QUERY PLAN should show index usage
      const plan = sqlite
        .query("EXPLAIN QUERY PLAN SELECT * FROM sessions WHERE thread_id = ?")
        .all("thread_50") as any[];

      const usesIndex = plan.some(
        (p: any) => p.detail && p.detail.includes("idx_sessions_thread")
      );
      expect(usesIndex).toBe(true);

      sqlite.close();
    });
  });

  describe("tasks table", () => {
    test("inserts a task with cron expression", async () => {
      const { createDB, initDB } = await import("../../src/db");
      const { db, sqlite } = createDB(TEST_DB_PATH);
      await initDB(sqlite);

      const now = Date.now();
      sqlite
        .query(
          `INSERT INTO tasks (id, name, cron_expr, prompt, enabled, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`
        )
        .run("task_001", "Heartbeat", "*/30 * * * *", "Execute /heartbeat", 1, now);

      const row = sqlite
        .query("SELECT * FROM tasks WHERE id = ?")
        .get("task_001") as any;

      expect(row.name).toBe("Heartbeat");
      expect(row.cron_expr).toBe("*/30 * * * *");
      expect(row.enabled).toBe(1);

      sqlite.close();
    });
  });

  describe("logs table", () => {
    test("inserts a log with auto-increment id", async () => {
      const { createDB, initDB } = await import("../../src/db");
      const { db, sqlite } = createDB(TEST_DB_PATH);
      await initDB(sqlite);

      const now = Date.now();
      sqlite
        .query(
          `INSERT INTO logs (level, source, message, created_at)
           VALUES (?, ?, ?, ?)`
        )
        .run("info", "cron", "Heartbeat started", now);

      sqlite
        .query(
          `INSERT INTO logs (level, source, message, metadata, created_at)
           VALUES (?, ?, ?, ?, ?)`
        )
        .run("error", "agent", "CLI timeout", '{"sessionId":"s1"}', now);

      const rows = sqlite.query("SELECT * FROM logs ORDER BY id").all() as any[];
      expect(rows).toHaveLength(2);
      expect(rows[0].id).toBe(1);
      expect(rows[1].id).toBe(2);
      expect(rows[1].metadata).toBe('{"sessionId":"s1"}');

      sqlite.close();
    });
  });
});
