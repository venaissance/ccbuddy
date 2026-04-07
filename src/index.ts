import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { serve } from "bun";
import { createDB, initDB } from "./db";
import { registerRoutes } from "./api";
import { initMemory } from "./memory";
import { initCron } from "./cron";
import { runAgent } from "./agent";
import { initFeishuWS, addReaction, StreamingCard } from "./feishu-ws";
import { isAuthCommand, handleAuth } from "./feishu-auth";
import { createSessionManager } from "./session";

// ── Config ──────────────────────────────────────────

const PORT = Number(process.env.PORT || 3000);
const DB_PATH = "./data/ccbuddy.db";
const SESSIONS_DIR = "./data/sessions";
const MEMORY_DIR = "./data/memory";

// ── Bootstrap ───────────────────────────────────────

async function main() {
  // 1. Init database
  const { db, sqlite } = createDB(DB_PATH);
  await initDB(sqlite);
  console.log("[init] Database ready");

  // 2. Init memory
  await initMemory(MEMORY_DIR);
  console.log("[init] Memory initialized");

  // 3. Create session manager
  const sessions = createSessionManager(db, sqlite, SESSIONS_DIR);

  // 4. Setup HTTP server
  const app = new Hono();
  registerRoutes(app, sqlite, SESSIONS_DIR, MEMORY_DIR);
  app.use("/*", serveStatic({ root: "./web/dist" }));
  serve({ port: PORT, fetch: app.fetch });
  console.log(`[init] HTTP server on :${PORT}`);

  // 5. Start Feishu WebSocket (skip if no credentials)
  if (process.env.FEISHU_APP_ID && process.env.FEISHU_APP_SECRET) {
    try {
    await initFeishuWS({
      appId: process.env.FEISHU_APP_ID,
      appSecret: process.env.FEISHU_APP_SECRET,
      onMessage: async ({ text, threadId, senderId, messageId, chatId }) => {
        console.log(`[feishu] ${text.slice(0, 60)}`);

        // 0. Handle /auth command — send OAuth card
        if (isAuthCommand(text)) {
          await handleAuth(messageId, chatId);
          return;
        }

        // 1. Instant reaction — zero-latency feedback
        addReaction(messageId, "OnIt");

        // Use chatId as session key — all messages in same chat share context
        // Falls back to threadId for thread replies
        const sessionKey = chatId || threadId;
        const session = await sessions.getOrCreateSession(sessionKey, senderId);
        await sessions.appendMessage(session.id, { role: "user", content: text });
        await sessions.updateStatus(session.id, "active");

        // 2. Create ONE streaming card (typewriter effect)
        const card = new StreamingCard(300);
        await card.create(messageId);

        let fullText = "";

        await runAgent({
          sessionId: session.id,
          prompt: text,
          onStream: async (chunk) => {
            if (chunk.type === "assistant" && chunk.content) {
              fullText += chunk.content;
              await card.pushContent(fullText);
            }
          },
          onEnd: async () => {
            // Flush remaining + switch to completed state (same card!)
            await card.complete(fullText || "（无输出）");
            await sessions.appendMessage(session.id, {
              role: "assistant",
              content: fullText,
            });
            await sessions.updateStatus(session.id, "completed");
            console.log(`[agent] Session ${session.id} completed`);
          },
          onError: async (err) => {
            console.error(`[agent] Error in session ${session.id}:`, err);
            const errText = fullText
              ? fullText + `\n\n---\n⚠️ ${err.message}`
              : `⚠️ 出错了: ${err.message}`;
            await card.error(errText);
            await sessions.updateStatus(session.id, "error");
          },
        });
      },
    });
    console.log("[init] Feishu WebSocket connected");
    } catch (err: any) {
      console.error("[init] Feishu WebSocket failed:", err.message);
      console.error("[init] 请在飞书开发者后台启用长连接模式：");
      console.error("[init]   开发者后台 → 事件与回调 → 订阅方式 → 使用长连接接收事件");
      console.error("[init] Server will continue without Feishu connection.");
    }
  } else {
    console.log("[init] Feishu WebSocket skipped (no credentials)");
  }

  // 6. Start cron scheduler
  initCron(runAgent);
  console.log("[init] Cron scheduler started");

  console.log("CCBuddy daemon started");

  // Graceful shutdown
  process.on("SIGINT", () => {
    console.log("[shutdown] Received SIGINT, shutting down...");
    sqlite.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    sqlite.close();
    process.exit(0);
  });

  process.on("SIGTERM", () => {
    console.log("[shutdown] Received SIGTERM, shutting down...");
    sqlite.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    sqlite.close();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error("[fatal]", err);
  process.exit(1);
});
