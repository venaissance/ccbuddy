import { describe, test, expect, beforeEach, mock, spyOn } from "bun:test";
import { EventEmitter } from "events";

// ── Mock child_process.spawn ────────────────────────
// Must be set up before importing feishu-auth so the module picks up the mock.

let spawnMock: ReturnType<typeof mock>;

function createMockProcess() {
  const proc = Object.assign(new EventEmitter(), {
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    kill: mock(() => {}),
  });
  return proc;
}

mock.module("child_process", () => ({
  spawn: (...args: any[]) => spawnMock(...args),
}));

// ── Mock getLarkClient from feishu-ws ───────────────

let mockLarkClient: any = null;

// Use a lazy require so the real module's other exports (extractText, StreamingCard, etc.)
// are preserved for other test files sharing this process.
const realFeishuWs = require("../../src/feishu-ws");
mock.module("../../src/feishu-ws", () => ({
  ...realFeishuWs,
  getLarkClient: () => mockLarkClient,
}));

// ── Import after mocks ─────────────────────────────

const { isAuthCommand, handleAuth } = await import("../../src/feishu-auth");

// ════════════════════════════════════════════════════
// Tests
// ════════════════════════════════════════════════════

describe("feishu-auth", () => {
  beforeEach(() => {
    spawnMock = mock(() => createMockProcess());
    mockLarkClient = null;
  });

  // ── isAuthCommand ─────────────────────────────────

  describe("isAuthCommand", () => {
    test("recognizes /auth", () => {
      expect(isAuthCommand("/auth")).toBe(true);
    });

    test("recognizes auth (without slash)", () => {
      expect(isAuthCommand("auth")).toBe(true);
    });

    test("recognizes 授权 (Chinese)", () => {
      expect(isAuthCommand("授权")).toBe(true);
    });

    test("recognizes /授权 (Chinese with slash)", () => {
      expect(isAuthCommand("/授权")).toBe(true);
    });

    test("is case insensitive", () => {
      expect(isAuthCommand("/AUTH")).toBe(true);
      expect(isAuthCommand("Auth")).toBe(true);
      expect(isAuthCommand("/Auth")).toBe(true);
      expect(isAuthCommand("AUTH")).toBe(true);
    });

    test("trims whitespace", () => {
      expect(isAuthCommand("  /auth  ")).toBe(true);
      expect(isAuthCommand("\t授权\n")).toBe(true);
      expect(isAuthCommand(" auth ")).toBe(true);
    });

    test("rejects text mixed with other words", () => {
      expect(isAuthCommand("please /auth now")).toBe(false);
      expect(isAuthCommand("auth please")).toBe(false);
      expect(isAuthCommand("hello 授权")).toBe(false);
      expect(isAuthCommand("/auth extra")).toBe(false);
    });

    test("rejects empty string", () => {
      expect(isAuthCommand("")).toBe(false);
    });

    test("rejects whitespace-only string", () => {
      expect(isAuthCommand("   ")).toBe(false);
      expect(isAuthCommand("\t\n")).toBe(false);
    });

    test("rejects unrelated commands", () => {
      expect(isAuthCommand("/help")).toBe(false);
      expect(isAuthCommand("/login")).toBe(false);
      expect(isAuthCommand("authorize")).toBe(false);
      expect(isAuthCommand("认证")).toBe(false);
    });

    test("rejects partial matches", () => {
      expect(isAuthCommand("/author")).toBe(false);
      expect(isAuthCommand("授权码")).toBe(false);
      expect(isAuthCommand("authentication")).toBe(false);
    });
  });

  // ── handleAuth ────────────────────────────────────

  describe("handleAuth", () => {
    test("returns early when larkClient is null", async () => {
      mockLarkClient = null;
      // Should not throw, just return silently
      await handleAuth("msg_123", "chat_456");
      expect(spawnMock).not.toHaveBeenCalled();
    });

    test("sends error reply when lark-cli fails (non-zero exit)", async () => {
      const replyMock = mock(() => Promise.resolve());
      mockLarkClient = {
        im: { message: { reply: replyMock } },
      };

      const proc = createMockProcess();
      spawnMock = mock(() => proc);

      const promise = handleAuth("msg_123", "chat_456");

      // Simulate lark-cli exiting with error
      proc.emit("close", 1);

      await promise;

      // Should have called reply with error text
      expect(replyMock).toHaveBeenCalled();
      const callArgs = replyMock.mock.calls[0][0];
      expect(callArgs.data.msg_type).toBe("text");
      const content = JSON.parse(callArgs.data.content);
      expect(content.text).toContain("授权初始化失败");
    });

    test("sends auth card when lark-cli succeeds", async () => {
      const replyMock = mock(() => Promise.resolve({ data: {} }));
      mockLarkClient = {
        im: {
          message: { reply: replyMock },
          v1: { message: { create: mock(() => Promise.resolve()) } },
        },
      };

      const proc = createMockProcess();
      spawnMock = mock(() => proc);

      const promise = handleAuth("msg_123", "chat_456");

      // Simulate lark-cli outputting device info JSON, then exiting
      const deviceInfo = JSON.stringify({
        device_code: "dc_abc123",
        verification_url: "https://example.com/verify?code=abc",
        expires_in: 600,
      });
      proc.stdout.emit("data", Buffer.from(deviceInfo));
      proc.emit("close", 0);

      await promise;

      // First call: reply to send error text (if lark-cli failed)
      // or: reply to send the auth card (if lark-cli succeeded)
      expect(replyMock).toHaveBeenCalled();

      // Find the call that sent the auth card (msg_type = "interactive")
      const cardCall = replyMock.mock.calls.find(
        (c: any) => c[0].data.msg_type === "interactive"
      );
      expect(cardCall).toBeDefined();

      const cardContent = JSON.parse(cardCall![0].data.content);
      expect(cardContent.header.title.content).toContain("授权");

      // Verify the verification URL is embedded in the card
      const buttonElement = cardContent.body.elements.find(
        (el: any) => el.tag === "button"
      );
      expect(buttonElement).toBeDefined();
      expect(buttonElement.multi_url.url).toBe(
        "https://example.com/verify?code=abc"
      );
    });

    test("sends error reply when lark-cli output is not valid JSON", async () => {
      const replyMock = mock(() => Promise.resolve());
      mockLarkClient = {
        im: { message: { reply: replyMock } },
      };

      const proc = createMockProcess();
      spawnMock = mock(() => proc);

      const promise = handleAuth("msg_123", "chat_456");

      // Simulate lark-cli outputting garbage, then exiting successfully
      proc.stdout.emit("data", Buffer.from("not valid json"));
      proc.emit("close", 0);

      await promise;

      expect(replyMock).toHaveBeenCalled();
      const callArgs = replyMock.mock.calls[0][0];
      expect(callArgs.data.msg_type).toBe("text");
      const content = JSON.parse(callArgs.data.content);
      expect(content.text).toContain("授权初始化失败");
    });

    test("spawns lark-cli with correct arguments for --no-wait", async () => {
      const replyMock = mock(() => Promise.resolve());
      mockLarkClient = {
        im: { message: { reply: replyMock } },
      };

      const proc = createMockProcess();
      spawnMock = mock(() => proc);

      const promise = handleAuth("msg_123", "chat_456");

      // Let it fail so we don't need the full flow
      proc.emit("close", 1);
      await promise;

      expect(spawnMock).toHaveBeenCalledWith(
        "lark-cli",
        ["auth", "login", "--no-wait", "--domain", "all", "--json"],
        { stdio: ["pipe", "pipe", "pipe"] }
      );
    });

    test("handles reply API failure gracefully", async () => {
      const replyMock = mock(() =>
        Promise.reject(new Error("network error"))
      );
      mockLarkClient = {
        im: { message: { reply: replyMock } },
      };

      const proc = createMockProcess();
      spawnMock = mock(() => proc);

      const promise = handleAuth("msg_123", "chat_456");

      // Simulate successful lark-cli output
      const deviceInfo = JSON.stringify({
        device_code: "dc_abc123",
        verification_url: "https://example.com/verify",
        expires_in: 600,
      });
      proc.stdout.emit("data", Buffer.from(deviceInfo));
      proc.emit("close", 0);

      // Should not throw — the error is caught internally
      await promise;
    });

    test("starts background poll after sending auth card", async () => {
      const replyMock = mock(() => Promise.resolve({ data: {} }));
      const createMock = mock(() => Promise.resolve());
      mockLarkClient = {
        im: {
          message: { reply: replyMock },
          v1: { message: { create: createMock } },
        },
      };

      // Track spawn calls to distinguish --no-wait from --device-code
      const procs: any[] = [];
      spawnMock = mock(() => {
        const p = createMockProcess();
        procs.push(p);
        return p;
      });

      const promise = handleAuth("msg_123", "chat_456");

      // First spawn: --no-wait
      const deviceInfo = JSON.stringify({
        device_code: "dc_poll_test",
        verification_url: "https://example.com/verify",
        expires_in: 600,
      });
      procs[0].stdout.emit("data", Buffer.from(deviceInfo));
      procs[0].emit("close", 0);

      await promise;

      // Second spawn should be the poll with --device-code
      expect(spawnMock.mock.calls.length).toBeGreaterThanOrEqual(2);
      const pollCallArgs = spawnMock.mock.calls[1];
      expect(pollCallArgs[0]).toBe("lark-cli");
      expect(pollCallArgs[1]).toContain("--device-code");
      expect(pollCallArgs[1]).toContain("dc_poll_test");
    });

    test("sends success card when poll completes successfully", async () => {
      const replyMock = mock(() => Promise.resolve({ data: {} }));
      const createMock = mock(() => Promise.resolve());
      mockLarkClient = {
        im: {
          message: { reply: replyMock },
          v1: { message: { create: createMock } },
        },
      };

      const procs: any[] = [];
      spawnMock = mock(() => {
        const p = createMockProcess();
        procs.push(p);
        return p;
      });

      const promise = handleAuth("msg_123", "chat_456");

      // First spawn: --no-wait succeeds
      const deviceInfo = JSON.stringify({
        device_code: "dc_success",
        verification_url: "https://example.com/verify",
        expires_in: 600,
      });
      procs[0].stdout.emit("data", Buffer.from(deviceInfo));
      procs[0].emit("close", 0);

      await promise;

      // Second spawn: poll exits successfully
      // Wait a tick for the poll promise to be set up
      await new Promise((r) => setTimeout(r, 10));
      procs[1].emit("close", 0);

      // Wait for the success card to be sent
      await new Promise((r) => setTimeout(r, 50));

      expect(createMock).toHaveBeenCalled();
      const createCallArgs = createMock.mock.calls[0][0];
      expect(createCallArgs.params.receive_id_type).toBe("chat_id");
      expect(createCallArgs.data.receive_id).toBe("chat_456");
      expect(createCallArgs.data.msg_type).toBe("interactive");

      const cardContent = JSON.parse(createCallArgs.data.content);
      expect(cardContent.header.title.content).toContain("授权完成");
      expect(cardContent.header.template).toBe("green");
    });
  });
});
