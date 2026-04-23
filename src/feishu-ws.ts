// ── Types ───────────────────────────────────────────

interface FeishuMessage {
  msg_type?: string;
  message_type?: string;
  content: string;
}

// ── Text Extraction ─────────────────────────────────

export function extractText(message: FeishuMessage): string {
  const content = JSON.parse(message.content);
  const msgType = message.message_type || message.msg_type;

  switch (msgType) {
    case "text":
      return content.text.replace(/@_user_\d+/g, "").trim();
    case "post":
      return flattenPostContent(content);
    default:
      return "";
  }
}

function flattenPostContent(content: any): string {
  const title = content.title ? content.title + "\n" : "";
  const body = (content.content || [])
    .map((line: any[]) =>
      line
        .filter((node) => node.tag === "text" || node.tag === "a")
        .map((node) => node.text)
        .join("")
    )
    .join("\n");
  return title + body;
}

// ── Feishu Client ───────────────────────────────────

let larkClient: any = null;
let wsClientRef: any = null;
let currentEventDispatcher: any = null;
let currentWsConfig: { appId: string; appSecret: string } | null = null;
let supervisorStarted = false;

export function getLarkClient() {
  return larkClient;
}

export function getWsClient() {
  return wsClientRef;
}

// ── WebSocket Init ──────────────────────────────────

// ── Card Action Callbacks ──────────────────────────

type CardActionCallback = (action: CardAction) => object | Promise<object | void> | void;

export interface CardAction {
  actionTag: string;
  actionValue: Record<string, string>;
  chatId: string;
  userId: string;
}

const cardActionCallbacks = new Map<string, CardActionCallback>();

/**
 * Register a handler for card button clicks.
 * The actionTag matches the button's `name` field in the card JSON.
 * Return an updated card object to replace the current card, or void to keep it.
 */
export function onCardAction(actionTag: string, handler: CardActionCallback): void {
  cardActionCallbacks.set(actionTag, handler);
}

// ── WebSocket Init ──────────────────────────────────

export async function initFeishuWS(config: {
  appId: string;
  appSecret: string;
  onMessage: (params: {
    text: string;
    threadId: string;
    senderId: string;
    messageId: string;
    chatId: string;
  }) => Promise<void>;
}) {
  const lark = await import("@larksuiteoapi/node-sdk");

  larkClient = new lark.Client({
    appId: config.appId,
    appSecret: config.appSecret,
  });

  const eventDispatcher = new lark.EventDispatcher({}).register({
    "im.message.receive_v1": async (data: any) => {
      try {
        const { message, sender } = data;
        const text = extractText(message);
        if (!text) return;

        const threadId = message.thread_id || message.message_id;
        console.log(`[feishu] ${text.slice(0, 60)}`);

        await config.onMessage({
          text,
          threadId,
          senderId: sender.sender_id.open_id,
          messageId: message.message_id,
          chatId: message.chat_id,
        });
      } catch (err) {
        console.error("[feishu] Error handling message:", err);
      }
    },
    "card.action.trigger": async (data: any) => {
      try {
        const action = data?.event?.action || data?.action;
        const context = data?.event?.context || data?.context;
        const operator = data?.event?.operator || data?.operator;
        if (!action) {
          console.log(`[feishu] Card action: no action in data, keys=${Object.keys(data || {})}`);
          return;
        }

        const value = action.value || {};
        const actionName = value.action || "";
        const chatId = context?.open_chat_id || "";
        const messageId = context?.open_message_id || "";
        const userId = operator?.open_id || "";

        console.log(`[feishu] Card action: ${actionName} value=${JSON.stringify(value)}`);

        const handler = cardActionCallbacks.get(actionName);
        if (handler) {
          const result = await handler({ actionTag: actionName, actionValue: value, chatId, userId });
          if (!result) return;

          const { card: updatedCard, toastText } = result as { card?: any; toastText?: string };

          // Build callback response per Feishu spec:
          // { card: { type: "raw", data: cardJson }, toast: { type, content } }
          const response: any = {};
          if (updatedCard) {
            response.card = { type: "raw", data: updatedCard };
          }
          if (toastText) {
            response.toast = { type: "success", content: toastText };
          }

          console.log(`[feishu] Card action response: toast=${toastText || "none"}, hasCard=${!!updatedCard}`);
          return response;
        }
      } catch (err) {
        console.error("[feishu] Error handling card action:", err);
      }
    },
  } as any);

  currentEventDispatcher = eventDispatcher;
  currentWsConfig = { appId: config.appId, appSecret: config.appSecret };

  await createAndStartWs(lark);

  if (!supervisorStarted) {
    supervisorStarted = true;
    void runNetworkSupervisor(lark);
  }

  return { client: larkClient, wsClient: wsClientRef };
}

// ── WS rebuild + network supervisor ─────────────────
//
// Feishu SDK's autoReconnect is bounded by server-provided `reconnectCount`
// (observed: 4 retries) and has no public "gave up" event. After exhausting
// retries, the WSClient goes silent but the process stays up — PM2 has no
// way to notice. To survive long network outages (WiFi drop, VPN hiccup,
// laptop sleep), we probe Feishu HTTP every 30s and rebuild the WSClient
// on any down→up transition. If reachability stays broken for 15 min, we
// exit(1) so PM2 restarts with a fresh environment.

async function createAndStartWs(lark: any): Promise<void> {
  if (!currentWsConfig || !currentEventDispatcher) {
    throw new Error("[ws] config / dispatcher not initialized");
  }
  const fresh = new lark.WSClient({
    appId: currentWsConfig.appId,
    appSecret: currentWsConfig.appSecret,
    autoReconnect: true,
  });
  await fresh.start({ eventDispatcher: currentEventDispatcher });
  wsClientRef = fresh;
}

async function runNetworkSupervisor(lark: any): Promise<void> {
  const PROBE_INTERVAL_MS = 30_000;
  const DOWNTIME_THRESHOLD = 2; // 2 consecutive failures = truly down
  const GIVE_UP_AFTER_MS = 15 * 60_000;

  let consecutiveDown = 0;
  let downSince = 0;

  while (true) {
    await new Promise((r) => setTimeout(r, PROBE_INTERVAL_MS));

    const reachable = await probeFeishu();
    if (reachable) {
      if (consecutiveDown >= DOWNTIME_THRESHOLD) {
        const downFor = Math.round((Date.now() - downSince) / 1000);
        console.warn(
          `[ws-supervisor] network recovered (was down ${downFor}s), rebuilding WS client`
        );
        try {
          if (wsClientRef) {
            try {
              wsClientRef.close({ force: true });
            } catch {}
          }
          await createAndStartWs(lark);
          console.log("[ws-supervisor] WS client rebuilt");
        } catch (err: any) {
          console.error(
            "[ws-supervisor] rebuild failed, will retry next cycle:",
            err?.message || err
          );
          continue;
        }
      }
      consecutiveDown = 0;
      downSince = 0;
    } else {
      if (consecutiveDown === 0) downSince = Date.now();
      consecutiveDown++;
      const downMs = Date.now() - downSince;
      if (downMs > GIVE_UP_AFTER_MS) {
        console.error(
          `[ws-supervisor] Feishu unreachable for ${Math.round(downMs / 60_000)}m — exit(1) for PM2 restart`
        );
        process.exit(1);
      }
    }
  }
}

async function probeFeishu(): Promise<boolean> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 5_000);
  try {
    const resp = await fetch("https://open.feishu.cn/", {
      method: "HEAD",
      signal: ctrl.signal,
    });
    return resp.status < 500;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

// ── Reaction ────────────────────────────────────────

export async function addReaction(messageId: string, emoji = "OnIt"): Promise<void> {
  if (!larkClient) return;
  try {
    await larkClient.im.v1.messageReaction.create({
      path: { message_id: messageId },
      data: { reaction_type: { emoji_type: emoji } },
    });
  } catch {
    // Non-critical
  }
}

// ── Streaming Card Controller ───────────────────────
//
// Single card lifecycle:
//   create (streaming_mode) → stream content (typewriter) → finalize (completed)
//
// Uses CardKit API for native typewriter effect:
//   1. cardkit.v1.card.create — create card with streaming_mode: true
//   2. im.message.reply — send card as message
//   3. cardkit.v1.cardElement.content — push text (platform renders typewriter)
//   4. cardkit.v1.card.settings — disable streaming mode
//   5. cardkit.v1.card.update — set final state (header, remove spinner)

const MAIN_ELEMENT_ID = "main_content";
const STATUS_ELEMENT_ID = "status_note";

export class StreamingCard {
  private cardId: string | null = null;
  private messageId: string | null = null;
  private replyToMsgId: string | null = null;
  private sequence = 0;
  private lastContentHash = "";
  private lastFlush = 0;
  private lastFlushedLen = 0;
  private minInterval: number;
  private minDelta: number;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private dirty = false;
  private text = "";
  private useFallback = false;
  private state: "idle" | "creating" | "streaming" | "done" = "idle";
  private thinkingStartedAt = 0;
  private thinkingTimer: ReturnType<typeof setInterval> | null = null;

  constructor(minInterval = 300, minDelta = 30) {
    this.minInterval = minInterval;
    this.minDelta = minDelta;
  }

  private nextSeq(): number {
    return ++this.sequence;
  }

  /** Step 0: Register reply target. Card is created lazily on first content. */
  async create(replyToMsgId: string): Promise<void> {
    this.replyToMsgId = replyToMsgId;
  }

  /** Called when thinking starts — lazily creates card with thinking indicator. */
  async setThinking(): Promise<void> {
    this.thinkingStartedAt = Date.now();
    if (this.state === "idle") {
      await this.createCardNow("💭 思考中...", "");
    }
  }

  /** Actually create the card (called lazily from setThinking or pushContent). */
  private async createCardNow(headerText: string, initialContent: string): Promise<void> {
    if (!larkClient || !this.replyToMsgId || this.state !== "idle") return;
    this.state = "creating";

    const cardJson = {
      schema: "2.0",
      config: {
        wide_screen_mode: true,
        streaming_mode: true,
        streaming_config: {
          print_frequency_ms: { default: 50 },
          print_step: { default: 2 },
          print_strategy: "fast",
        },
      },
      header: {
        title: { tag: "plain_text", content: headerText },
        template: "wathet",
      },
      body: {
        elements: [
          { tag: "markdown", content: initialContent || "...", element_id: MAIN_ELEMENT_ID },
          { tag: "markdown", content: "⏳ 生成中...", element_id: STATUS_ELEMENT_ID, text_size: "notation" },
        ],
      },
    };

    try {
      const createResp = await larkClient.cardkit.v1.card.create({
        data: { type: "card_json", data: JSON.stringify(cardJson) },
      });
      this.cardId = createResp?.data?.card_id;
      if (!this.cardId) throw new Error("No card_id returned");
      this.sequence = 1;

      const sendResp = await larkClient.im.message.reply({
        path: { message_id: this.replyToMsgId },
        data: {
          msg_type: "interactive",
          content: JSON.stringify({ type: "card", data: { card_id: this.cardId } }),
        },
      });
      this.messageId = sendResp?.data?.message_id || null;
      this.state = "streaming";
      console.log(`[card] Created streaming card ${this.cardId}`);
    } catch (err) {
      console.warn("[card] CardKit unavailable, falling back to message.patch");
      this.useFallback = true;
      await this.createFallback();
      this.state = "streaming";
    }
  }

  /** Fallback: create card via im.message.reply (no streaming_mode) */
  private async createFallback(): Promise<void> {
    if (!this.replyToMsgId) return;
    const card = buildSimpleCard("...", "streaming");
    const resp = await larkClient.im.message.reply({
      path: { message_id: this.replyToMsgId },
      data: { msg_type: "interactive", content: JSON.stringify(card) },
    });
    this.messageId = resp?.data?.message_id || null;
  }

  /** Step 2: Push text content. Lazily creates card if needed. Smart flush. */
  async pushContent(fullText: string): Promise<void> {
    // Lazy card creation on first text
    if (this.state === "idle") {
      const elapsed = this.thinkingStartedAt ? `${((Date.now() - this.thinkingStartedAt) / 1000).toFixed(1)}s` : "";
      await this.createCardNow(elapsed ? `✍️ 生成中 (思考 ${elapsed})` : "✍️ 生成中...", fullText);
      this.text = fullText;
      this.lastFlushedLen = fullText.length;
      this.lastFlush = Date.now();
      // Stop thinking timer
      if (this.thinkingTimer) { clearInterval(this.thinkingTimer); this.thinkingTimer = null; }
      return;
    }

    // Wait for card creation to finish
    if (this.state === "creating") {
      this.text = fullText;
      this.dirty = true;
      return;
    }

    // Update header on first text after thinking
    if (this.thinkingStartedAt && this.cardId && larkClient && !this.useFallback) {
      const elapsed = ((Date.now() - this.thinkingStartedAt) / 1000).toFixed(1);
      this.thinkingStartedAt = 0; // Only once
      try {
        await larkClient.cardkit.v1.card.update({
          path: { card_id: this.cardId },
          data: {
            card: { type: "card_json", data: JSON.stringify({
              schema: "2.0",
              config: { wide_screen_mode: true, streaming_mode: true,
                streaming_config: { print_frequency_ms: { default: 50 }, print_step: { default: 2 }, print_strategy: "fast" } },
              header: { title: { tag: "plain_text", content: `✍️ 生成中 (思考 ${elapsed}s)` }, template: "wathet" },
              body: { elements: [
                { tag: "markdown", content: fullText || "...", element_id: MAIN_ELEMENT_ID },
                { tag: "markdown", content: "⏳ 生成中...", element_id: STATUS_ELEMENT_ID, text_size: "notation" },
              ] },
            }) },
            sequence: this.nextSeq(),
          },
        });
      } catch { /* non-critical */ }
    }

    this.text = fullText;
    this.dirty = true;

    const newChars = fullText.length - this.lastFlushedLen;
    const elapsed = Date.now() - this.lastFlush;

    if (newChars >= this.minDelta && elapsed >= this.minInterval) {
      if (this.flushTimer) { clearTimeout(this.flushTimer); this.flushTimer = null; }
      await this.flush();
      return;
    }

    if (!this.flushTimer) {
      this.flushTimer = setTimeout(async () => {
        this.flushTimer = null;
        await this.flush();
      }, this.minInterval);
    }
  }

  /** Force flush current content. */
  async flush(): Promise<void> {
    if (!this.dirty) return;
    this.dirty = false;
    this.lastFlush = Date.now();
    this.lastFlushedLen = this.text.length;

    if (this.useFallback) {
      await this.flushFallback("streaming");
      return;
    }

    if (!this.cardId || !larkClient) return;

    const hash = simpleHash(this.text);
    if (hash === this.lastContentHash) return;

    try {
      await larkClient.cardkit.v1.cardElement.content({
        path: { card_id: this.cardId, element_id: MAIN_ELEMENT_ID },
        data: { content: this.text, sequence: this.nextSeq() },
      });
      this.lastContentHash = hash;
    } catch (err: any) {
      const code = err?.code ?? err?.response?.data?.code;
      if (code === 200850 || code === 300309) {
        // Streaming timeout — re-enable and retry
        await this.reEnableStreaming();
        try {
          await larkClient.cardkit.v1.cardElement.content({
            path: { card_id: this.cardId, element_id: MAIN_ELEMENT_ID },
            data: { content: this.text, sequence: this.nextSeq() },
          });
          this.lastContentHash = hash;
        } catch {
          // Give up streaming, switch to fallback
          this.useFallback = true;
        }
      } else {
        console.debug("[card] Stream push failed:", err?.message);
      }
    }
  }

  /** Step 3: Finalize card — disable streaming, set completed state. */
  async complete(finalText: string, statusline?: string): Promise<void> {
    if (this.thinkingTimer) { clearInterval(this.thinkingTimer); this.thinkingTimer = null; }
    if (this.flushTimer) { clearTimeout(this.flushTimer); this.flushTimer = null; }
    this.state = "done";
    this.text = finalText;

    // If card was never created, create it now with final content
    if (!this.cardId && !this.messageId) {
      if (!this.replyToMsgId || !larkClient) return;
      const card = buildSimpleCard(finalText || "（无输出）", "completed", statusline);
      await larkClient.im.message.reply({
        path: { message_id: this.replyToMsgId },
        data: { msg_type: "interactive", content: JSON.stringify(card) },
      });
      return;
    }

    if (this.useFallback) {
      await this.flushFallback("completed", statusline);
      return;
    }

    if (!this.cardId || !larkClient) return;

    try {
      // Disable streaming mode
      await larkClient.cardkit.v1.card.settings({
        path: { card_id: this.cardId },
        data: {
          settings: JSON.stringify({ config: { streaming_mode: false } }),
          sequence: this.nextSeq(),
        },
      });

      // Build final elements
      const elements: any[] = [
        { tag: "markdown", content: finalText, element_id: MAIN_ELEMENT_ID },
      ];

      if (statusline) {
        elements.push({
          tag: "markdown",
          content: statusline,
          text_size: "notation",
        });
      }

      // Update to final state
      const finalCard = {
        schema: "2.0",
        config: { wide_screen_mode: true },
        header: {
          title: { tag: "plain_text", content: "✅ 回复" },
          template: "indigo",
        },
        body: { elements },
      };

      await larkClient.cardkit.v1.card.update({
        path: { card_id: this.cardId },
        data: {
          card: { type: "card_json", data: JSON.stringify(finalCard) },
          sequence: this.nextSeq(),
        },
      });
      console.log(`[card] Completed ${this.cardId}`);
    } catch (err: any) {
      console.error("[card] Complete failed:", err?.message);
      this.useFallback = true;
      await this.flushFallback("completed", statusline);
    }
  }

  /** Set error state. */
  async error(text: string): Promise<void> {
    this.text = text;

    if (this.useFallback) {
      await this.flushFallback("error");
      return;
    }

    if (!this.cardId || !larkClient) return;

    try {
      await larkClient.cardkit.v1.card.settings({
        path: { card_id: this.cardId },
        data: {
          settings: JSON.stringify({ config: { streaming_mode: false } }),
          sequence: this.nextSeq(),
        },
      });

      const errorCard = {
        schema: "2.0",
        config: { wide_screen_mode: true },
        header: {
          title: { tag: "plain_text", content: "⚠️ 出错了" },
          template: "red",
        },
        body: {
          elements: [{ tag: "markdown", content: text, element_id: MAIN_ELEMENT_ID }],
        },
      };

      await larkClient.cardkit.v1.card.update({
        path: { card_id: this.cardId },
        data: {
          card: { type: "card_json", data: JSON.stringify(errorCard) },
          sequence: this.nextSeq(),
        },
      });
    } catch {
      this.useFallback = true;
      await this.flushFallback("error");
    }
  }

  getMessageId(): string | null {
    return this.messageId;
  }

  private async reEnableStreaming(): Promise<void> {
    if (!this.cardId || !larkClient) return;
    await larkClient.cardkit.v1.card.settings({
      path: { card_id: this.cardId },
      data: {
        settings: JSON.stringify({
          config: {
            streaming_mode: true,
            streaming_config: {
              print_frequency_ms: { default: 50 },
              print_step: { default: 2 },
              print_strategy: "fast",
            },
          },
        }),
        sequence: this.nextSeq(),
      },
    });
  }

  /** Fallback: update card via im.message.patch */
  private async flushFallback(state: "streaming" | "completed" | "error", statusline?: string): Promise<void> {
    if (!this.messageId || !larkClient) return;
    try {
      const card = buildSimpleCard(this.text, state, statusline);
      await larkClient.im.message.patch({
        path: { message_id: this.messageId },
        data: { content: JSON.stringify(card) },
      });
    } catch (err: any) {
      if (err?.response?.status !== 400) {
        console.error("[card] Fallback update failed:", err?.message);
      }
    }
  }
}

// ── Simple Card Builder (for fallback) ──────────────

function buildSimpleCard(text: string, state: "streaming" | "completed" | "error", statusline?: string): object {
  const headerMap = {
    streaming: { template: "wathet", title: "💭 思考中..." },
    completed: { template: "indigo", title: "✅ 回复" },
    error: { template: "red", title: "⚠️ 出错了" },
  };
  const h = headerMap[state];
  const elements: any[] = [];
  if (text) elements.push({ tag: "markdown", content: text });
  if (state === "streaming") {
    elements.push({ tag: "note", elements: [{ tag: "plain_text", content: "⏳ 生成中..." }] });
  }
  if (state === "completed" && statusline) {
    elements.push({ tag: "markdown", content: statusline, text_size: "notation" });
  }
  return {
    config: { wide_screen_mode: true },
    header: { title: { tag: "plain_text", content: h.title }, template: h.template },
    elements,
  };
}

function simpleHash(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  }
  return h.toString(36);
}
