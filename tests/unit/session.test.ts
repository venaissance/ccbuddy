import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, rmSync, mkdirSync } from "fs";
import { join } from "path";

const TEST_DIR = join(import.meta.dir, "../.test-data");
const TEST_DB_PATH = join(TEST_DIR, "test.db");
const TEST_SESSIONS_DIR = join(TEST_DIR, "sessions");

describe("session", () => {
  let db: any;
  let sqlite: any;

  beforeEach(async () => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true });
    }
    mkdirSync(TEST_DIR, { recursive: true });

    const dbModule = await import("../../src/db");
    const result = dbModule.createDB(TEST_DB_PATH);
    db = result.db;
    sqlite = result.sqlite;
    await dbModule.initDB(sqlite);
  });

  afterEach(() => {
    if (sqlite) sqlite.close();
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true });
    }
  });

  describe("getOrCreateSession", () => {
    test("creates new session for unknown threadId", async () => {
      const { createSessionManager } = await import("../../src/session");
      const sm = createSessionManager(db, sqlite, TEST_SESSIONS_DIR);

      const session = await sm.getOrCreateSession("thread_001", "user_abc");

      expect(session.id).toMatch(/^sess_/);
      expect(session.threadId).toBe("thread_001");
      expect(session.userId).toBe("user_abc");
      expect(session.status).toBe("idle");
      expect(session.messageCount).toBe(0);
    });

    test("returns existing session for known threadId", async () => {
      const { createSessionManager } = await import("../../src/session");
      const sm = createSessionManager(db, sqlite, TEST_SESSIONS_DIR);

      const session1 = await sm.getOrCreateSession("thread_001", "user_abc");
      const session2 = await sm.getOrCreateSession("thread_001", "user_abc");

      expect(session1.id).toBe(session2.id);
    });

    test("creates separate sessions for different threadIds", async () => {
      const { createSessionManager } = await import("../../src/session");
      const sm = createSessionManager(db, sqlite, TEST_SESSIONS_DIR);

      const s1 = await sm.getOrCreateSession("thread_001", "user_abc");
      const s2 = await sm.getOrCreateSession("thread_002", "user_abc");

      expect(s1.id).not.toBe(s2.id);
    });
  });

  describe("appendMessage", () => {
    test("writes message to JSONL file", async () => {
      const { createSessionManager } = await import("../../src/session");
      const sm = createSessionManager(db, sqlite, TEST_SESSIONS_DIR);

      const session = await sm.getOrCreateSession("thread_001", "user_abc");
      await sm.appendMessage(session.id, {
        role: "user",
        content: "Hello, world!",
      });

      const messages = await sm.getMessages(session.id);
      expect(messages).toHaveLength(1);
      expect(messages[0].role).toBe("user");
      expect(messages[0].content).toBe("Hello, world!");
      expect(messages[0].timestamp).toBeGreaterThan(0);
    });

    test("appends multiple messages in order", async () => {
      const { createSessionManager } = await import("../../src/session");
      const sm = createSessionManager(db, sqlite, TEST_SESSIONS_DIR);

      const session = await sm.getOrCreateSession("thread_001", "user_abc");
      await sm.appendMessage(session.id, { role: "user", content: "Hi" });
      await sm.appendMessage(session.id, { role: "assistant", content: "Hello!" });
      await sm.appendMessage(session.id, { role: "user", content: "How are you?" });

      const messages = await sm.getMessages(session.id);
      expect(messages).toHaveLength(3);
      expect(messages[0].role).toBe("user");
      expect(messages[1].role).toBe("assistant");
      expect(messages[2].content).toBe("How are you?");
    });

    test("increments messageCount in SQLite", async () => {
      const { createSessionManager } = await import("../../src/session");
      const sm = createSessionManager(db, sqlite, TEST_SESSIONS_DIR);

      const session = await sm.getOrCreateSession("thread_001", "user_abc");
      await sm.appendMessage(session.id, { role: "user", content: "msg1" });
      await sm.appendMessage(session.id, { role: "user", content: "msg2" });

      const row = sqlite
        .query("SELECT message_count FROM sessions WHERE id = ?")
        .get(session.id) as any;
      expect(row.message_count).toBe(2);
    });
  });

  describe("getMessages", () => {
    test("returns empty array for non-existent session", async () => {
      const { createSessionManager } = await import("../../src/session");
      const sm = createSessionManager(db, sqlite, TEST_SESSIONS_DIR);

      const messages = await sm.getMessages("nonexistent");
      expect(messages).toEqual([]);
    });
  });

  describe("updateStatus", () => {
    test("updates session status in SQLite", async () => {
      const { createSessionManager } = await import("../../src/session");
      const sm = createSessionManager(db, sqlite, TEST_SESSIONS_DIR);

      const session = await sm.getOrCreateSession("thread_001", "user_abc");
      await sm.updateStatus(session.id, "active");

      const row = sqlite
        .query("SELECT status FROM sessions WHERE id = ?")
        .get(session.id) as any;
      expect(row.status).toBe("active");
    });

    test("updates through full state machine cycle", async () => {
      const { createSessionManager } = await import("../../src/session");
      const sm = createSessionManager(db, sqlite, TEST_SESSIONS_DIR);

      const session = await sm.getOrCreateSession("thread_001", "user_abc");

      for (const status of ["active", "streaming", "completed"] as const) {
        await sm.updateStatus(session.id, status);
        const row = sqlite
          .query("SELECT status FROM sessions WHERE id = ?")
          .get(session.id) as any;
        expect(row.status).toBe(status);
      }
    });
  });
});
