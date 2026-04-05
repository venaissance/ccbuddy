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

export function getLarkClient() {
  return larkClient;
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
  });

  const wsClient = new lark.WSClient({
    appId: config.appId,
    appSecret: config.appSecret,
  });

  await wsClient.start({ eventDispatcher });
  return { client: larkClient, wsClient };
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
  private sequence = 0;
  private lastContentHash = "";
  private lastFlush = 0;
  private debounceMs: number;
  private dirty = false;
  private text = "";
  private useFallback = false;

  constructor(debounceMs = 300) {
    this.debounceMs = debounceMs;
  }

  private nextSeq(): number {
    return ++this.sequence;
  }

  /** Step 1: Create card + send as reply. Call once. */
  async create(replyToMsgId: string): Promise<void> {
    if (!larkClient) return;

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
        title: { tag: "plain_text", content: "💭 思考中..." },
        template: "wathet",
      },
      body: {
        elements: [
          { tag: "markdown", content: "...", element_id: MAIN_ELEMENT_ID },
          { tag: "markdown", content: "⏳ 生成中...", element_id: STATUS_ELEMENT_ID, text_size: "notation" },
        ],
      },
    };

    try {
      // Create CardKit card
      const createResp = await larkClient.cardkit.v1.card.create({
        data: { type: "card_json", data: JSON.stringify(cardJson) },
      });
      this.cardId = createResp?.data?.card_id;
      if (!this.cardId) throw new Error("No card_id returned");
      this.sequence = 1;

      // Send as reply message
      const sendResp = await larkClient.im.message.reply({
        path: { message_id: replyToMsgId },
        data: {
          msg_type: "interactive",
          content: JSON.stringify({ type: "card", data: { card_id: this.cardId } }),
        },
      });
      this.messageId = sendResp?.data?.message_id || null;
      console.log(`[card] Created streaming card ${this.cardId}`);
    } catch (err) {
      console.warn("[card] CardKit unavailable, falling back to message.patch");
      this.useFallback = true;
      // Fallback: create plain interactive card
      await this.createFallback(replyToMsgId);
    }
  }

  /** Fallback: create card via im.message.reply (no streaming_mode) */
  private async createFallback(replyToMsgId: string): Promise<void> {
    const card = buildSimpleCard("...", "streaming");
    const resp = await larkClient.im.message.reply({
      path: { message_id: replyToMsgId },
      data: { msg_type: "interactive", content: JSON.stringify(card) },
    });
    this.messageId = resp?.data?.message_id || null;
  }

  /** Step 2: Push text content. Debounced, call repeatedly. */
  async pushContent(fullText: string): Promise<void> {
    this.text = fullText;
    this.dirty = true;

    if (Date.now() - this.lastFlush < this.debounceMs) return;
    await this.flush();
  }

  /** Force flush current content. */
  async flush(): Promise<void> {
    if (!this.dirty) return;
    this.dirty = false;
    this.lastFlush = Date.now();

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
  async complete(finalText: string): Promise<void> {
    this.text = finalText;

    if (this.useFallback) {
      await this.flushFallback("completed");
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

      // Update to final state
      const finalCard = {
        schema: "2.0",
        config: { wide_screen_mode: true },
        header: {
          title: { tag: "plain_text", content: "✅ 回复" },
          template: "indigo",
        },
        body: {
          elements: [
            { tag: "markdown", content: finalText, element_id: MAIN_ELEMENT_ID },
          ],
        },
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
      // Last resort: try fallback
      this.useFallback = true;
      await this.flushFallback("completed");
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
  private async flushFallback(state: "streaming" | "completed" | "error"): Promise<void> {
    if (!this.messageId || !larkClient) return;
    try {
      const card = buildSimpleCard(this.text, state);
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

function buildSimpleCard(text: string, state: "streaming" | "completed" | "error"): object {
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
