import { spawn, type ChildProcess } from "child_process";

// ── Types ───────────────────────────────────────────

// Default working directory for Claude CLI — contains CLAUDE.md, memory/, skills/
const DEFAULT_AGENT_CWD = "./data";

export interface AgentOptions {
  sessionId: string;
  prompt: string;
  workDir?: string;
  onStream?: (chunk: StreamChunk) => void;
  onEnd?: (result: AgentResult) => void;
  onError?: (error: Error) => void;
}

export interface StreamChunk {
  type: "assistant" | "tool_use" | "tool_result" | "status" | "result";
  content?: string;
  tool?: string;
  duration?: number;
  cost?: number;
}

export interface AgentResult {
  sessionId: string;
  totalTokens: number;
  duration: number;
}

// ── Active Processes ────────────────────────────────

const activeProcesses = new Map<string, ChildProcess>();

export function getActiveCount(): number {
  return activeProcesses.size;
}

export function trackProcess(sessionId: string, proc: ChildProcess): void {
  activeProcesses.set(sessionId, proc);
}

export function untrackProcess(sessionId: string): void {
  activeProcesses.delete(sessionId);
}

export function abortAgent(sessionId: string): boolean {
  const proc = activeProcesses.get(sessionId);
  if (proc) {
    proc.kill("SIGTERM");
    activeProcesses.delete(sessionId);
    return true;
  }
  return false;
}

// ── CLI Args ────────────────────────────────────────

// Map our session IDs to Claude's internal session UUIDs
const claudeSessionMap = new Map<string, string>();

export function setClaudeSessionId(sessionId: string, claudeUuid: string): void {
  claudeSessionMap.set(sessionId, claudeUuid);
}

export function getClaudeSessionId(sessionId: string): string | undefined {
  return claudeSessionMap.get(sessionId);
}

export function buildAgentArgs(options: {
  sessionId: string;
  prompt: string;
  workDir?: string;
  claudeSessionUuid?: string;
}): string[] {
  const args = [
    "--output-format", "stream-json",
    "--print",
    "--verbose",
    "--dangerously-skip-permissions",
  ];

  // Resume existing Claude session if we have one
  if (options.claudeSessionUuid) {
    args.push("--resume", options.claudeSessionUuid);
  }

  args.push(options.prompt);

  return args;
}

// ── Stream Parsing ──────────────────────────────────

export function parseStreamLine(line: string): StreamChunk | null {
  if (!line.trim()) return null;

  try {
    const event = JSON.parse(line);

    if (event.type === "result") {
      return {
        type: "result",
        duration: event.duration_ms,
        cost: event.total_cost_usd,
      };
    }

    if (event.type === "assistant" && event.message?.content) {
      for (const block of event.message.content) {
        if (block.type === "text") {
          return { type: "assistant", content: block.text };
        }
        if (block.type === "tool_use") {
          return { type: "tool_use", tool: block.name };
        }
      }
    }

    return null;
  } catch {
    return null;
  }
}

export function processStreamBuffer(buffer: string): {
  lines: string[];
  remaining: string;
} {
  const parts = buffer.split("\n");
  const remaining = parts.pop() || "";
  const lines = parts.filter((l) => l.trim().length > 0);
  return { lines, remaining };
}

// ── Run Agent ───────────────────────────────────────

export async function runAgent(options: AgentOptions): Promise<void> {
  const { sessionId, prompt, workDir, onStream, onEnd, onError } = options;

  const claudeUuid = getClaudeSessionId(sessionId);
  const args = buildAgentArgs({ sessionId, prompt, workDir, claudeSessionUuid: claudeUuid });
  console.log(`[agent] Starting claude for session ${sessionId}${claudeUuid ? ` (resume: ${claudeUuid})` : " (new)"}`);
  console.log(`[agent] Args: ${args.join(" ")}`);

  const cwd = workDir || DEFAULT_AGENT_CWD;
  const proc = spawn("claude", args, {
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, CLAUDE_CODE_ENTRYPOINT: "ccbuddy" },
  });

  trackProcess(sessionId, proc);

  let buffer = "";

  proc.stdout!.on("data", (data: Buffer) => {
    buffer += data.toString();
    const { lines, remaining } = processStreamBuffer(buffer);
    buffer = remaining;

    for (const line of lines) {
      // Capture Claude's session UUID (once)
      if (!getClaudeSessionId(sessionId)) {
        try {
          const parsed = JSON.parse(line);
          if (parsed.session_id) {
            setClaudeSessionId(sessionId, parsed.session_id);
            console.log(`[agent] Session ${sessionId} → Claude ${parsed.session_id}`);
          }
        } catch {}
      }

      const chunk = parseStreamLine(line);
      if (chunk && onStream) {
        onStream(chunk);
      }
    }
  });

  proc.stderr!.on("data", (data: Buffer) => {
    console.error(`[agent:${sessionId}] stderr:`, data.toString());
  });

  proc.on("close", (code) => {
    untrackProcess(sessionId);
    if (code === 0) {
      onEnd?.({ sessionId, totalTokens: 0, duration: 0 });
    } else {
      onError?.(new Error(`Agent exited with code ${code}`));
    }
  });

  proc.on("error", (err) => {
    untrackProcess(sessionId);
    onError?.(err);
  });
}
