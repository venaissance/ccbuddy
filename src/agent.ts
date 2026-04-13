import { spawn, type ChildProcess } from "child_process";

// ── Types ───────────────────────────────────────────

// Default working directory for Claude CLI — contains CLAUDE.md, memory/, skills/
const DEFAULT_AGENT_CWD = "./data";

// Allow overriding the claude binary (e.g. with a wrapper that runs preflight checks)
const CLAUDE_BIN = process.env.CCBUDDY_CLAUDE_BIN || "claude";

export interface AgentOptions {
  sessionId: string;
  prompt: string;
  model?: string;
  workDir?: string;
  onStream?: (chunk: StreamChunk) => void;
  onEnd?: (result: AgentResult) => void;
  onError?: (error: Error) => void;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  contextWindow: number;
}

export interface StreamChunk {
  type: "assistant" | "thinking" | "tool_use" | "tool_result" | "status" | "result" | "rate_limit";
  content?: string;
  tool?: string;
  duration?: number;
  cost?: number;
  usage?: TokenUsage;
  rateLimitInfo?: RateLimitInfo;
}

export interface AgentResult {
  sessionId: string;
  duration: number;
  cost: number;
  usage: TokenUsage;
}

// ── Session Metadata ───────────────────────────────

export type EffortLevel = "low" | "medium" | "high" | "max";

export interface RateLimitInfo {
  resetsAt: number;        // Unix seconds
  rateLimitType: string;   // "five_hour" | "seven_day" etc.
  status: string;          // "allowed" | "exceeded"
}

export interface SessionMeta {
  model: string;
  effort: EffortLevel;
  totalCost: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalDuration: number;
  turnCount: number;
  createdAt: number;
  contextWindow: number;
  rateLimits: Record<string, RateLimitInfo>;
}

const sessionMeta = new Map<string, SessionMeta>();

const DEFAULT_MODEL = "opus";
const DEFAULT_EFFORT: EffortLevel = "medium";

export function getSessionMeta(sessionId: string): SessionMeta | undefined {
  return sessionMeta.get(sessionId);
}

export function getOrCreateMeta(sessionId: string): SessionMeta {
  let meta = sessionMeta.get(sessionId);
  if (!meta) {
    meta = { model: DEFAULT_MODEL, effort: DEFAULT_EFFORT, totalCost: 0, totalInputTokens: 0, totalOutputTokens: 0, totalDuration: 0, turnCount: 0, createdAt: Date.now(), contextWindow: 0, rateLimits: {} };
    sessionMeta.set(sessionId, meta);
  }
  return meta;
}

export function setSessionModel(sessionId: string, model: string): void {
  getOrCreateMeta(sessionId).model = model;
}

export function setSessionEffort(sessionId: string, effort: EffortLevel): void {
  getOrCreateMeta(sessionId).effort = effort;
}

export function clearSessionMeta(sessionId: string): void {
  sessionMeta.delete(sessionId);
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

export function clearClaudeSession(sessionId: string): void {
  claudeSessionMap.delete(sessionId);
}

export function buildAgentArgs(options: {
  sessionId: string;
  prompt: string;
  model?: string;
  effort?: string;
  workDir?: string;
  claudeSessionUuid?: string;
}): string[] {
  const args = [
    "--output-format", "stream-json",
    "--print",
    "--verbose",
    "--include-partial-messages",
    "--dangerously-skip-permissions",
  ];

  // Model selection
  if (options.model) {
    args.push("--model", options.model);
  }

  // Effort level
  if (options.effort) {
    args.push("--effort", options.effort);
  }

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
      const u = event.usage || {};
      // Extract contextWindow from modelUsage (first model entry)
      let contextWindow = 0;
      if (event.modelUsage) {
        const firstModel = Object.values(event.modelUsage)[0] as any;
        if (firstModel?.contextWindow) contextWindow = firstModel.contextWindow;
      }
      return {
        type: "result",
        duration: event.duration_ms,
        cost: event.total_cost_usd,
        usage: {
          inputTokens: u.input_tokens || 0,
          outputTokens: u.output_tokens || 0,
          cacheCreationTokens: u.cache_creation_input_tokens || 0,
          cacheReadTokens: u.cache_read_input_tokens || 0,
          contextWindow,
        },
      };
    }

    if (event.type === "rate_limit_event" && event.rate_limit_info) {
      return {
        type: "rate_limit",
        rateLimitInfo: {
          resetsAt: event.rate_limit_info.resetsAt,
          rateLimitType: event.rate_limit_info.rateLimitType,
          status: event.rate_limit_info.status,
        },
      };
    }

    // Incremental deltas (from --include-partial-messages)
    if (event.type === "stream_event") {
      const delta = event.event?.delta;
      if (delta?.type === "text_delta" && delta.text) {
        return { type: "assistant", content: delta.text };
      }
      if (delta?.type === "thinking_delta" && delta.thinking) {
        return { type: "thinking", content: delta.thinking };
      }
    }

    // Full message (fallback, also used for tool_use)
    if (event.type === "assistant" && event.message?.content) {
      for (const block of event.message.content) {
        if (block.type === "tool_use") {
          return { type: "tool_use", tool: block.name };
        }
      }
      // Skip full text blocks — we already got them via text_delta
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
  const { sessionId, prompt, model, workDir, onStream, onEnd, onError } = options;

  const meta = getOrCreateMeta(sessionId);
  const effectiveModel = model || meta.model;
  const claudeUuid = getClaudeSessionId(sessionId);
  const args = buildAgentArgs({ sessionId, prompt, model: effectiveModel, effort: meta.effort, workDir, claudeSessionUuid: claudeUuid });
  console.log(`[agent] Starting claude for session ${sessionId}${claudeUuid ? ` (resume: ${claudeUuid})` : " (new)"} [model: ${effectiveModel}, effort: ${meta.effort}]`);
  console.log(`[agent] Args: ${args.join(" ")}`);

  const cwd = workDir || DEFAULT_AGENT_CWD;
  const proc = spawn(CLAUDE_BIN, args, {
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, CLAUDE_CODE_ENTRYPOINT: "ccbuddy" },
  });

  trackProcess(sessionId, proc);
  meta.turnCount++;

  let buffer = "";
  let turnCost = 0;
  let turnDuration = 0;
  let turnUsage: TokenUsage = { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, contextWindow: 0 };

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
      if (chunk) {
        if (chunk.type === "result") {
          turnCost = chunk.cost || 0;
          turnDuration = chunk.duration || 0;
          if (chunk.usage) {
            turnUsage = chunk.usage;
            if (chunk.usage.contextWindow > 0) meta.contextWindow = chunk.usage.contextWindow;
          }
        }
        if (chunk.type === "rate_limit" && chunk.rateLimitInfo) {
          meta.rateLimits[chunk.rateLimitInfo.rateLimitType] = chunk.rateLimitInfo;
        }
        onStream?.(chunk);
      }
    }
  });

  proc.stderr!.on("data", (data: Buffer) => {
    console.error(`[agent:${sessionId}] stderr:`, data.toString());
  });

  proc.on("close", (code) => {
    untrackProcess(sessionId);
    meta.totalCost += turnCost;
    meta.totalInputTokens += turnUsage.inputTokens + turnUsage.cacheCreationTokens + turnUsage.cacheReadTokens;
    meta.totalOutputTokens += turnUsage.outputTokens;
    meta.totalDuration += turnDuration;
    if (code === 0) {
      onEnd?.({ sessionId, duration: turnDuration, cost: turnCost, usage: turnUsage });
    } else {
      onError?.(new Error(`Agent exited with code ${code}`));
    }
  });

  proc.on("error", (err) => {
    untrackProcess(sessionId);
    onError?.(err);
  });
}
