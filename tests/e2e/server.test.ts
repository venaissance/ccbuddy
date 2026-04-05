/**
 * E2E tests: Start a real Hono server, call API endpoints via HTTP.
 * Tests the full stack including static file serving.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { existsSync, rmSync, mkdirSync } from "fs";
import { join } from "path";
import { serve } from "bun";
import { Hono } from "hono";
import { serveStatic } from "hono/bun";

const TEST_DIR = join(import.meta.dir, "../.test-data-e2e");
const TEST_DB_PATH = join(TEST_DIR, "test.db");
const TEST_SESSIONS_DIR = join(TEST_DIR, "sessions");
const TEST_MEMORY_DIR = join(TEST_DIR, "memory");
const PORT = 19876; // random high port

let server: ReturnType<typeof serve>;
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

  // Setup app
  const app = new Hono();
  const { registerRoutes } = await import("../../src/api");
  registerRoutes(app, sqlite, TEST_SESSIONS_DIR, TEST_MEMORY_DIR);

  // Serve dashboard static files if built
  const webDist = join(import.meta.dir, "../../web/dist");
  if (existsSync(webDist)) {
    app.use("/*", serveStatic({ root: webDist }));
  }

  // Start real HTTP server
  server = serve({ port: PORT, fetch: app.fetch });
});

afterAll(() => {
  server?.stop();
  if (sqlite) sqlite.close();
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
});

const BASE = `http://localhost:${PORT}`;

describe("E2E: Real HTTP server", () => {
  test("GET /api/sessions returns JSON array", async () => {
    const res = await fetch(`${BASE}/api/sessions`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");

    const data = await res.json();
    expect(Array.isArray(data)).toBe(true);
  });

  test("GET /api/memory returns core memory", async () => {
    const res = await fetch(`${BASE}/api/memory`);
    expect(res.status).toBe(200);

    const data = await res.json();
    expect(data).toHaveProperty("soul");
    expect(data).toHaveProperty("user");
    expect(data.soul).toContain("SOUL");
  });

  test("POST then GET task round-trip", async () => {
    // Create
    const createRes = await fetch(`${BASE}/api/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: "e2e_task_001",
        name: "E2E Test Task",
        cronExpr: "0 * * * *",
        prompt: "Test prompt",
      }),
    });
    expect(createRes.status).toBe(201);

    // List
    const listRes = await fetch(`${BASE}/api/tasks`);
    const tasks = await listRes.json();
    expect(tasks.some((t: any) => t.id === "e2e_task_001")).toBe(true);

    // Delete
    const delRes = await fetch(`${BASE}/api/tasks/e2e_task_001`, {
      method: "DELETE",
    });
    expect(delRes.status).toBe(200);
  });

  test("GET /api/logs returns log entries", async () => {
    // Seed a log
    const now = Date.now();
    sqlite
      .query("INSERT INTO logs (level, source, message, created_at) VALUES (?, ?, ?, ?)")
      .run("info", "e2e-test", "E2E log entry", now);

    const res = await fetch(`${BASE}/api/logs?limit=10`);
    expect(res.status).toBe(200);

    const logs = await res.json();
    expect(logs.some((l: any) => l.source === "e2e-test")).toBe(true);
  });

  test("GET /api/sessions/:id returns 404 for missing", async () => {
    const res = await fetch(`${BASE}/api/sessions/does-not-exist`);
    expect(res.status).toBe(404);
  });

  test("GET /api/memory/recall works with query", async () => {
    const res = await fetch(`${BASE}/api/memory/recall?q=test`);
    expect(res.status).toBe(200);

    const data = await res.json();
    expect(Array.isArray(data)).toBe(true);
  });

  test("serves static files from web/dist if built", async () => {
    const webDist = join(import.meta.dir, "../../web/dist/index.html");
    if (!existsSync(webDist)) {
      console.log("[e2e] Skipping static file test — web not built");
      return;
    }

    const res = await fetch(`${BASE}/`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("OpenClaw");
  });
});

describe("E2E: Concurrent requests", () => {
  test("handles 10 concurrent session list requests", async () => {
    const requests = Array.from({ length: 10 }, () =>
      fetch(`${BASE}/api/sessions`).then((r) => r.json())
    );

    const results = await Promise.all(requests);
    for (const data of results) {
      expect(Array.isArray(data)).toBe(true);
    }
  });

  test("handles concurrent task create + list", async () => {
    const creates = Array.from({ length: 5 }, (_, i) =>
      fetch(`${BASE}/api/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: `conc_task_${i}`,
          name: `Concurrent ${i}`,
          prompt: `Prompt ${i}`,
        }),
      })
    );

    await Promise.all(creates);

    const listRes = await fetch(`${BASE}/api/tasks`);
    const tasks = await listRes.json();
    const concTasks = tasks.filter((t: any) => t.id.startsWith("conc_task_"));
    expect(concTasks).toHaveLength(5);

    // Cleanup
    await Promise.all(
      concTasks.map((t: any) =>
        fetch(`${BASE}/api/tasks/${t.id}`, { method: "DELETE" })
      )
    );
  });
});
