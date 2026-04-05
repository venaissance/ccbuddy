import { Hono } from "hono";
import { readFile } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";
import type { Database } from "bun:sqlite";
import { getCoreMemory, recallMemories } from "./memory";

// ── Routes ──────────────────────────────────────────

export function registerRoutes(
  app: Hono,
  sqlite: Database,
  sessionsDir: string,
  memoryDir: string
) {
  // ── Sessions ────────────────────────────────────

  app.get("/api/sessions", (c) => {
    const rows = sqlite
      .query("SELECT * FROM sessions ORDER BY updated_at DESC LIMIT 50")
      .all();
    return c.json(rows);
  });

  app.get("/api/sessions/:id", (c) => {
    const row = sqlite
      .query("SELECT * FROM sessions WHERE id = ?")
      .get(c.req.param("id"));
    if (!row) return c.json({ error: "Not found" }, 404);
    return c.json(row);
  });

  app.get("/api/sessions/:id/messages", async (c) => {
    const sessionId = c.req.param("id");
    const path = join(sessionsDir, `${sessionId}.jsonl`);

    if (!existsSync(path)) return c.json([]);

    const content = await readFile(path, "utf-8");
    const messages = content
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    return c.json(messages);
  });

  // ── Tasks ───────────────────────────────────────

  app.get("/api/tasks", (c) => {
    const rows = sqlite
      .query("SELECT * FROM tasks ORDER BY created_at DESC")
      .all();
    return c.json(rows);
  });

  app.post("/api/tasks", async (c) => {
    const body = await c.req.json();
    const now = Date.now();

    sqlite
      .query(
        `INSERT INTO tasks (id, name, cron_expr, prompt, enabled, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(
        body.id,
        body.name,
        body.cronExpr || null,
        body.prompt,
        body.enabled !== false ? 1 : 0,
        now
      );

    const task = sqlite.query("SELECT * FROM tasks WHERE id = ?").get(body.id);
    return c.json(task, 201);
  });

  app.patch("/api/tasks/:id", async (c) => {
    const id = c.req.param("id");
    const body = await c.req.json();

    const sets: string[] = [];
    const values: any[] = [];

    if (body.name !== undefined) {
      sets.push("name = ?");
      values.push(body.name);
    }
    if (body.cronExpr !== undefined) {
      sets.push("cron_expr = ?");
      values.push(body.cronExpr);
    }
    if (body.prompt !== undefined) {
      sets.push("prompt = ?");
      values.push(body.prompt);
    }
    if (body.enabled !== undefined) {
      sets.push("enabled = ?");
      values.push(body.enabled ? 1 : 0);
    }

    if (sets.length > 0) {
      values.push(id);
      sqlite.query(`UPDATE tasks SET ${sets.join(", ")} WHERE id = ?`).run(...values);
    }

    const task = sqlite.query("SELECT * FROM tasks WHERE id = ?").get(id);
    return c.json(task);
  });

  app.delete("/api/tasks/:id", (c) => {
    sqlite.query("DELETE FROM tasks WHERE id = ?").run(c.req.param("id"));
    return c.json({ ok: true });
  });

  // ── Logs ────────────────────────────────────────

  app.get("/api/logs", (c) => {
    const limit = Number(c.req.query("limit") || "100");
    const rows = sqlite
      .query("SELECT * FROM logs ORDER BY created_at DESC LIMIT ?")
      .all(limit);
    return c.json(rows);
  });

  // ── Memory ──────────────────────────────────────

  app.get("/api/memory", async (c) => {
    const core = await getCoreMemory(memoryDir);
    return c.json(core);
  });

  app.get("/api/memory/recall", async (c) => {
    const query = c.req.query("q") || "";
    const memories = await recallMemories(query, memoryDir);
    return c.json(memories);
  });
}
