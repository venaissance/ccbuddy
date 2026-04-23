import { describe, expect, mock, test } from "bun:test";

// Mock node-cron so importing the module does not schedule anything
const mockSchedule = mock(() => {});
const mockValidate = mock((_s: string) => true);
mock.module("node-cron", () => ({
	default: { schedule: mockSchedule, validate: mockValidate },
	schedule: mockSchedule,
	validate: mockValidate,
}));

// Mock feishu-ws to decouple from the Lark SDK
mock.module("../../src/feishu-ws", () => ({
	getLarkClient: () => null,
}));

import {
	type DailyReport,
	type RunCostInfo,
	buildDailyCard,
	getDemoCost,
	getDemoReport,
	renderReportMarkdown,
	reportPath,
	todayStr,
	validateReport,
} from "../../src/daily-report";

function fixture(overrides: Partial<DailyReport> = {}): DailyReport {
	return {
		date: "2026-04-23",
		generated_at: "2026-04-23T07:05:12+08:00",
		window_hours: 24,
		sources_count: 82,
		wiki_url: "https://example.feishu.cn/wiki/WIKI_PLACEHOLDER",
		ai_news: [
			{
				title: "xAI 与 Cursor 合作",
				url: "https://x.ai/news/cursor",
				desc: "含 600 亿期权，共用 Colossus H100",
			},
			{
				title: "OpenAI 发布 GPT Image 2",
				url: "https://openai.com/gpt-image-2",
				desc: "图像加入推理与联网，API 支持 2K 输出",
			},
		],
		product_hunt: [
			{
				rank: 1,
				title: "Magic Layers by Canva",
				url: "https://www.producthunt.com/posts/magic-layers",
				desc: "图片转可编辑设计",
			},
		],
		github_trending: [
			{
				rank: 1,
				repo: "Fincept/FinceptTerminal",
				url: "https://github.com/Fincept/FinceptTerminal",
				desc: "金融终端",
				stars_added: 2548,
			},
		],
		sources_meta: {
			breakdown: ["Anthropic Blog", "HN", "arXiv"],
			method: "24h 窗口、80 源并检、全通过筛选、一手优先",
		},
		...overrides,
	};
}

describe("daily-report — date helpers", () => {
	test("todayStr formats YYYY-MM-DD with zero padding", () => {
		expect(todayStr(new Date(2026, 0, 9))).toBe("2026-01-09");
		expect(todayStr(new Date(2026, 11, 31))).toBe("2026-12-31");
	});

	test("reportPath uses data/daily-report directory", () => {
		expect(reportPath("2026-04-23")).toContain(
			"data/daily-report/2026-04-23.json",
		);
	});
});

describe("daily-report — validateReport", () => {
	test("accepts well-formed fixture", () => {
		expect(() => validateReport(fixture())).not.toThrow();
	});

	test("rejects non-object", () => {
		expect(() => validateReport(null)).toThrow(/not an object/);
		expect(() => validateReport("string")).toThrow(/not an object/);
	});

	test("rejects missing string fields", () => {
		const r: any = fixture();
		delete r.date;
		expect(() => validateReport(r)).toThrow(/missing field: date/);
	});

	test("rejects wrong numeric type", () => {
		const r: any = fixture();
		r.window_hours = "24";
		expect(() => validateReport(r)).toThrow(/window_hours/);
	});

	test("rejects empty arrays", () => {
		expect(() => validateReport(fixture({ ai_news: [] }))).toThrow(
			/ai_news.*>= 1/,
		);
		expect(() => validateReport(fixture({ product_hunt: [] }))).toThrow(
			/product_hunt.*>= 1/,
		);
		expect(() => validateReport(fixture({ github_trending: [] }))).toThrow(
			/github_trending.*>= 1/,
		);
	});

	test("rejects non-array", () => {
		const r: any = fixture();
		r.ai_news = "not an array";
		expect(() => validateReport(r)).toThrow(/ai_news must be array/);
	});
});

describe("daily-report — buildDailyCard", () => {
	test("produces schema 2.0 blue header", () => {
		const card: any = buildDailyCard(fixture());
		expect(card.schema).toBe("2.0");
		expect(card.header.template).toBe("blue");
		expect(card.header.title.content).toBe("📡 2026-04-23 AI Daily");
	});

	test("includes three main content sections", () => {
		const card: any = buildDailyCard(fixture());
		const body = card.body.elements
			.map((e: any) => JSON.stringify(e))
			.join("\n");
		expect(body).toContain("AI 重要新闻");
		expect(body).toContain("Product Hunt Top");
		expect(body).toContain("GitHub Trending Top");
	});

	test("renders hyperlinks in markdown for ai_news", () => {
		const card: any = buildDailyCard(fixture());
		const newsBlock = card.body.elements.find(
			(e: any) =>
				typeof e?.content === "string" && e.content.includes("AI 重要新闻"),
		);
		expect(newsBlock.content).toContain(
			"[xAI 与 Cursor 合作](https://x.ai/news/cursor)",
		);
	});

	test("renders stars_added for github trending", () => {
		const card: any = buildDailyCard(fixture());
		const ghBlock = card.body.elements.find(
			(e: any) =>
				typeof e?.content === "string" && e.content.includes("GitHub Trending"),
		);
		expect(ghBlock.content).toContain("⭐+2548");
	});

	test("omits stars_added when not provided", () => {
		const card: any = buildDailyCard(
			fixture({
				github_trending: [
					{
						rank: 1,
						repo: "foo/bar",
						url: "https://github.com/foo/bar",
						desc: "desc",
					},
				],
			}),
		);
		const ghBlock = card.body.elements.find(
			(e: any) =>
				typeof e?.content === "string" && e.content.includes("GitHub Trending"),
		);
		expect(ghBlock.content).not.toContain("⭐");
	});

	test("includes collapsible sources panel when sources_meta present", () => {
		const card: any = buildDailyCard(fixture());
		const panel = card.body.elements.find(
			(e: any) => e.tag === "collapsible_panel",
		);
		expect(panel).toBeDefined();
		expect(panel.expanded).toBe(false);
	});

	test("omits sources panel when sources_meta absent", () => {
		const card: any = buildDailyCard(fixture({ sources_meta: undefined }));
		const panel = card.body.elements.find(
			(e: any) => e.tag === "collapsible_panel",
		);
		expect(panel).toBeUndefined();
	});

	test("button appears only when wiki_url is set", () => {
		const with_btn: any = buildDailyCard(fixture());
		expect(with_btn.body.elements.some((e: any) => e.tag === "button")).toBe(
			true,
		);

		const no_btn: any = buildDailyCard(fixture({ wiki_url: undefined }));
		expect(no_btn.body.elements.some((e: any) => e.tag === "button")).toBe(
			false,
		);
	});

	test("metadata column_set shows date / sources / time", () => {
		const card: any = buildDailyCard(fixture());
		const cs = card.body.elements.find((e: any) => e.tag === "column_set");
		expect(cs).toBeDefined();
		expect(cs.columns).toHaveLength(3);
		const joined = JSON.stringify(cs.columns);
		expect(joined).toContain("2026-04-23");
		expect(joined).toContain("82");
		expect(joined).toContain("07:05");
	});

	test("escapes markdown-sensitive chars in descriptions", () => {
		const card: any = buildDailyCard(
			fixture({
				ai_news: [
					{
						title: "Test [brackets]",
						url: "https://example.com",
						desc: "desc with * and _",
					},
				],
			}),
		);
		const newsBlock = card.body.elements.find(
			(e: any) =>
				typeof e?.content === "string" && e.content.includes("AI 重要新闻"),
		);
		expect(newsBlock.content).toContain("Test \\[brackets\\]");
		expect(newsBlock.content).toContain("desc with \\* and \\_");
	});

	test("renders cost footer when cost info provided", () => {
		const cost: RunCostInfo = {
			cost_usd: 0.08,
			input_tokens: 12_000,
			output_tokens: 3_500,
			cache_read_tokens: 140_000,
			cache_creation_tokens: 5_000,
			duration_ms: 3 * 60_000 + 42_000,
		};
		const card: any = buildDailyCard(fixture(), cost);
		const body = card.body.elements
			.map((e: any) => JSON.stringify(e))
			.join("\n");
		expect(body).toContain("3m 42s");
		expect(body).toContain("¥");
		expect(body).toContain("$0.08");
		expect(body).toContain("↑");
		expect(body).toContain("↓");
	});

	test("omits cost footer when cost info absent", () => {
		const card: any = buildDailyCard(fixture());
		const body = card.body.elements
			.map((e: any) => JSON.stringify(e))
			.join("\n");
		// "¥" and "💰" appear only in the cost footer
		expect(body).not.toContain("¥");
		expect(body).not.toContain("💰");
	});

	test("demo cost fixture is valid", () => {
		const c = getDemoCost();
		expect(c.cost_usd).toBeGreaterThan(0);
		expect(c.output_tokens).toBeGreaterThan(0);
		expect(c.duration_ms).toBeGreaterThan(0);
	});

	test("renderReportMarkdown produces expected structure", () => {
		const md = renderReportMarkdown(fixture());
		expect(md).toContain("## 📡 2026-04-23 AI Daily");
		expect(md).toContain("### 📰 AI 重要新闻");
		expect(md).toContain("### 🚀 Product Hunt Top");
		expect(md).toContain("### 🔥 GitHub Trending Top");
		expect(md).toContain(
			"[xAI 与 Cursor 合作](https://x.ai/news/cursor)",
		);
		expect(md).toContain("⭐+2548");
		expect(md.trim().endsWith("---")).toBe(true);
	});

	test("demo fixture passes validation and builds a card", () => {
		const demo = getDemoReport();
		expect(() => validateReport(demo)).not.toThrow();
		expect(demo.ai_news.length).toBeGreaterThanOrEqual(9);
		expect(demo.product_hunt).toHaveLength(5);
		expect(demo.github_trending).toHaveLength(5);
		const card: any = buildDailyCard(demo);
		expect(card.header.template).toBe("blue");
	});

	test("news count in section header matches array length", () => {
		const card: any = buildDailyCard(
			fixture({
				ai_news: Array.from({ length: 9 }, (_, i) => ({
					title: `News ${i}`,
					url: `https://example.com/${i}`,
					desc: `d${i}`,
				})),
			}),
		);
		const newsBlock = card.body.elements.find(
			(e: any) =>
				typeof e?.content === "string" && e.content.includes("AI 重要新闻"),
		);
		expect(newsBlock.content).toContain("（9 条）");
	});
});
