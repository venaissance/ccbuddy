import { describe, test, expect, beforeEach } from "bun:test";
import { Hono } from "hono";
import {
	applyEvent,
	buildCard,
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
