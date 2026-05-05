/**
 * CC Progress — receives Claude Code hook events and pushes per-session
 * progress cards to Feishu IM. Each session = one card that updates in place.
 *
 * Phase 1: Stop hook drives the card. UserPromptSubmit populates state so
 * the Stop card has context. Other hooks (PreToolUse/PostToolUse/Notification)
 * accepted but only update in-memory state, no card update yet.
 */

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
	feishuMessageId?: string;
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
		s = {
			sessionId,
			shortId: shortId(sessionId),
			cwd,
			projectName: projectName(cwd),
			startedAt: Date.now(),
			lastEventAt: Date.now(),
			toolCount: 0,
			status: "running",
		};
		sessions.set(sessionId, s);
	}
	return s;
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

// ── Feishu send/update ──────────────────────────────

async function sendOrUpdateCard(s: SessionState): Promise<void> {
	const client = getLarkClient();
	const chatId = targetChatId();
	if (!client) {
		console.warn("[cc-progress] Lark client not initialized — skipping card");
		return;
	}
	if (!chatId) {
		console.warn(
			"[cc-progress] CC_PROGRESS_CHAT_ID / DAILY_REPORT_CHAT_ID not set — skipping card",
		);
		return;
	}

	const card = buildCard(s);
	const content = JSON.stringify(card);

	if (!s.feishuMessageId) {
		try {
			const res = await client.im.v1.message.create({
				params: { receive_id_type: "chat_id" },
				data: {
					receive_id: chatId,
					msg_type: "interactive",
					content,
				},
			});
			const msgId = res?.data?.message_id;
			if (msgId) s.feishuMessageId = msgId;
		} catch (err: any) {
			console.error(
				"[cc-progress] card create failed:",
				err?.message || err,
			);
		}
		return;
	}

	try {
		await client.im.message.patch({
			path: { message_id: s.feishuMessageId },
			data: { content },
		});
	} catch (err: any) {
		console.error(
			"[cc-progress] card patch failed:",
			err?.message || err,
		);
	}
}

// ── Event handler ───────────────────────────────────

export function applyEvent(payload: CCEventPayload): SessionState | null {
	if (!payload?.session_id) return null;
	const event = payload.hook_event_name || payload.hook_event;
	const s = getOrCreate(payload.session_id, payload.cwd || "/");
	s.lastEventAt = Date.now();

	switch (event) {
		case "UserPromptSubmit":
			if (payload.prompt) s.lastUserPrompt = payload.prompt;
			s.status = "running";
			s.toolCount = 0;
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

function shouldEmitCard(event: CCHookEvent | undefined): boolean {
	// Phase 1: only Stop drives the card update.
	return event === "Stop";
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
		if (shouldEmitCard(event)) {
			// Fire-and-forget so the hook returns fast (<= 2s budget).
			sendOrUpdateCard(state).catch((err) => {
				console.error("[cc-progress] sendOrUpdateCard:", err);
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
