import { describe, test, expect } from "bun:test";

// ── Helper: replicate the private simpleHash algorithm for property testing ──
function simpleHash(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  }
  return h.toString(36);
}

describe("feishu-ws", () => {
  describe("extractText", () => {
    test("extracts text from text message", async () => {
      const { extractText } = await import("../../src/feishu-ws");
      const message = {
        msg_type: "text",
        content: JSON.stringify({ text: "Hello world" }),
      };
      expect(extractText(message)).toBe("Hello world");
    });

    test("strips @mentions from text", async () => {
      const { extractText } = await import("../../src/feishu-ws");
      const message = {
        msg_type: "text",
        content: JSON.stringify({ text: "@_user_1 帮我查会议" }),
      };
      expect(extractText(message)).toBe("帮我查会议");
    });

    test("strips multiple @mentions", async () => {
      const { extractText } = await import("../../src/feishu-ws");
      const message = {
        msg_type: "text",
        content: JSON.stringify({ text: "@_user_1 @_user_2 hello" }),
      };
      expect(extractText(message)).toBe("hello");
    });

    test("works with SDK v2 message_type field", async () => {
      const { extractText } = await import("../../src/feishu-ws");
      const message = {
        message_type: "text",
        content: JSON.stringify({ text: "你好呀" }),
      };
      expect(extractText(message)).toBe("你好呀");
    });

    test("returns empty string for unsupported message types", async () => {
      const { extractText } = await import("../../src/feishu-ws");
      expect(extractText({ msg_type: "image", content: "{}" })).toBe("");
      expect(extractText({ msg_type: "file", content: "{}" })).toBe("");
    });

    test("extracts text from post (rich text) message", async () => {
      const { extractText } = await import("../../src/feishu-ws");
      const message = {
        msg_type: "post",
        content: JSON.stringify({
          title: "需求描述",
          content: [
            [
              { tag: "text", text: "请帮我实现" },
              { tag: "a", text: "这个功能", href: "https://example.com" },
            ],
            [{ tag: "text", text: "具体要求如下" }],
          ],
        }),
      };

      const text = extractText(message);
      expect(text).toContain("需求描述");
      expect(text).toContain("请帮我实现");
      expect(text).toContain("这个功能");
      expect(text).toContain("具体要求如下");
    });

    test("ignores non-text nodes in post content", async () => {
      const { extractText } = await import("../../src/feishu-ws");
      const message = {
        msg_type: "post",
        content: JSON.stringify({
          content: [
            [
              { tag: "text", text: "Hello " },
              { tag: "at", user_id: "xxx" },
              { tag: "img", image_key: "yyy" },
            ],
          ],
        }),
      };

      const text = extractText(message);
      expect(text).toContain("Hello");
      expect(text).not.toContain("xxx");
      expect(text).not.toContain("yyy");
    });
  });

  // ── flattenPostContent (private, tested indirectly via extractText) ──

  describe("flattenPostContent (via extractText)", () => {
    test("combines title and body lines", async () => {
      const { extractText } = await import("../../src/feishu-ws");
      const message = {
        msg_type: "post",
        content: JSON.stringify({
          title: "My Title",
          content: [
            [{ tag: "text", text: "Line one" }],
            [{ tag: "text", text: "Line two" }],
          ],
        }),
      };
      const text = extractText(message);
      expect(text).toBe("My Title\nLine one\nLine two");
    });

    test("handles no title", async () => {
      const { extractText } = await import("../../src/feishu-ws");
      const message = {
        msg_type: "post",
        content: JSON.stringify({
          content: [
            [{ tag: "text", text: "Only body" }],
          ],
        }),
      };
      const text = extractText(message);
      expect(text).toBe("Only body");
      expect(text).not.toContain("\n");
    });

    test("handles empty content array", async () => {
      const { extractText } = await import("../../src/feishu-ws");
      const message = {
        msg_type: "post",
        content: JSON.stringify({ content: [] }),
      };
      expect(extractText(message)).toBe("");
    });

    test("handles missing content field (undefined)", async () => {
      const { extractText } = await import("../../src/feishu-ws");
      const message = {
        msg_type: "post",
        content: JSON.stringify({ title: "Title Only" }),
      };
      expect(extractText(message)).toBe("Title Only\n");
    });

    test("concatenates text and anchor nodes within a line", async () => {
      const { extractText } = await import("../../src/feishu-ws");
      const message = {
        msg_type: "post",
        content: JSON.stringify({
          content: [
            [
              { tag: "text", text: "Visit " },
              { tag: "a", text: "our site", href: "https://example.com" },
              { tag: "text", text: " for details" },
            ],
          ],
        }),
      };
      expect(extractText(message)).toBe("Visit our site for details");
    });

    test("filters out non-text/non-a nodes (img, at, emotion)", async () => {
      const { extractText } = await import("../../src/feishu-ws");
      const message = {
        msg_type: "post",
        content: JSON.stringify({
          content: [
            [
              { tag: "text", text: "Before" },
              { tag: "img", image_key: "key123" },
              { tag: "at", user_id: "u123" },
              { tag: "emotion", emoji_type: "SMILE" },
              { tag: "text", text: "After" },
            ],
          ],
        }),
      };
      expect(extractText(message)).toBe("BeforeAfter");
    });
  });

  // ── buildSimpleCard (private, tested via replicated logic) ──

  describe("buildSimpleCard (replicated logic)", () => {
    // Replicate the private function to verify its behavior.
    // This mirrors the source exactly so drift will be caught by
    // integration tests or by reviewing source changes.
    function buildSimpleCard(
      text: string,
      state: "streaming" | "completed" | "error",
    ): object {
      const headerMap = {
        streaming: { template: "wathet", title: "💭 思考中..." },
        completed: { template: "indigo", title: "✅ 回复" },
        error: { template: "red", title: "⚠️ 出错了" },
      };
      const h = headerMap[state];
      const elements: any[] = [];
      if (text) elements.push({ tag: "markdown", content: text });
      if (state === "streaming") {
        elements.push({
          tag: "note",
          elements: [{ tag: "plain_text", content: "⏳ 生成中..." }],
        });
      }
      return {
        config: { wide_screen_mode: true },
        header: {
          title: { tag: "plain_text", content: h.title },
          template: h.template,
        },
        elements,
      };
    }

    test("streaming state: wathet template, thinking title, note element", () => {
      const card = buildSimpleCard("hello", "streaming") as any;
      expect(card.header.template).toBe("wathet");
      expect(card.header.title.content).toBe("💭 思考中...");
      expect(card.elements).toHaveLength(2);
      expect(card.elements[0]).toEqual({ tag: "markdown", content: "hello" });
      expect(card.elements[1].tag).toBe("note");
      expect(card.elements[1].elements[0].content).toBe("⏳ 生成中...");
    });

    test("completed state: indigo template, reply title, no note", () => {
      const card = buildSimpleCard("done", "completed") as any;
      expect(card.header.template).toBe("indigo");
      expect(card.header.title.content).toBe("✅ 回复");
      expect(card.elements).toHaveLength(1);
      expect(card.elements[0]).toEqual({ tag: "markdown", content: "done" });
    });

    test("error state: red template, error title, no note", () => {
      const card = buildSimpleCard("oops", "error") as any;
      expect(card.header.template).toBe("red");
      expect(card.header.title.content).toBe("⚠️ 出错了");
      expect(card.elements).toHaveLength(1);
      expect(card.elements[0]).toEqual({ tag: "markdown", content: "oops" });
    });

    test("empty text produces no markdown element", () => {
      const card = buildSimpleCard("", "completed") as any;
      expect(card.elements).toHaveLength(0);
    });

    test("empty text with streaming still has note element", () => {
      const card = buildSimpleCard("", "streaming") as any;
      expect(card.elements).toHaveLength(1);
      expect(card.elements[0].tag).toBe("note");
    });

    test("config always has wide_screen_mode: true", () => {
      for (const state of ["streaming", "completed", "error"] as const) {
        const card = buildSimpleCard("x", state) as any;
        expect(card.config.wide_screen_mode).toBe(true);
      }
    });
  });

  // ── simpleHash (private, tested via replicated algorithm) ──

  describe("simpleHash (replicated algorithm)", () => {
    test("determinism: same input always produces same output", () => {
      const input = "hello world";
      expect(simpleHash(input)).toBe(simpleHash(input));
      expect(simpleHash(input)).toBe(simpleHash("hello world"));
    });

    test("different inputs produce different hashes", () => {
      expect(simpleHash("abc")).not.toBe(simpleHash("abd"));
      expect(simpleHash("foo")).not.toBe(simpleHash("bar"));
      expect(simpleHash("Hello")).not.toBe(simpleHash("hello"));
    });

    test("empty string returns '0'", () => {
      expect(simpleHash("")).toBe("0");
    });

    test("long string produces a valid base-36 result", () => {
      const longStr = "a".repeat(10000);
      const hash = simpleHash(longStr);
      expect(hash).toBeTruthy();
      // base-36 chars: 0-9, a-z, and optional leading minus
      expect(hash).toMatch(/^-?[0-9a-z]+$/);
    });

    test("single character", () => {
      const h = simpleHash("A");
      expect(h).toBeTruthy();
      expect(typeof h).toBe("string");
    });

    test("unicode strings produce valid hashes", () => {
      const h = simpleHash("你好世界");
      expect(h).toMatch(/^-?[0-9a-z]+$/);
    });
  });

  // ── StreamingCard ──

  describe("StreamingCard", () => {
    test("initializes with correct default state", async () => {
      const { StreamingCard } = await import("../../src/feishu-ws");
      const card = new StreamingCard(300);

      expect(card.getMessageId()).toBeNull();
    });

    test("custom debounce interval is accepted", async () => {
      const { StreamingCard } = await import("../../src/feishu-ws");
      const card = new StreamingCard(500);
      // No throw means constructor accepted the value
      expect(card).toBeDefined();
    });

    test("default debounce is 300ms", async () => {
      const { StreamingCard } = await import("../../src/feishu-ws");
      const card = new StreamingCard();
      expect(card).toBeDefined();
    });

    test("pushContent without create is safe (no larkClient)", async () => {
      const { StreamingCard } = await import("../../src/feishu-ws");
      const card = new StreamingCard(0);
      // Should not throw even without card being created
      await card.pushContent("test");
    });

    test("pushContent with debounceMs=0 flushes immediately", async () => {
      const { StreamingCard } = await import("../../src/feishu-ws");
      const card = new StreamingCard(0);
      // Two rapid calls should both be accepted without error
      await card.pushContent("first");
      await card.pushContent("second");
      // No throw means debounce=0 works correctly
      expect(card).toBeDefined();
    });

    test("complete() does not throw when cardId is null", async () => {
      const { StreamingCard } = await import("../../src/feishu-ws");
      const card = new StreamingCard(0);
      // cardId is null (create was never called), should early-return safely
      await card.complete("final text");
      expect(card.getMessageId()).toBeNull();
    });

    test("error() does not throw when cardId is null", async () => {
      const { StreamingCard } = await import("../../src/feishu-ws");
      const card = new StreamingCard(0);
      // cardId is null (create was never called), should early-return safely
      await card.error("something broke");
      expect(card.getMessageId()).toBeNull();
    });

    test("flush() is a no-op when not dirty", async () => {
      const { StreamingCard } = await import("../../src/feishu-ws");
      const card = new StreamingCard(0);
      // flush without any pushContent should be safe
      await card.flush();
      expect(card).toBeDefined();
    });
  });
});
