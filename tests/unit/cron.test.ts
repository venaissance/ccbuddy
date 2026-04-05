import { describe, test, expect, mock, beforeEach } from "bun:test";

// ── Mock node-cron before importing cron.ts ────────────────────
const mockSchedule = mock(() => {});
mock.module("node-cron", () => ({
  default: { schedule: mockSchedule },
  schedule: mockSchedule,
}));

describe("cron", () => {
  describe("HeartbeatGuard", () => {
    test("allows first execution", async () => {
      const { HeartbeatGuard } = await import("../../src/cron");
      const guard = new HeartbeatGuard();

      expect(guard.isRunning()).toBe(false);
      expect(guard.tryAcquire()).toBe(true);
      expect(guard.isRunning()).toBe(true);
    });

    test("blocks concurrent execution", async () => {
      const { HeartbeatGuard } = await import("../../src/cron");
      const guard = new HeartbeatGuard();

      guard.tryAcquire();
      expect(guard.tryAcquire()).toBe(false); // blocked
    });

    test("releases lock after completion", async () => {
      const { HeartbeatGuard } = await import("../../src/cron");
      const guard = new HeartbeatGuard();

      guard.tryAcquire();
      guard.release();

      expect(guard.isRunning()).toBe(false);
      expect(guard.tryAcquire()).toBe(true); // can acquire again
    });

    test("release is idempotent", async () => {
      const { HeartbeatGuard } = await import("../../src/cron");
      const guard = new HeartbeatGuard();

      guard.tryAcquire();
      guard.release();
      guard.release(); // no-op, should not throw

      expect(guard.isRunning()).toBe(false);
    });

    test("after release, tryAcquire succeeds again", async () => {
      const { HeartbeatGuard } = await import("../../src/cron");
      const guard = new HeartbeatGuard();

      // acquire → release → re-acquire cycle
      expect(guard.tryAcquire()).toBe(true);
      expect(guard.isRunning()).toBe(true);

      guard.release();
      expect(guard.isRunning()).toBe(false);

      // second acquire must succeed
      expect(guard.tryAcquire()).toBe(true);
      expect(guard.isRunning()).toBe(true);
    });
  });

  describe("createHeartbeatHandler", () => {
    test("calls runAgent with heartbeat session", async () => {
      const { createHeartbeatHandler, HeartbeatGuard } = await import("../../src/cron");
      const guard = new HeartbeatGuard();

      let capturedOptions: any = null;
      const mockRunAgent = mock(async (opts: any) => {
        capturedOptions = opts;
        opts.onEnd?.();
      });

      const handler = createHeartbeatHandler(guard, mockRunAgent);
      await handler();

      expect(capturedOptions).not.toBeNull();
      expect(capturedOptions.sessionId).toBe("heartbeat-main");
      expect(capturedOptions.prompt).toContain("heartbeat");
    });

    test("skips when guard is acquired", async () => {
      const { createHeartbeatHandler, HeartbeatGuard } = await import("../../src/cron");
      const guard = new HeartbeatGuard();

      const mockRunAgent = mock(async () => {});

      guard.tryAcquire(); // simulate running heartbeat
      const handler = createHeartbeatHandler(guard, mockRunAgent);
      await handler();

      expect(mockRunAgent).not.toHaveBeenCalled();
    });

    test("releases guard even on error", async () => {
      const { createHeartbeatHandler, HeartbeatGuard } = await import("../../src/cron");
      const guard = new HeartbeatGuard();

      const mockRunAgent = mock(async (opts: any) => {
        opts.onError?.(new Error("test error"));
      });

      const handler = createHeartbeatHandler(guard, mockRunAgent);
      await handler();

      expect(guard.isRunning()).toBe(false); // guard released
    });

    test("releases guard on thrown exception", async () => {
      const { createHeartbeatHandler, HeartbeatGuard } = await import("../../src/cron");
      const guard = new HeartbeatGuard();

      const mockRunAgent = mock(async () => {
        throw new Error("crash");
      });

      const handler = createHeartbeatHandler(guard, mockRunAgent);
      await handler(); // should not throw

      expect(guard.isRunning()).toBe(false);
    });

    test("full lifecycle: acquires guard → calls runAgent → releases on success", async () => {
      const { createHeartbeatHandler, HeartbeatGuard } = await import("../../src/cron");
      const guard = new HeartbeatGuard();

      const guardStates: boolean[] = [];
      const mockRunAgent = mock(async (opts: any) => {
        // guard should be acquired while runAgent is executing
        guardStates.push(guard.isRunning());
        opts.onEnd?.();
      });

      const handler = createHeartbeatHandler(guard, mockRunAgent);

      expect(guard.isRunning()).toBe(false); // before
      await handler();
      expect(guard.isRunning()).toBe(false); // after — released by onEnd
      expect(guardStates).toEqual([true]); // was acquired during execution
      expect(mockRunAgent).toHaveBeenCalledTimes(1);
    });

    test("full lifecycle: acquires guard → runAgent calls onError → releases", async () => {
      const { createHeartbeatHandler, HeartbeatGuard } = await import("../../src/cron");
      const guard = new HeartbeatGuard();

      const guardStates: boolean[] = [];
      const mockRunAgent = mock(async (opts: any) => {
        guardStates.push(guard.isRunning());
        opts.onError?.(new Error("agent failed"));
      });

      const handler = createHeartbeatHandler(guard, mockRunAgent);

      expect(guard.isRunning()).toBe(false);
      await handler();
      expect(guard.isRunning()).toBe(false); // released by onError
      expect(guardStates).toEqual([true]);
      expect(mockRunAgent).toHaveBeenCalledTimes(1);
    });

    test("full lifecycle: acquires guard → runAgent throws → releases", async () => {
      const { createHeartbeatHandler, HeartbeatGuard } = await import("../../src/cron");
      const guard = new HeartbeatGuard();

      const guardStates: boolean[] = [];
      const mockRunAgent = mock(async () => {
        guardStates.push(guard.isRunning());
        throw new Error("unexpected crash");
      });

      const handler = createHeartbeatHandler(guard, mockRunAgent);

      expect(guard.isRunning()).toBe(false);
      await handler(); // should not propagate
      expect(guard.isRunning()).toBe(false); // released by catch
      expect(guardStates).toEqual([true]);
      expect(mockRunAgent).toHaveBeenCalledTimes(1);
    });

    test("two concurrent handler calls — only one executes", async () => {
      const { createHeartbeatHandler, HeartbeatGuard } = await import("../../src/cron");
      const guard = new HeartbeatGuard();

      let resolveAgent!: () => void;
      const agentPromise = new Promise<void>((r) => { resolveAgent = r; });

      const mockRunAgent = mock(async (opts: any) => {
        // Simulate a long-running agent — waits until we resolve
        await agentPromise;
        opts.onEnd?.();
      });

      const handler = createHeartbeatHandler(guard, mockRunAgent);

      // Start first call (will block on agentPromise)
      const call1 = handler();
      // Start second call concurrently — guard is acquired, so this should skip
      const call2 = handler();

      // Let both settle
      await call2; // second call should return immediately (skipped)
      expect(mockRunAgent).toHaveBeenCalledTimes(1); // only first call executed

      // Now let the first call finish
      resolveAgent();
      await call1;

      expect(mockRunAgent).toHaveBeenCalledTimes(1); // still only one invocation
      expect(guard.isRunning()).toBe(false); // guard released after first finishes
    });
  });

  describe("initCron", () => {
    beforeEach(() => {
      mockSchedule.mockClear();
    });

    test("returns { guard, handler } object", async () => {
      const { initCron } = await import("../../src/cron");
      const mockRunAgent = mock(async () => {});

      const result = initCron(mockRunAgent);

      expect(result).toHaveProperty("guard");
      expect(result).toHaveProperty("handler");
    });

    test("guard is a HeartbeatGuard instance with expected methods", async () => {
      const { initCron, HeartbeatGuard } = await import("../../src/cron");
      const mockRunAgent = mock(async () => {});

      const { guard } = initCron(mockRunAgent);

      expect(guard).toBeInstanceOf(HeartbeatGuard);
      expect(typeof guard.tryAcquire).toBe("function");
      expect(typeof guard.release).toBe("function");
      expect(typeof guard.isRunning).toBe("function");
    });

    test("handler is a callable function", async () => {
      const { initCron } = await import("../../src/cron");
      const mockRunAgent = mock(async () => {});

      const { handler } = initCron(mockRunAgent);

      expect(typeof handler).toBe("function");
    });

    test("handler works correctly when invoked", async () => {
      const { initCron } = await import("../../src/cron");
      const mockRunAgent = mock(async (opts: any) => {
        opts.onEnd?.();
      });

      const { guard, handler } = initCron(mockRunAgent);

      expect(guard.isRunning()).toBe(false);
      await handler();
      expect(mockRunAgent).toHaveBeenCalledTimes(1);
      expect(guard.isRunning()).toBe(false); // released after onEnd
    });
  });
});
