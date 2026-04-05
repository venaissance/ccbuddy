import cron from "node-cron";
import type { AgentOptions } from "./agent";

// ── Heartbeat Guard ─────────────────────────────────

export class HeartbeatGuard {
  private running = false;

  isRunning(): boolean {
    return this.running;
  }

  tryAcquire(): boolean {
    if (this.running) return false;
    this.running = true;
    return true;
  }

  release(): void {
    this.running = false;
  }
}

// ── Heartbeat Handler ───────────────────────────────

const HEARTBEAT_SESSION = "heartbeat-main";

export function createHeartbeatHandler(
  guard: HeartbeatGuard,
  runAgent: (options: AgentOptions) => Promise<void>
) {
  return async () => {
    if (!guard.tryAcquire()) {
      console.log("[cron] Heartbeat already running, skip");
      return;
    }

    try {
      await runAgent({
        sessionId: HEARTBEAT_SESSION,
        prompt: "You are woken up by the heartbeat cron. Execute /heartbeat skill.",
        onStream: () => {},
        onEnd: () => {
          guard.release();
        },
        onError: (err) => {
          console.error("[cron] Heartbeat error:", err);
          guard.release();
        },
      });
    } catch (err) {
      console.error("[cron] Heartbeat exception:", err);
      guard.release();
    }
  };
}

// ── Init ────────────────────────────────────────────

export function initCron(runAgent: (options: AgentOptions) => Promise<void>) {
  const guard = new HeartbeatGuard();
  const handler = createHeartbeatHandler(guard, runAgent);

  cron.schedule("*/30 * * * *", handler);

  console.log("[cron] Scheduler initialized — Heartbeat every 30 min");

  return { guard, handler };
}
