import { describe, test, expect, beforeEach, afterEach, mock, spyOn } from "bun:test";
import { join } from "path";
import { EventEmitter } from "events";

describe("agent", () => {
  describe("parseStreamLine", () => {
    test("extracts text from assistant message", async () => {
      const { parseStreamLine } = await import("../../src/agent");

      const line = JSON.stringify({
        type: "assistant",
        message: {
          content: [{ type: "text", text: "Hello from Claude" }],
        },
      });

      const result = parseStreamLine(line);
      expect(result).toEqual({ type: "assistant", content: "Hello from Claude" });
    });

    test("extracts tool_use event", async () => {
      const { parseStreamLine } = await import("../../src/agent");

      const line = JSON.stringify({
        type: "assistant",
        message: {
          content: [{ type: "tool_use", name: "Read", input: { file: "foo.ts" } }],
        },
      });

      const result = parseStreamLine(line);
      expect(result).toEqual({ type: "tool_use", tool: "Read" });
    });

    test("returns null for non-JSON lines", async () => {
      const { parseStreamLine } = await import("../../src/agent");
      expect(parseStreamLine("not json")).toBeNull();
      expect(parseStreamLine("")).toBeNull();
    });

    test("returns null for system messages without content", async () => {
      const { parseStreamLine } = await import("../../src/agent");
      const line = JSON.stringify({ type: "system", message: "starting" });
      expect(parseStreamLine(line)).toBeNull();
    });

    test("extracts result event with cost info", async () => {
      const { parseStreamLine } = await import("../../src/agent");

      const line = JSON.stringify({
        type: "result",
        duration_ms: 5000,
        total_cost_usd: 0.05,
      });

      const result = parseStreamLine(line);
      expect(result).toEqual({
        type: "result",
        duration: 5000,
        cost: 0.05,
      });
    });
  });

  describe("processStreamBuffer", () => {
    test("splits complete lines and keeps incomplete buffer", async () => {
      const { processStreamBuffer } = await import("../../src/agent");

      const { lines, remaining } = processStreamBuffer(
        '{"type":"system"}\n{"type":"assistant"}\nincomplete'
      );

      expect(lines).toHaveLength(2);
      expect(lines[0]).toBe('{"type":"system"}');
      expect(lines[1]).toBe('{"type":"assistant"}');
      expect(remaining).toBe("incomplete");
    });

    test("handles empty input", async () => {
      const { processStreamBuffer } = await import("../../src/agent");
      const { lines, remaining } = processStreamBuffer("");
      expect(lines).toHaveLength(0);
      expect(remaining).toBe("");
    });

    test("handles complete lines with trailing newline", async () => {
      const { processStreamBuffer } = await import("../../src/agent");
      const { lines, remaining } = processStreamBuffer('{"type":"done"}\n');
      expect(lines).toHaveLength(1);
      expect(remaining).toBe("");
    });
  });

  describe("buildAgentArgs", () => {
    test("builds correct CLI arguments", async () => {
      const { buildAgentArgs } = await import("../../src/agent");

      const args = buildAgentArgs({
        sessionId: "sess_001",
        prompt: "Hello world",
      });

      expect(args).toContain("--output-format");
      expect(args).toContain("stream-json");
      expect(args).toContain("--print");
      expect(args).toContain("--verbose");
      expect(args).toContain("--dangerously-skip-permissions");
      expect(args[args.length - 1]).toBe("Hello world");
    });

    test("includes --resume when claudeSessionUuid provided", async () => {
      const { buildAgentArgs } = await import("../../src/agent");

      const args = buildAgentArgs({
        sessionId: "sess_001",
        prompt: "test",
        claudeSessionUuid: "uuid-123",
      });

      expect(args).toContain("--resume");
      expect(args).toContain("uuid-123");
    });

    test("does not include --resume without claudeSessionUuid", async () => {
      const { buildAgentArgs } = await import("../../src/agent");

      const args = buildAgentArgs({
        sessionId: "sess_001",
        prompt: "test",
      });

      expect(args).not.toContain("--resume");
    });
  });

  describe("activeProcesses management", () => {
    test("tracks and aborts active processes", async () => {
      const { getActiveCount, abortAgent, trackProcess, untrackProcess } =
        await import("../../src/agent");

      expect(getActiveCount()).toBe(0);

      // Mock process
      const mockProc = {
        kill: mock(() => {}),
        on: mock(() => {}),
        stdout: { on: mock(() => {}) },
        stderr: { on: mock(() => {}) },
      };

      trackProcess("sess_test", mockProc as any);
      expect(getActiveCount()).toBe(1);

      const aborted = abortAgent("sess_test");
      expect(aborted).toBe(true);
      expect(mockProc.kill).toHaveBeenCalledWith("SIGTERM");
      expect(getActiveCount()).toBe(0);
    });

    test("returns false when aborting non-existent session", async () => {
      const { abortAgent } = await import("../../src/agent");
      expect(abortAgent("nonexistent")).toBe(false);
    });
  });

  describe("setClaudeSessionId / getClaudeSessionId", () => {
    test("set+get roundtrip returns the stored UUID", async () => {
      const { setClaudeSessionId, getClaudeSessionId } = await import("../../src/agent");

      setClaudeSessionId("sess_rt", "claude-uuid-abc");
      expect(getClaudeSessionId("sess_rt")).toBe("claude-uuid-abc");
    });

    test("get nonexistent session returns undefined", async () => {
      const { getClaudeSessionId } = await import("../../src/agent");

      expect(getClaudeSessionId("sess_does_not_exist")).toBeUndefined();
    });

    test("overwrite existing session UUID", async () => {
      const { setClaudeSessionId, getClaudeSessionId } = await import("../../src/agent");

      setClaudeSessionId("sess_ow", "uuid-first");
      expect(getClaudeSessionId("sess_ow")).toBe("uuid-first");

      setClaudeSessionId("sess_ow", "uuid-second");
      expect(getClaudeSessionId("sess_ow")).toBe("uuid-second");
    });
  });

  describe("runAgent() with mock spawn", () => {
    function createMockProcess(lines: string[], exitCode = 0) {
      const stdout = new EventEmitter();
      const stderr = new EventEmitter();
      const proc = new EventEmitter();
      (proc as any).stdout = stdout;
      (proc as any).stderr = stderr;
      (proc as any).kill = mock(() => {});
      setTimeout(() => {
        for (const line of lines) stdout.emit("data", Buffer.from(line + "\n"));
        proc.emit("close", exitCode);
      }, 10);
      return proc;
    }

    test("onStream receives parsed chunks from stdout", async () => {
      const lines = [
        JSON.stringify({ session_id: "claude-uuid-1" }),
        JSON.stringify({
          type: "assistant",
          message: { content: [{ type: "text", text: "Hi there" }] },
        }),
        JSON.stringify({
          type: "assistant",
          message: { content: [{ type: "tool_use", name: "Bash" }] },
        }),
        JSON.stringify({ type: "result", duration_ms: 3000, total_cost_usd: 0.02 }),
      ];

      const fakeProc = createMockProcess(lines, 0);
      mock.module("child_process", () => ({
        spawn: mock(() => fakeProc),
      }));

      // Re-import to pick up the mocked child_process
      const { runAgent } = await import("../../src/agent");

      const chunks: any[] = [];
      await new Promise<void>((resolve, reject) => {
        runAgent({
          sessionId: "sess_stream",
          prompt: "test prompt",
          onStream: (chunk) => chunks.push(chunk),
          onEnd: () => resolve(),
          onError: (err) => reject(err),
        });
      });

      expect(chunks.length).toBeGreaterThanOrEqual(3);
      expect(chunks[0]).toEqual({ type: "assistant", content: "Hi there" });
      expect(chunks[1]).toEqual({ type: "tool_use", tool: "Bash" });
      expect(chunks[2]).toEqual({ type: "result", duration: 3000, cost: 0.02 });
    });

    test("onEnd fires on exit code 0", async () => {
      const lines = [
        JSON.stringify({ session_id: "claude-uuid-end" }),
        JSON.stringify({
          type: "assistant",
          message: { content: [{ type: "text", text: "done" }] },
        }),
      ];

      const fakeProc = createMockProcess(lines, 0);
      mock.module("child_process", () => ({
        spawn: mock(() => fakeProc),
      }));

      const { runAgent } = await import("../../src/agent");

      const result = await new Promise<any>((resolve, reject) => {
        runAgent({
          sessionId: "sess_end_ok",
          prompt: "test",
          onEnd: (r) => resolve(r),
          onError: (err) => reject(err),
        });
      });

      expect(result).toBeDefined();
      expect(result.sessionId).toBe("sess_end_ok");
    });

    test("onError fires on non-zero exit code", async () => {
      const lines = [
        JSON.stringify({ session_id: "claude-uuid-err" }),
      ];

      const fakeProc = createMockProcess(lines, 1);
      mock.module("child_process", () => ({
        spawn: mock(() => fakeProc),
      }));

      const { runAgent } = await import("../../src/agent");

      const error = await new Promise<Error>((resolve, reject) => {
        runAgent({
          sessionId: "sess_err",
          prompt: "test",
          onEnd: () => reject(new Error("should not have ended successfully")),
          onError: (err) => resolve(err),
        });
      });

      expect(error).toBeInstanceOf(Error);
      expect(error.message).toContain("Agent exited with code 1");
    });

    test("session UUID is captured from the stream", async () => {
      const lines = [
        JSON.stringify({ session_id: "captured-uuid-xyz" }),
        JSON.stringify({
          type: "assistant",
          message: { content: [{ type: "text", text: "hello" }] },
        }),
      ];

      const fakeProc = createMockProcess(lines, 0);
      mock.module("child_process", () => ({
        spawn: mock(() => fakeProc),
      }));

      const { runAgent, getClaudeSessionId } = await import("../../src/agent");

      await new Promise<void>((resolve, reject) => {
        runAgent({
          sessionId: "sess_capture_uuid",
          prompt: "test",
          onEnd: () => resolve(),
          onError: (err) => reject(err),
        });
      });

      expect(getClaudeSessionId("sess_capture_uuid")).toBe("captured-uuid-xyz");
    });
  });
});
