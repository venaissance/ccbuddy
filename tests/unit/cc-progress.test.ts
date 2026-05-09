import { describe, test, expect, beforeEach } from "bun:test";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import {
	applyEvent,
	buildCard,
	buildTurnCard,
	parseTranscriptDelta,
	registerCCProgressRoutes,
	_getSessionsForTest,
	_resetSessionsForTest,
	type CCEventPayload,
} from "../../src/cc-progress";

describe("cc-progress applyEvent", () => {
	beforeEach(() => {
		_resetSessionsForTest();
	});

	test("UserPromptSubmit creates session, captures prompt, resets toolCount", () => {
		const s = applyEvent({
			hook_event_name: "UserPromptSubmit",
			session_id: "abcdef0123456789-uuid",
			cwd: "/home/me/project-x",
			prompt: "fix the auth bug",
		});
		expect(s).not.toBeNull();
		expect(s!.shortId).toBe("abcdef01");
		expect(s!.projectName).toBe("project-x");
		expect(s!.lastUserPrompt).toBe("fix the auth bug");
		expect(s!.toolCount).toBe(0);
		expect(s!.status).toBe("running");
	});

	test("PreToolUse / PostToolUse increments toolCount", () => {
		applyEvent({
			hook_event_name: "UserPromptSubmit",
			session_id: "s1",
			cwd: "/x",
			prompt: "p",
		});
		applyEvent({
			hook_event_name: "PreToolUse",
			session_id: "s1",
			cwd: "/x",
		});
		applyEvent({
			hook_event_name: "PostToolUse",
			session_id: "s1",
			cwd: "/x",
		});
		const s = _getSessionsForTest().get("s1");
		expect(s!.toolCount).toBe(2);
	});

	test("Stop sets status=stopped without resetting state", () => {
		applyEvent({
			hook_event_name: "UserPromptSubmit",
			session_id: "s2",
			cwd: "/y",
			prompt: "ship it",
		});
		applyEvent({
			hook_event_name: "PreToolUse",
			session_id: "s2",
			cwd: "/y",
		});
		const s = applyEvent({
			hook_event_name: "Stop",
			session_id: "s2",
			cwd: "/y",
		});
		expect(s!.status).toBe("stopped");
		expect(s!.lastUserPrompt).toBe("ship it");
		expect(s!.toolCount).toBe(1);
	});

	test("Notification sets status=blocked", () => {
		const s = applyEvent({
			hook_event_name: "Notification",
			session_id: "s3",
			cwd: "/z",
			message: "permission required",
		});
		expect(s!.status).toBe("blocked");
	});

	test("missing session_id returns null", () => {
		const s = applyEvent({
			hook_event_name: "Stop",
		} as CCEventPayload);
		expect(s).toBeNull();
	});

	test("hook_event field also accepted (alias for hook_event_name)", () => {
		const s = applyEvent({
			hook_event: "Stop",
			session_id: "s4",
			cwd: "/a",
		} as CCEventPayload);
		expect(s!.status).toBe("stopped");
	});
});

describe("cc-progress buildCard", () => {
	beforeEach(() => {
		_resetSessionsForTest();
	});

	test("running state uses wathet template + 🟦 emoji", () => {
		const s = applyEvent({
			hook_event_name: "UserPromptSubmit",
			session_id: "abcdef01-1234",
			cwd: "/work/myproject",
			prompt: "do a thing",
		})!;
		const card = buildCard(s) as any;
		expect(card.schema).toBe("2.0");
		expect(card.header.template).toBe("wathet");
		expect(card.header.title.content).toContain("🟦");
		expect(card.header.title.content).toContain("myproject");
		expect(card.header.subtitle.content).toContain("abcdef01");
	});

	test("stopped state uses indigo template + ✅ emoji", () => {
		applyEvent({
			hook_event_name: "UserPromptSubmit",
			session_id: "s5",
			cwd: "/p",
			prompt: "x",
		});
		const s = applyEvent({
			hook_event_name: "Stop",
			session_id: "s5",
			cwd: "/p",
		})!;
		const card = buildCard(s) as any;
		expect(card.header.template).toBe("indigo");
		expect(card.header.title.content).toContain("✅");
	});

	test("body contains markdown prompt + cwd note", () => {
		const s = applyEvent({
			hook_event_name: "UserPromptSubmit",
			session_id: "s6",
			cwd: "/w/proj",
			prompt: "the prompt",
		})!;
		const card = buildCard(s) as any;
		const elements = card.body.elements;
		expect(elements[0].tag).toBe("markdown");
		expect(elements[0].content).toContain("the prompt");
		expect(elements[2].tag).toBe("markdown");
		expect(elements[2].content).toContain("/w/proj");
	});

	test("long prompt is truncated", () => {
		const longPrompt = "x".repeat(500);
		const s = applyEvent({
			hook_event_name: "UserPromptSubmit",
			session_id: "s7",
			cwd: "/q",
			prompt: longPrompt,
		})!;
		const card = buildCard(s) as any;
		expect(card.body.elements[0].content.length).toBeLessThan(longPrompt.length + 10);
		expect(card.body.elements[0].content).toContain("…");
	});
});

describe("cc-progress route", () => {
	let app: Hono;

	beforeEach(() => {
		_resetSessionsForTest();
		app = new Hono();
		registerCCProgressRoutes(app);
	});

	test("POST /cc-event with valid Stop returns ok", async () => {
		const res = await app.request("/cc-event", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				hook_event_name: "Stop",
				session_id: "route-test-1",
				cwd: "/r",
			}),
		});
		expect(res.status).toBe(200);
		const json = (await res.json()) as any;
		expect(json.ok).toBe(true);
		expect(json.short_id).toBe("route-te");
		expect(json.status).toBe("stopped");
	});

	test("POST /cc-event without session_id returns 400", async () => {
		const res = await app.request("/cc-event", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ hook_event_name: "Stop" }),
		});
		expect(res.status).toBe(400);
	});

	test("POST /cc-event with bad JSON returns 400", async () => {
		const res = await app.request("/cc-event", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: "not json",
		});
		expect(res.status).toBe(400);
	});
});

describe("cc-progress parseTranscriptDelta", () => {
	function writeFixture(lines: object[]): string {
		const dir = mkdtempSync(join(tmpdir(), "cc-progress-"));
		const path = join(dir, "transcript.jsonl");
		writeFileSync(path, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
		return path;
	}

	test("extracts assistant text and tool counts, skipping thinking/tool_result", async () => {
		const path = writeFixture([
			{
				type: "user",
				message: { content: [{ type: "text", text: "hello" }] },
			},
			{
				type: "assistant",
				message: {
					content: [
						{ type: "thinking", thinking: "internal" },
						{ type: "text", text: "Hi! Let me check." },
						{ type: "tool_use", name: "Read", input: {} },
					],
				},
			},
			{
				type: "user",
				message: {
					content: [{ type: "tool_result", content: "file contents" }],
				},
			},
			{
				type: "assistant",
				message: {
					content: [
						{ type: "text", text: "Found it." },
						{ type: "tool_use", name: "Bash", input: {} },
						{ type: "tool_use", name: "Read", input: {} },
					],
				},
			},
		]);
		const r = await parseTranscriptDelta(path, 0);
		expect(r.assistantText).toContain("Hi! Let me check.");
		expect(r.assistantText).toContain("Found it.");
		expect(r.assistantText).not.toContain("internal");
		expect(r.assistantText).not.toContain("file contents");
		expect(r.toolCounts).toEqual({ Read: 2, Bash: 1 });
		expect(r.newOffset).toBeGreaterThan(0);
	});

	test("incremental: starting from previous offset returns only new content", async () => {
		const dir = mkdtempSync(join(tmpdir(), "cc-progress-"));
		const path = join(dir, "transcript.jsonl");
		// First write
		writeFileSync(
			path,
			JSON.stringify({
				type: "assistant",
				message: { content: [{ type: "text", text: "first" }] },
			}) + "\n",
		);
		const r1 = await parseTranscriptDelta(path, 0);
		expect(r1.assistantText).toContain("first");

		// Append second turn
		const append =
			JSON.stringify({
				type: "assistant",
				message: { content: [{ type: "text", text: "second" }] },
			}) + "\n";
		writeFileSync(path, JSON.stringify({
			type: "assistant",
			message: { content: [{ type: "text", text: "first" }] },
		}) + "\n" + append);
		const r2 = await parseTranscriptDelta(path, r1.newOffset);
		expect(r2.assistantText).toContain("second");
		expect(r2.assistantText).not.toContain("first");
	});

	test("missing file returns empty result", async () => {
		const r = await parseTranscriptDelta("/nonexistent/path", 0);
		expect(r.assistantText).toBe("");
		expect(r.toolCounts).toEqual({});
		expect(r.newOffset).toBe(0);
	});
});

describe("cc-progress buildTurnCard", () => {
	beforeEach(() => {
		_resetSessionsForTest();
	});

	test("includes assistant text and folded tool summary", () => {
		const s = applyEvent({
			hook_event_name: "UserPromptSubmit",
			session_id: "abcdef0123456789",
			cwd: "/work/proj",
			prompt: "do thing",
		})!;
		const card = buildTurnCard(s, {
			turnNumber: 1,
			elapsedSec: 42,
			assistantText: "Hello, here is what I found.\n\nSome details.",
			toolCounts: { Read: 3, Bash: 1, Edit: 2 },
		}) as any;

		expect(card.schema).toBe("2.0");
		const md = card.body.elements
			.map((e: any) => e.content || "")
			.join("\n");
		expect(md).toContain("Hello, here is what I found.");
		expect(md).toContain("Some details.");
		expect(md).toMatch(/Read.{0,3}3/); // "Read·3" or "Read×3"
		expect(md).toContain("Bash");
		expect(md).toContain("Edit");
	});

	test("no tool calls renders without tool footer", () => {
		const s = applyEvent({
			hook_event_name: "UserPromptSubmit",
			session_id: "s1",
			cwd: "/x",
			prompt: "p",
		})!;
		const card = buildTurnCard(s, {
			turnNumber: 1,
			elapsedSec: 5,
			assistantText: "just talking",
			toolCounts: {},
		}) as any;
		const md = card.body.elements
			.map((e: any) => e.content || "")
			.join("\n");
		expect(md).toContain("just talking");
		expect(md).not.toMatch(/工具|tools/i);
	});

	test("very long assistant text gets truncated with marker", () => {
		const s = applyEvent({
			hook_event_name: "UserPromptSubmit",
			session_id: "s2",
			cwd: "/y",
			prompt: "p",
		})!;
		const long = "x".repeat(10_000);
		const card = buildTurnCard(s, {
			turnNumber: 1,
			elapsedSec: 1,
			assistantText: long,
			toolCounts: {},
		}) as any;
		const md = card.body.elements
			.map((e: any) => e.content || "")
			.join("\n");
		expect(md.length).toBeLessThan(long.length);
		expect(md).toMatch(/截断|truncated|…/);
	});

	test("empty assistant text falls back to placeholder", () => {
		const s = applyEvent({
			hook_event_name: "UserPromptSubmit",
			session_id: "s3",
			cwd: "/z",
			prompt: "p",
		})!;
		const card = buildTurnCard(s, {
			turnNumber: 1,
			elapsedSec: 1,
			assistantText: "",
			toolCounts: { Read: 1 },
		}) as any;
		const md = card.body.elements
			.map((e: any) => e.content || "")
			.join("\n");
		// Should still render something (the tool summary at least)
		expect(md).toContain("Read");
	});
});
