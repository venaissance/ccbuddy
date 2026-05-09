/**
 * CC Progress — receives Claude Code hook events and pushes per-session
 * progress cards to Feishu IM. Each session = one card that updates in place.
 *
 * Phase 1: Stop hook drives the card. UserPromptSubmit populates state so
 * the Stop card has context. Other hooks (PreToolUse/PostToolUse/Notification)
 * accepted but only update in-memory state, no card update yet.
 */

import { open, stat } from "node:fs/promises";
import type { Hono } from "hono";
import { getLarkClient } from "./feishu-ws";

// ── Types ───────────────────────────────────────────

export type CCHookEvent =
	| "UserPromptSubmit"
	| "PreToolUse"
	| "PostToolUse"
	| "Stop"
	| "Notification";

export interface CCEventPayload {
	hook_event_name?: CCHookEvent;
	hook_event?: CCHookEvent; // tolerate either field name
	session_id: string;
	transcript_path?: string;
	cwd?: string;
	tool_name?: string;
	tool_input?: unknown;
	prompt?: string;
	message?: string;
}

export type SessionStatus = "running" | "stopped" | "blocked" | "error";

export interface SessionState {
	sessionId: string;
	shortId: string;
	cwd: string;
	projectName: string;
	startedAt: number;
	lastEventAt: number;
	lastUserPrompt?: string;
	toolCount: number;
	status: SessionStatus;
	/** Legacy: id of the per-session card. Now reused as `threadRootMessageId`. */
	feishuMessageId?: string;

	// Thread mode (Q1=session-thread, Q2=per-turn aggregate, Q3=tool-fold)
	transcriptPath?: string;
	threadRootMessageId?: string;
	lastTranscriptOffset: number;
	turnNumber: number;
	currentTurnStartedAt: number;
}

// ── State ───────────────────────────────────────────

const sessions = new Map<string, SessionState>();

export function _getSessionsForTest(): Map<string, SessionState> {
	return sessions;
}

export function _resetSessionsForTest(): void {
	sessions.clear();
}

// ── Helpers ─────────────────────────────────────────

function shortId(uuid: string): string {
	return uuid.slice(0, 8);
}

function projectName(cwd: string): string {
	const parts = cwd.split("/").filter(Boolean);
	return parts[parts.length - 1] || cwd;
}

function targetChatId(): string | undefined {
	// Dedicated chat for CC progress cards. Do NOT fall back to
	// DAILY_REPORT_CHAT_ID — that's the team broadcast group; CC progress
	// is personal noise that belongs in its own (likely topic) group.
	return process.env.CC_PROGRESS_CHAT_ID?.trim() || undefined;
}

function getOrCreate(sessionId: string, cwd: string): SessionState {
	let s = sessions.get(sessionId);
	if (!s) {
		const now = Date.now();
		s = {
			sessionId,
			shortId: shortId(sessionId),
			cwd,
			projectName: projectName(cwd),
			startedAt: now,
			lastEventAt: now,
			toolCount: 0,
			status: "running",
			lastTranscriptOffset: 0,
			turnNumber: 0,
			currentTurnStartedAt: now,
		};
		sessions.set(sessionId, s);
	}
	return s;
}

// ── Transcript parser ───────────────────────────────

export interface TranscriptDelta {
	assistantText: string;
	toolCounts: Record<string, number>;
	newOffset: number;
}

/**
 * Read a CC transcript JSONL from `fromOffset` to EOF and extract:
 *   - concatenated assistant text (skipping `thinking` and tool_result blocks)
 *   - tool_use counts per tool name
 *   - the new byte offset to use for the next incremental read
 *
 * Pure aside from filesystem reads. Designed so a Stop hook can call it
 * after each turn and feed the result straight into a thread reply.
 */
export async function parseTranscriptDelta(
	path: string,
	fromOffset: number,
): Promise<TranscriptDelta> {
	let fileSize: number;
	try {
		const st = await stat(path);
		fileSize = st.size;
	} catch {
		return { assistantText: "", toolCounts: {}, newOffset: 0 };
	}
	if (fromOffset >= fileSize) {
		return { assistantText: "", toolCounts: {}, newOffset: fileSize };
	}

	let buf = "";
	try {
		const fh = await open(path, "r");
		try {
			const len = fileSize - fromOffset;
			const data = Buffer.alloc(len);
			await fh.read(data, 0, len, fromOffset);
			buf = data.toString("utf8");
		} finally {
			await fh.close();
		}
	} catch {
		return { assistantText: "", toolCounts: {}, newOffset: fromOffset };
	}

	const texts: string[] = [];
	const toolCounts: Record<string, number> = {};
	const lines = buf.split("\n");
	for (const line of lines) {
		if (!line.trim()) continue;
		let entry: any;
		try {
			entry = JSON.parse(line);
		} catch {
			continue;
		}
		if (entry?.type !== "assistant") continue;
		const content = entry?.message?.content;
		if (!Array.isArray(content)) continue;
		for (const block of content) {
			if (block?.type === "text" && typeof block.text === "string") {
				if (block.text.trim()) texts.push(block.text.trim());
			} else if (block?.type === "tool_use" && typeof block.name === "string") {
				toolCounts[block.name] = (toolCounts[block.name] || 0) + 1;
			}
		}
	}

	return {
		assistantText: texts.join("\n\n"),
		toolCounts,
		newOffset: fileSize,
	};
}

// ── Card builder ────────────────────────────────────

export function buildCard(s: SessionState): Record<string, unknown> {
	const elapsedSec = Math.max(0, Math.round((Date.now() - s.startedAt) / 1000));
	const template =
		s.status === "running"
			? "wathet"
			: s.status === "stopped"
				? "indigo"
				: s.status === "blocked"
					? "yellow"
					: "red";
	const statusEmoji =
		s.status === "running"
			? "🟦"
			: s.status === "stopped"
				? "✅"
				: s.status === "blocked"
					? "⏸️"
					: "⚠️";
	const promptPreview = s.lastUserPrompt
		? `> ${truncate(s.lastUserPrompt, 240)}`
		: "_(no prompt captured yet)_";

	return {
		schema: "2.0",
		config: { wide_screen_mode: true },
		header: {
			template,
			title: {
				tag: "plain_text",
				content: `${statusEmoji} CC · ${s.projectName}`,
			},
			subtitle: {
				tag: "plain_text",
				content: `${s.shortId} · ${elapsedSec}s · ${s.toolCount} tools`,
			},
		},
		body: {
			elements: [
				{ tag: "markdown", content: promptPreview },
				{ tag: "hr" },
				{
					tag: "markdown",
					content: `<font color='grey'>cwd: ${s.cwd}</font>`,
				},
			],
		},
	};
}

function truncate(s: string, max: number): string {
	return s.length <= max ? s : `${s.slice(0, max)}…`;
}

// ── Turn-reply card ─────────────────────────────────
//
// Posted to the session's thread once per agent turn. Carries the actual
// claude code output (assistant text) so the user can read what the agent
// produced — not just metadata. Tool calls are folded into a one-line summary.

export interface TurnSummary {
	turnNumber: number;
	elapsedSec: number;
	assistantText: string;
	toolCounts: Record<string, number>;
}

const TURN_BODY_MAX = 8000;

export function buildTurnCard(
	s: SessionState,
	t: TurnSummary,
): Record<string, unknown> {
	const elements: Array<Record<string, unknown>> = [];

	let body = t.assistantText;
	let truncatedChars = 0;
	if (body.length > TURN_BODY_MAX) {
		truncatedChars = body.length - TURN_BODY_MAX;
		body = body.slice(0, TURN_BODY_MAX);
	}
	if (body) elements.push({ tag: "markdown", content: body });
	if (truncatedChars > 0) {
		elements.push({
			tag: "markdown",
			content: `<font color='grey'>… (后续 ${truncatedChars} 字符已截断)</font>`,
		});
	}

	const toolNames = Object.keys(t.toolCounts);
	if (toolNames.length > 0) {
		if (elements.length > 0) elements.push({ tag: "hr" });
		const summary = toolNames
			.sort((a, b) => (t.toolCounts[b] ?? 0) - (t.toolCounts[a] ?? 0))
			.map((n) => `${n}·${t.toolCounts[n]}`)
			.join(" · ");
		elements.push({
			tag: "markdown",
			content: `<font color='grey'>🛠 ${summary}</font>`,
		});
	}

	if (elements.length === 0) {
		elements.push({ tag: "markdown", content: "_(空回合)_" });
	}

	return {
		schema: "2.0",
		config: { wide_screen_mode: true },
		header: {
			template: "turquoise",
			title: {
				tag: "plain_text",
				content: `💬 ${s.projectName} · turn ${t.turnNumber}`,
			},
			subtitle: {
				tag: "plain_text",
				content: `${t.elapsedSec}s`,
			},
		},
		body: { elements },
	};
}

// ── Feishu send/update ──────────────────────────────

/**
 * Create the per-session thread root message in the CC progress chat.
 * Subsequent turn replies use `message.reply` to chain into the same thread,
 * which Feishu renders as a topic when the chat has 话题模式 enabled.
 */
async function sendThreadRoot(s: SessionState): Promise<void> {
	const client = getLarkClient();
	const chatId = targetChatId();
	if (!client || !chatId) {
		if (!client)
			console.warn("[cc-progress] Lark client not initialized — skipping root");
		if (!chatId)
			console.warn("[cc-progress] CC_PROGRESS_CHAT_ID not set — skipping root");
		return;
	}
	if (s.threadRootMessageId) return;

	const card = buildCard(s);
	try {
		const res = await client.im.v1.message.create({
			params: { receive_id_type: "chat_id" },
			data: {
				receive_id: chatId,
				msg_type: "interactive",
				content: JSON.stringify(card),
			},
		});
		const msgId = res?.data?.message_id;
		if (msgId) {
			s.threadRootMessageId = msgId;
			s.feishuMessageId = msgId; // back-compat
		}
	} catch (err: any) {
		console.error("[cc-progress] root create failed:", err?.message || err);
	}
}

/**
 * Read the transcript delta for this session, build a turn card, and reply
 * into the session's thread. Falls back to creating the root if it's missing
 * (e.g., a session that never fired UserPromptSubmit).
 */
async function sendThreadReply(s: SessionState): Promise<void> {
	const client = getLarkClient();
	const chatId = targetChatId();
	if (!client || !chatId) return;

	if (!s.threadRootMessageId) {
		await sendThreadRoot(s);
		if (!s.threadRootMessageId) return;
	}

	let delta: TranscriptDelta = {
		assistantText: "",
		toolCounts: {},
		newOffset: s.lastTranscriptOffset,
	};
	if (s.transcriptPath) {
		try {
			delta = await parseTranscriptDelta(
				s.transcriptPath,
				s.lastTranscriptOffset,
			);
		} catch (err: any) {
			console.warn(
				"[cc-progress] transcript parse failed:",
				err?.message || err,
			);
		}
	}

	const elapsedSec = Math.max(
		0,
		Math.round((Date.now() - s.currentTurnStartedAt) / 1000),
	);
	const card = buildTurnCard(s, {
		turnNumber: Math.max(1, s.turnNumber),
		elapsedSec,
		assistantText: delta.assistantText,
		toolCounts: delta.toolCounts,
	});

	try {
		await client.im.v1.message.reply({
			path: { message_id: s.threadRootMessageId! },
			data: {
				msg_type: "interactive",
				content: JSON.stringify(card),
				reply_in_thread: true,
			},
		});
		s.lastTranscriptOffset = delta.newOffset;
	} catch (err: any) {
		console.error("[cc-progress] turn reply failed:", err?.message || err);
	}
}


// ── Event handler ───────────────────────────────────

export function applyEvent(payload: CCEventPayload): SessionState | null {
	if (!payload?.session_id) return null;
	const event = payload.hook_event_name || payload.hook_event;
	const s = getOrCreate(payload.session_id, payload.cwd || "/");
	const now = Date.now();
	s.lastEventAt = now;

	// Always latch transcript_path the first time we see one — every hook
	// payload carries it, but UserPromptSubmit is the most reliable.
	if (payload.transcript_path && !s.transcriptPath) {
		s.transcriptPath = payload.transcript_path;
	}

	switch (event) {
		case "UserPromptSubmit":
			if (payload.prompt) s.lastUserPrompt = payload.prompt;
			s.status = "running";
			s.toolCount = 0;
			s.turnNumber++;
			s.currentTurnStartedAt = now;
			break;
		case "PreToolUse":
		case "PostToolUse":
			s.toolCount++;
			break;
		case "Stop":
			s.status = "stopped";
			break;
		case "Notification":
			s.status = "blocked";
			break;
		default:
			break;
	}
	return s;
}

// ── HTTP route ──────────────────────────────────────

export function registerCCProgressRoutes(app: Hono): void {
	app.post("/cc-event", async (c) => {
		let payload: CCEventPayload;
		try {
			payload = (await c.req.json()) as CCEventPayload;
		} catch {
			return c.json({ error: "invalid json" }, 400);
		}
		if (!payload?.session_id) {
			return c.json({ error: "session_id required" }, 400);
		}

		const state = applyEvent(payload);
		if (!state) return c.json({ error: "apply failed" }, 500);

		const event = payload.hook_event_name || payload.hook_event;
		// Fire-and-forget: hooks have a tight stdin/stdout budget on the CC
		// side, so we MUST return before doing IO. UserPromptSubmit creates
		// the per-session thread root the first time we see the session;
		// Stop appends each turn's claude-output as a reply into that thread.
		if (event === "UserPromptSubmit" && !state.threadRootMessageId) {
			sendThreadRoot(state).catch((err) => {
				console.error("[cc-progress] sendThreadRoot:", err);
			});
		} else if (event === "Stop") {
			sendThreadReply(state).catch((err) => {
				console.error("[cc-progress] sendThreadReply:", err);
			});
		}

		return c.json({
			ok: true,
			short_id: state.shortId,
			tool_count: state.toolCount,
			status: state.status,
		});
	});
}
