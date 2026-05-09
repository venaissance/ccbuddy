import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import cron from "node-cron";
import type { AgentOptions, AgentResult } from "./agent";
import { getLarkClient } from "./feishu-ws";
import { formatCostCNY, recordUsage } from "./usage";

// ── Types ───────────────────────────────────────────

export interface NewsItem {
	title: string;
	url: string;
	desc: string;
}

export interface ProductHuntItem {
	rank: number;
	title: string;
	url: string;
	desc: string;
}

export interface GitHubTrendingItem {
	rank: number;
	repo: string;
	url: string;
	desc: string;
	stars_added?: number;
}

export interface SourcesMeta {
	breakdown: string[];
	method: string;
}

export interface DailyReport {
	date: string;
	generated_at: string;
	window_hours: number;
	sources_count: number;
	wiki_url?: string;
	ai_news: NewsItem[];
	product_hunt: ProductHuntItem[];
	github_trending: GitHubTrendingItem[];
	sources_meta?: SourcesMeta;
}

/** Captured by the daemon after agent.onEnd fires — stored in a sidecar file. */
export interface RunCostInfo {
	cost_usd: number;
	input_tokens: number;
	output_tokens: number;
	cache_read_tokens: number;
	cache_creation_tokens: number;
	duration_ms: number;
}

// ── Config ──────────────────────────────────────────

const DEFAULT_CRON = "0 7 * * *";
const REPORT_DIR = "./data/daily-report";
const SESSION_PREFIX = "daily-report";

function cfg() {
	return {
		chatId: process.env.DAILY_REPORT_CHAT_ID || "",
		wikiToken: process.env.DAILY_REPORT_WIKI_TOKEN || "",
		schedule: process.env.DAILY_REPORT_CRON || DEFAULT_CRON,
		timezone: process.env.DAILY_REPORT_TZ || "Asia/Shanghai",
	};
}

// ── Date Helpers ────────────────────────────────────

export function todayStr(now: Date = new Date()): string {
	const y = now.getFullYear();
	const m = String(now.getMonth() + 1).padStart(2, "0");
	const d = String(now.getDate()).padStart(2, "0");
	return `${y}-${m}-${d}`;
}

export function reportPath(date: string): string {
	return join(REPORT_DIR, `${date}.json`);
}

export function costPath(date: string): string {
	return join(REPORT_DIR, `${date}.cost.json`);
}

async function saveCost(date: string, info: RunCostInfo): Promise<void> {
	await writeFile(costPath(date), JSON.stringify(info, null, 2), "utf-8");
}

async function loadCost(date: string): Promise<RunCostInfo | undefined> {
	try {
		if (!existsSync(costPath(date))) return undefined;
		return JSON.parse(await readFile(costPath(date), "utf-8"));
	} catch {
		return undefined;
	}
}

function fmtTokens(n: number): string {
	if (n < 1000) return String(n);
	if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
	return `${(n / 1_000_000).toFixed(2)}M`;
}

function fmtDuration(ms: number): string {
	const s = Math.round(ms / 1000);
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	const rs = s % 60;
	return rs ? `${m}m ${rs}s` : `${m}m`;
}

// ── JSON Loader + Validator ─────────────────────────

export function validateReport(raw: unknown): DailyReport {
	if (!raw || typeof raw !== "object") throw new Error("report not an object");
	const r = raw as Record<string, unknown>;
	const reqStr = (k: string) => {
		if (typeof r[k] !== "string" || !r[k])
			throw new Error(`missing field: ${k}`);
	};
	reqStr("date");
	reqStr("generated_at");
	if (typeof r.window_hours !== "number")
		throw new Error("window_hours must be number");
	if (typeof r.sources_count !== "number")
		throw new Error("sources_count must be number");

	const arr = (k: string, min: number) => {
		if (!Array.isArray(r[k])) throw new Error(`${k} must be array`);
		if ((r[k] as unknown[]).length < min)
			throw new Error(`${k} must have >= ${min} items`);
	};
	arr("ai_news", 1);
	arr("product_hunt", 1);
	arr("github_trending", 1);

	return r as unknown as DailyReport;
}

export async function loadReport(date: string): Promise<DailyReport> {
	const p = reportPath(date);
	if (!existsSync(p)) throw new Error(`report file missing: ${p}`);
	const raw = JSON.parse(await readFile(p, "utf-8"));
	return validateReport(raw);
}

// ── Card Builder ────────────────────────────────────

/** Escape markdown-sensitive chars in plain descriptions (preserve punctuation). */
function esc(s: string): string {
	return s.replace(/([\[\]()`*_])/g, "\\$1");
}

function renderNewsList(items: NewsItem[]): string {
	return items
		.map((it) => `- [${esc(it.title)}](${it.url}) — ${esc(it.desc)}`)
		.join("\n");
}

function renderProductHunt(items: ProductHuntItem[]): string {
	return items
		.map((it) => `${it.rank}. [${esc(it.title)}](${it.url}) — ${esc(it.desc)}`)
		.join("\n");
}

function renderGithubTrending(items: GitHubTrendingItem[]): string {
	return items
		.map((it) => {
			const stars = it.stars_added ? ` ⭐+${it.stars_added}` : "";
			return `${it.rank}. [${esc(it.repo)}](${it.url}) — ${esc(it.desc)}${stars}`;
		})
		.join("\n");
}

/** Build the dedicated daily-report card (independent from StreamingCard). */
export function buildDailyCard(
	report: DailyReport,
	cost?: RunCostInfo,
): object {
	const newsCount = report.ai_news.length;
	const elements: any[] = [];

	// Metadata strip (column_set)
	elements.push({
		tag: "column_set",
		flex_mode: "none",
		background_style: "grey",
		columns: [
			{
				tag: "column",
				width: "weighted",
				weight: 1,
				elements: [
					{
						tag: "markdown",
						content: `📅 **${report.date}**\n窗口 ${report.window_hours}h`,
						text_align: "center",
						text_size: "notation",
					},
				],
			},
			{
				tag: "column",
				width: "weighted",
				weight: 1,
				elements: [
					{
						tag: "markdown",
						content: `📊 **${report.sources_count} 源**\n精选 ${newsCount} 条`,
						text_align: "center",
						text_size: "notation",
					},
				],
			},
			{
				tag: "column",
				width: "weighted",
				weight: 1,
				elements: [
					{
						tag: "markdown",
						content: `⏱ **${report.generated_at.slice(11, 16)}**\n自动生成`,
						text_align: "center",
						text_size: "notation",
					},
				],
			},
		],
	});

	elements.push({ tag: "hr" });

	// AI News
	elements.push({
		tag: "markdown",
		content: `📰 **AI 重要新闻（${newsCount} 条）**\n\n${renderNewsList(report.ai_news)}`,
	});

	elements.push({ tag: "hr" });

	// Product Hunt
	elements.push({
		tag: "markdown",
		content: `🚀 **Product Hunt Top ${report.product_hunt.length}**\n\n${renderProductHunt(report.product_hunt)}`,
	});

	elements.push({ tag: "hr" });

	// GitHub Trending
	elements.push({
		tag: "markdown",
		content: `🔥 **GitHub Trending Top ${report.github_trending.length}**\n\n${renderGithubTrending(report.github_trending)}`,
	});

	// Optional sources meta (collapsible)
	if (report.sources_meta) {
		elements.push({ tag: "hr" });
		const srcList = report.sources_meta.breakdown.join("、");
		elements.push({
			tag: "collapsible_panel",
			expanded: false,
			header: {
				title: { tag: "lark_md", content: "📎 **本期覆盖源与筛选方法**" },
				background_color: "grey",
			},
			elements: [
				{
					tag: "markdown",
					content: `**方法**：${esc(report.sources_meta.method)}\n\n**来源（${report.sources_meta.breakdown.length}）**：${esc(srcList)}`,
					text_size: "notation",
				},
			],
		});
	}

	// Cost footer (notation-size, subtle)
	if (cost) {
		const inTokens =
			cost.input_tokens + cost.cache_read_tokens + cost.cache_creation_tokens;
		const parts = [
			`⏱ ${fmtDuration(cost.duration_ms)}`,
			`💰 ${formatCostCNY(cost.cost_usd)}（$${cost.cost_usd.toFixed(2)}）`,
			`${fmtTokens(inTokens)}↑ ${fmtTokens(cost.output_tokens)}↓`,
		];
		if (cost.cache_read_tokens > 0) {
			parts.push(`cache ${fmtTokens(cost.cache_read_tokens)}`);
		}
		elements.push({ tag: "hr" });
		elements.push({
			tag: "markdown",
			text_size: "notation",
			content: parts.join(" · "),
		});
	}

	// Wiki link button
	if (report.wiki_url) {
		elements.push({ tag: "hr" });
		elements.push({
			tag: "button",
			text: { tag: "plain_text", content: "📡 查看历史日报" },
			type: "default",
			multi_url: {
				url: report.wiki_url,
				pc_url: report.wiki_url,
				android_url: report.wiki_url,
				ios_url: report.wiki_url,
			},
		});
	}

	return {
		schema: "2.0",
		config: { wide_screen_mode: true },
		header: {
			title: { tag: "plain_text", content: `📡 ${report.date} AI Daily` },
			template: "blue",
		},
		body: { elements },
	};
}

// ── Markdown Renderer (for wiki append) ─────────────

export function renderReportMarkdown(report: DailyReport): string {
	const lines: string[] = [];
	lines.push(`## 📡 ${report.date} AI Daily`);
	lines.push("");
	lines.push(
		`> 📅 ${report.date} · 📊 ${report.sources_count} 源 · ⏱ ${report.generated_at} · 窗口 ${report.window_hours}h`,
	);
	lines.push("");
	lines.push(`### 📰 AI 重要新闻（${report.ai_news.length} 条）`);
	lines.push("");
	for (const it of report.ai_news) {
		lines.push(`- [${it.title}](${it.url}) — ${it.desc}`);
	}
	lines.push("");
	lines.push(`### 🚀 Product Hunt Top ${report.product_hunt.length}`);
	lines.push("");
	for (const it of report.product_hunt) {
		lines.push(`${it.rank}. [${it.title}](${it.url}) — ${it.desc}`);
	}
	lines.push("");
	lines.push(`### 🔥 GitHub Trending Top ${report.github_trending.length}`);
	lines.push("");
	for (const it of report.github_trending) {
		const stars = it.stars_added ? ` ⭐+${it.stars_added}` : "";
		lines.push(`${it.rank}. [${it.repo}](${it.url}) — ${it.desc}${stars}`);
	}
	lines.push("");
	lines.push("---");
	lines.push("");
	return lines.join("\n");
}

/** Permission-error fingerprint helper — used both inline and by the alert formatter. */
export function isWikiPermissionError(err: unknown): boolean {
	const msg = String((err as any)?.message ?? err ?? "");
	return /permission denied|node permission|3380004|131006|forBidden|view or edit access/i.test(
		msg,
	);
}

/** List of YYYY-MM-DD dates that have a successful report JSON, newest first. */
async function listArchivedDates(): Promise<string[]> {
	try {
		const files = await readdir(REPORT_DIR);
		const dates = files
			.filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
			.map((f) => f.replace(".json", ""));
		dates.sort();
		dates.reverse();
		return dates;
	} catch {
		return [];
	}
}

/**
 * Render the entire archive as a single markdown document, newest-first.
 * Skips dates whose JSON fails to load — keeps wiki sync resilient against
 * partial/broken files.
 */
async function renderArchiveMarkdown(
	currentReport?: DailyReport,
): Promise<string> {
	const dates = await listArchivedDates();
	const sections: string[] = [];
	if (currentReport) {
		// Use the in-memory current report (with wiki_url injected) instead of
		// reloading from disk to avoid a race with the just-written file.
		sections.push(renderReportMarkdown(currentReport));
	}
	for (const date of dates) {
		if (currentReport && date === currentReport.date) continue;
		try {
			const r = await loadReport(date);
			sections.push(renderReportMarkdown(r));
		} catch (err) {
			console.warn(`[daily-report] Skipping ${date} in archive sync:`, err);
		}
	}
	return sections.join("\n\n");
}

/**
 * Sync the wiki page from the archive: rebuild the entire document content
 * with all reports newest-first via docs_ai overwrite. The wiki is a
 * machine-maintained archive — manual edits will be lost, by design.
 *
 * Uses the daemon's Lark SDK (FEISHU_APP_ID) which holds the correct tenant
 * permissions. Falls back to lark-cli for transient SDK errors only;
 * permission errors fail fast (different tenant won't help).
 */
export async function syncWikiFromArchive(
	wikiToken: string,
	currentReport?: DailyReport,
): Promise<void> {
	const markdown = await renderArchiveMarkdown(currentReport);
	if (!markdown.trim()) {
		console.warn("[daily-report] Wiki sync skipped — empty archive");
		return;
	}

	try {
		await syncWikiViaSDK(wikiToken, markdown);
		console.log(
			`[daily-report] Wiki synced via SDK (${markdown.length} chars, newest-first)`,
		);
		return;
	} catch (sdkErr: any) {
		if (isWikiPermissionError(sdkErr)) {
			throw sdkErr;
		}
		console.warn(
			"[daily-report] SDK sync failed, falling back to lark-cli:",
			sdkErr?.message || sdkErr,
		);
	}
	await syncWikiViaCli(wikiToken, markdown);
	console.log(
		`[daily-report] Wiki synced via lark-cli fallback (${markdown.length} chars, newest-first)`,
	);
}

/** Resolve wiki node → docx token, then docs_ai overwrite with markdown. */
async function syncWikiViaSDK(
	wikiToken: string,
	markdown: string,
): Promise<void> {
	const client = getLarkClient();
	if (!client) throw new Error("lark client not initialized");

	const nodeResp: any = await (client as any).wiki.v2.space.getNode({
		params: { token: wikiToken, obj_type: "wiki" },
	});
	const docToken = nodeResp?.data?.node?.obj_token;
	if (!docToken) {
		throw new Error(
			`wiki node lookup returned no obj_token (resp=${JSON.stringify(nodeResp)?.slice(0, 200)})`,
		);
	}

	const updateResp: any = await (client as any).request({
		method: "PUT",
		url: `/open-apis/docs_ai/v1/documents/${docToken}`,
		data: {
			block_id: "-1",
			command: "overwrite",
			content: markdown,
			format: "markdown",
			revision_id: -1,
		},
	});
	if (updateResp?.code && updateResp.code !== 0) {
		throw new Error(
			`docs_ai overwrite returned code=${updateResp.code} msg=${updateResp.msg}`,
		);
	}
}

/** Fallback path — lark-cli with the same overwrite semantics (different tenant identity). */
async function syncWikiViaCli(
	wikiToken: string,
	markdown: string,
): Promise<void> {
	const docUrl = `https://midawang.feishu.cn/wiki/${wikiToken}`;
	await new Promise<void>((resolvePromise, reject) => {
		const proc = spawn(
			"lark-cli",
			[
				"docs",
				"+update",
				"--api-version",
				"v2",
				"--doc",
				docUrl,
				"--command",
				"overwrite",
				"--doc-format",
				"markdown",
				"--content",
				markdown,
			],
			{
				stdio: ["ignore", "pipe", "pipe"],
				env: { ...process.env, LARK_CLI_NO_PROXY: "1" },
			},
		);
		let stdout = "";
		let stderr = "";
		proc.stdout.on("data", (d) => {
			stdout += d.toString();
		});
		proc.stderr.on("data", (d) => {
			stderr += d.toString();
		});
		proc.on("close", (code) => {
			if (code === 0) {
				resolvePromise();
			} else {
				reject(
					new Error(
						`lark-cli exited ${code}: ${stderr.slice(0, 500) || stdout.slice(0, 500)}`,
					),
				);
			}
		});
		proc.on("error", (err) => {
			reject(new Error(`lark-cli spawn failed: ${err.message}`));
		});
	});
}

// ── Senders ─────────────────────────────────────────

export async function sendCardToChat(
	chatId: string,
	card: object,
): Promise<void> {
	const client = getLarkClient();
	if (!client) throw new Error("lark client not initialized");
	await client.im.v1.message.create({
		params: { receive_id_type: "chat_id" },
		data: {
			receive_id: chatId,
			msg_type: "interactive",
			content: JSON.stringify(card),
		},
	});
}

export async function sendTextAlert(
	chatId: string,
	text: string,
): Promise<void> {
	const client = getLarkClient();
	if (!client) {
		console.error("[daily-report] Cannot send alert — no lark client:", text);
		return;
	}
	try {
		await client.im.v1.message.create({
			params: { receive_id_type: "chat_id" },
			data: {
				receive_id: chatId,
				msg_type: "text",
				content: JSON.stringify({ text }),
			},
		});
	} catch (err: any) {
		console.error("[daily-report] Alert send failed:", err?.message || err);
	}
}

// ── Guard ───────────────────────────────────────────

class RunGuard {
	private running = false;
	tryAcquire(): boolean {
		if (this.running) return false;
		this.running = true;
		return true;
	}
	release(): void {
		this.running = false;
	}
	isRunning(): boolean {
		return this.running;
	}
}

/** Module-level guard shared across cron + slash command — avoids concurrent agent runs. */
const agentGuard = new RunGuard();

// ── Runner ──────────────────────────────────────────

export interface RunOptions {
	date?: string;
	/** Which chat to send the final card / alert to. Required. */
	targetChatId: string;
	/** Skip agent invocation — render from existing JSON on disk (fast style iteration). */
	skipAgent?: boolean;
	runAgent?: (options: AgentOptions) => Promise<void>;
}

/** Core runner — targets any chat. Used by both cron and /daily-report command. */
export async function runDailyReportOnce(opts: RunOptions): Promise<void> {
	const { targetChatId, skipAgent } = opts;
	const date = opts.date || todayStr();
	const outPath = reportPath(date);

	if (!targetChatId) {
		console.warn("[daily-report] Missing targetChatId, skip");
		return;
	}

	// Skip-agent path: render from existing JSON (fast iteration)
	if (skipAgent) {
		try {
			const report = await loadReport(date);
			const cost = await loadCost(date);
			await sendCardToChat(targetChatId, buildDailyCard(report, cost));
			console.log(`[daily-report] Rendered cached report for ${date}`);
		} catch (err: any) {
			await sendTextAlert(
				targetChatId,
				`⚠️ 渲染 ${date} 日报失败\n\n${err?.message || err}\n\n（可能是 JSON 文件不存在或格式错误）`,
			);
		}
		return;
	}

	// Agent path — guarded
	if (!opts.runAgent) {
		throw new Error("runAgent required when skipAgent is false");
	}
	if (!agentGuard.tryAcquire()) {
		await sendTextAlert(
			targetChatId,
			"⏳ 另一份日报正在生成中，稍等几分钟再试。",
		);
		return;
	}

	await mkdir(dirname(outPath), { recursive: true });
	// Agent CWD is ./data (DEFAULT_AGENT_CWD in agent.ts); pass absolute path
	// so Claude writes to the exact location the daemon reads from.
	const absOutPath = resolve(outPath);

	// Delete stale JSON so agent can't shortcut by reading yesterday's file.
	// Same-day reruns also regenerate fresh content.
	if (existsSync(absOutPath)) {
		try {
			await unlink(absOutPath);
			console.log(`[daily-report] Cleared stale ${date}.json before agent run`);
		} catch (err) {
			console.warn("[daily-report] Could not clear stale JSON:", err);
		}
	}

	const prompt = buildAgentPrompt(date, absOutPath);
	const runStartedAt = Date.now();
	const WATCHDOG_MS = Number(process.env.DAILY_REPORT_TIMEOUT_MS || 15 * 60_000);
	let capturedResult: AgentResult | null = null;
	let toolCalls = 0;
	let timedOut = false;

	try {
		await new Promise<void>((resolvePromise) => {
			let settled = false;
			const settle = () => {
				if (settled) return;
				settled = true;
				agentGuard.release();
				resolvePromise();
			};

			const watchdog = setTimeout(() => {
				timedOut = true;
				console.warn(
					`[daily-report] ${date} watchdog fired after ${WATCHDOG_MS}ms — killing agent`,
				);
				try {
					// Kill the agent claude subprocess by session id. Best-effort:
					// find and SIGTERM any `claude ... daily-report-${date}` pid.
					spawn("pkill", ["-f", `claude.*daily-report-${date}`]).on(
						"close",
						() => settle(),
					);
				} catch {
					settle();
				}
			}, WATCHDOG_MS);

			opts.runAgent!({
				sessionId: `${SESSION_PREFIX}-${date}`,
				prompt,
				onStream: (chunk) => {
					if (chunk.type === "tool_use") {
						toolCalls++;
						if (toolCalls % 5 === 0) {
							console.log(
								`[daily-report] ${date} progress: ${toolCalls} tool calls`,
							);
						}
					}
				},
				onEnd: (result) => {
					clearTimeout(watchdog);
					capturedResult = result;
					console.log(
						`[daily-report] ${date} agent finished: ${toolCalls} tool calls, ${result.usage.outputTokens} out tokens`,
					);
					settle();
				},
				onError: (err) => {
					clearTimeout(watchdog);
					console.error("[daily-report] Agent error:", err);
					settle();
				},
			});
		});
	} catch (err: any) {
		agentGuard.release();
		await sendTextAlert(
			targetChatId,
			`⚠️ AI 日报生成失败（${date}）\n\nAgent 执行异常: ${err?.message || err}`,
		);
		return;
	}

	if (timedOut) {
		console.warn(
			`[daily-report] ${date} agent was killed by watchdog at ${toolCalls} tool calls — proceeding with whatever was written`,
		);
	}

	// Persist cost sidecar + record historical usage
	let cost: RunCostInfo | undefined;
	if (capturedResult) {
		const r: AgentResult = capturedResult;
		cost = {
			cost_usd: r.cost,
			input_tokens: r.usage.inputTokens,
			output_tokens: r.usage.outputTokens,
			cache_read_tokens: r.usage.cacheReadTokens,
			cache_creation_tokens: r.usage.cacheCreationTokens,
			duration_ms: Date.now() - runStartedAt,
		};
		try {
			await saveCost(date, cost);
		} catch (err) {
			console.error("[daily-report] Failed to save cost sidecar:", err);
		}
		const inTokens =
			cost.input_tokens + cost.cache_read_tokens + cost.cache_creation_tokens;
		recordUsage(inTokens, cost.output_tokens, cost.cost_usd);
	}

	let report: DailyReport;
	try {
		report = await loadReport(date);
	} catch (err: any) {
		console.error("[daily-report] Post-agent failure:", err);
		await sendTextAlert(
			targetChatId,
			`⚠️ AI 日报渲染失败（${date}）\n\n${err?.message || err}\n\n检查 ${outPath} 是否生成或格式是否正确。`,
		);
		// Persist failure so PM2 restarts + catchup polls don't re-spam the same alert.
		// Re-alerts on this date are blocked until the JSON appears (manual /daily-report
		// can still write it) or until tomorrow rolls over.
		try {
			const notified = await loadNotified();
			if (!notified.has(date)) {
				notified.add(date);
				await saveNotified(notified);
			}
		} catch (persistErr) {
			console.error(
				"[daily-report] Failed to persist failure dedup:",
				persistErr,
			);
		}
		return;
	}

	// Inject wiki_url from env token so card button points correctly
	const { wikiToken } = cfg();
	if (wikiToken) {
		report.wiki_url = `https://midawang.feishu.cn/wiki/${wikiToken}`;
	}

	try {
		await sendCardToChat(targetChatId, buildDailyCard(report, cost));
		console.log(
			`[daily-report] Sent card for ${date} → ${targetChatId}${cost ? ` (cost $${cost.cost_usd.toFixed(3)})` : ""}`,
		);
	} catch (err: any) {
		console.error("[daily-report] Card send failed:", err);
		await sendTextAlert(
			targetChatId,
			`⚠️ 卡片发送失败（${date}）\n\n${err?.message || err}`,
		);
	}

	// Wiki sync — overwrite the entire wiki page with newest-first archive view.
	// Independent of card delivery; failure surfaces as actionable Feishu alert.
	if (wikiToken) {
		try {
			await syncWikiFromArchive(wikiToken, report);
			console.log(`[daily-report] Wiki synced (newest-first) for ${date}`);
		} catch (err: any) {
			console.error("[daily-report] Wiki sync failed:", err);
			const isPermissionErr = isWikiPermissionError(err);
			const appId = process.env.FEISHU_APP_ID || "(unset)";
			const hint = isPermissionErr
				? `\n\n💡 修复：打开 wiki 页面 → 右上角『···』→『协作』→ 添加 CCBuddy bot（app_id: ${appId}）→ 设为『可编辑』。\n   下次 7am cron 自动恢复。`
				: "";
			await sendTextAlert(
				targetChatId,
				`⚠️ Wiki 同步失败（${date}），卡片已发送但 wiki 文档未更新${hint}\n\n${err?.message || err}`,
			);
		}
	}
}

/** Expose guard status for UI feedback ("生成中..." state). */
export function isAgentRunning(): boolean {
	return agentGuard.isRunning();
}

/** Representative cost for the demo card. Mirrors typical Opus/medium run numbers. */
export function getDemoCost(): RunCostInfo {
	return {
		cost_usd: 0.42,
		input_tokens: 18_500,
		output_tokens: 4_200,
		cache_read_tokens: 132_000,
		cache_creation_tokens: 8_100,
		duration_ms: 3 * 60_000 + 42_000,
	};
}

/** Built-in sample for instant style preview — no agent, no disk, no network. */
export function getDemoReport(): DailyReport {
	return {
		date: todayStr(),
		generated_at: new Date().toISOString(),
		window_hours: 24,
		sources_count: 80,
		wiki_url: undefined,
		ai_news: [
			{
				title: "xAI/SpaceX 与 Cursor 达成合作",
				url: "https://x.ai/news",
				desc: "含 600 亿美元期权，共用 Colossus 百万 H100 算力",
			},
			{
				title: "OpenAI 发布 GPT Image 2",
				url: "https://openai.com/news",
				desc: "图像生成加入推理和联网搜索，API 支持 2K 输出",
			},
			{
				title: "Anthropic 发布 Claude Skills 市场",
				url: "https://www.anthropic.com/news",
				desc: "官方中心化 skill 分发，含安全扫描与版本锁",
			},
			{
				title: "Google 推出 Deep Research Max",
				url: "https://deepmind.google/discover/blog/",
				desc: "Gemini API 支持 MCP 私有数据和异步研究",
			},
			{
				title: "Meta 将记录员工鼠标和键盘输入",
				url: "https://ai.meta.com/blog/",
				desc: "用于训练电脑操作 AI，采集点击和下拉菜单等真实轨迹",
			},
			{
				title: "DeepSeek V4 发布，MoE 稀疏度再提升",
				url: "https://api-docs.deepseek.com/news",
				desc: "671B 参数激活 37B，代码与数学基准全面超越 V3",
			},
			{
				title: "腾讯云开源 Cube Sandbox",
				url: "https://cloud.tencent.com/",
				desc: "Rust microVM 沙箱冷启动低于 100ms，兼容 E2B 协议",
			},
			{
				title: "Qwen3-Coder 更新权重和技术报告",
				url: "https://qwenlm.github.io/blog/",
				desc: "480B MoE 代码模型，SWE-bench 72.3% 超过 GPT-5",
			},
			{
				title: "Moondream 发布 Lens",
				url: "https://moondream.ai/blog",
				desc: "几十张图片和约 20 美元可微调垂直视觉模型",
			},
		],
		product_hunt: [
			{
				rank: 1,
				title: "Magic Layers by Canva",
				url: "https://www.producthunt.com/posts/magic-layers",
				desc: "图片转可编辑设计",
			},
			{
				rank: 2,
				title: "Chat Skills for AI Agents",
				url: "https://www.producthunt.com/posts/chat-skills",
				desc: "给 Agent 加聊天能力",
			},
			{
				rank: 3,
				title: "Cosmic Agent Marketplace",
				url: "https://www.producthunt.com/posts/cosmic",
				desc: "CMS 里的 AI 代理",
			},
			{
				rank: 4,
				title: "delegare",
				url: "https://www.producthunt.com/posts/delegare",
				desc: "受控 Agent 支付",
			},
			{
				rank: 5,
				title: "Harker 2.0",
				url: "https://www.producthunt.com/posts/harker",
				desc: "本地语音转写",
			},
		],
		github_trending: [
			{
				rank: 1,
				repo: "Fincept-Corporation/FinceptTerminal",
				url: "https://github.com/Fincept-Corporation/FinceptTerminal",
				desc: "金融终端与市场分析",
				stars_added: 2548,
			},
			{
				rank: 2,
				repo: "thunderbird/thunderbolt",
				url: "https://github.com/thunderbird/thunderbolt",
				desc: "自控模型的 AI 客户端",
				stars_added: 596,
			},
			{
				rank: 3,
				repo: "zilliztech/claude-context",
				url: "https://github.com/zilliztech/claude-context",
				desc: "Claude Code 代码搜索 MCP",
				stars_added: 169,
			},
			{
				rank: 4,
				repo: "ruvnet/RuView",
				url: "https://github.com/ruvnet/RuView",
				desc: "WiFi 人体姿态识别",
				stars_added: 824,
			},
			{
				rank: 5,
				repo: "microsoft/ai-agents-for-beginners",
				url: "https://github.com/microsoft/ai-agents-for-beginners",
				desc: "AI Agent 入门课程",
				stars_added: 200,
			},
		],
		sources_meta: {
			breakdown: [
				"Anthropic Blog",
				"OpenAI Blog",
				"Google DeepMind",
				"xAI News",
				"Meta AI",
				"DeepSeek",
				"Qwen Blog",
				"ByteDance Seed",
				"arXiv cs.AI",
				"HuggingFace Daily Papers",
				"Hacker News",
				"TechCrunch AI",
				"The Information",
				"Product Hunt",
				"GitHub Trending",
				"HuggingFace Trending",
				"量子位",
				"机器之心",
				"新智元",
				"36kr AI",
			],
			method:
				"24h 窗口 · 80 源并检 · 全通过筛选（时效/实质/显著/一手/去重）· Tier 1-3 一手优先",
		},
	};
}

// ── Agent Prompt ────────────────────────────────────

function buildAgentPrompt(date: string, outPath: string): string {
	return `You are woken by the daily-report cron. Execute the \`daily-report\` skill.

Today is ${date}. Produce a high-density AI briefing covering the past 24 hours.

CRITICAL REQUIREMENTS:
1. Information density MUST exceed typical pulse output — each item survives a "would a well-informed engineer be surprised / care?" test.
2. At least 9 AI news items, 5 Product Hunt, 5 GitHub Trending.
3. Prefer primary sources (official blogs, arxiv, GitHub, lab posts) over aggregator reposts.
4. Any existing file at the output path has been deleted by the daemon; regenerate from scratch.
5. Write the structured output to the absolute path: ${outPath} — do NOT change it, do NOT interpret as relative. Use Write tool with this exact absolute path. JSON schema is defined in the skill.

EXIT CONDITIONS (very important — follow exactly):
- As soon as the JSON file is written and one jq sanity check confirms \`ai_news\` length ≥ 9, you are DONE.
- Do NOT re-verify URLs, do NOT re-fetch sources, do NOT re-read the skill. Exit immediately.
- Your total tool-call budget is 35. After that, stop even if you feel the work is incomplete — daemon has a hard timeout.

Do NOT send any Feishu message yourself. Do NOT call lark-cli or lark-doc — the daemon owns wiki distribution after you exit.`;
}

// ── Catchup ─────────────────────────────────────────
//
// node-cron is in-memory and "fire-and-forget": if the laptop is suspended at
// the scheduled tick or the daemon is restarting (PM2 + ws-supervisor exit(1)),
// the day's report is permanently lost. The pieces below detect that situation
// on startup and after sleep/wake transitions, and re-trigger the run.

/** Parse the simple "M H * * *" cron form daily-report uses. Returns null for anything else. */
export function parseSimpleCron(
	expr: string,
): { hour: number; minute: number } | null {
	const parts = expr.trim().split(/\s+/);
	if (parts.length !== 5) return null;
	if (parts[2] !== "*" || parts[3] !== "*" || parts[4] !== "*") return null;
	const minute = Number(parts[0]);
	const hour = Number(parts[1]);
	if (!Number.isInteger(minute) || minute < 0 || minute > 59) return null;
	if (!Number.isInteger(hour) || hour < 0 || hour > 23) return null;
	return { hour, minute };
}

function todaysScheduledTime(hour: number, minute: number, now: Date): Date {
	const t = new Date(now);
	t.setHours(hour, minute, 0, 0);
	return t;
}

export interface CatchupDecision {
	needed: boolean;
	reason: string;
	date: string;
}

/** Is today's run overdue and the JSON missing? Pure aside from the injected `exists` probe. */
export function isCatchupNeeded(
	schedule: string,
	now: Date = new Date(),
	exists: (p: string) => boolean = existsSync,
): CatchupDecision {
	const date = todayStr(now);
	const parsed = parseSimpleCron(schedule);
	if (!parsed) {
		return {
			needed: false,
			reason: "non-standard cron, catchup disabled",
			date,
		};
	}
	const scheduledAt = todaysScheduledTime(parsed.hour, parsed.minute, now);
	if (now.getTime() < scheduledAt.getTime()) {
		return { needed: false, reason: "before today's scheduled time", date };
	}
	if (exists(reportPath(date))) {
		return { needed: false, reason: `${date}.json already present`, date };
	}
	const hh = String(parsed.hour).padStart(2, "0");
	const mm = String(parsed.minute).padStart(2, "0");
	return {
		needed: true,
		reason: `${date}.json missing past scheduled ${hh}:${mm}`,
		date,
	};
}

/** Per-daemon-lifetime catchup gate: at most one catchup run per calendar date. */
class CatchupGuard {
	private lastRunDate: string | null = null;
	tryClaim(date: string): boolean {
		if (this.lastRunDate === date) return false;
		this.lastRunDate = date;
		return true;
	}
	release(date: string): void {
		if (this.lastRunDate === date) this.lastRunDate = null;
	}
}

// ── Missed-day notifier ─────────────────────────────
//
// Pure in-process defenses can't recover days the laptop was fully off. When
// the daemon comes back online, surface those gaps as a single Feishu alert
// so the user knows *why* a day is missing — without trying to backfill
// stale news. Persisted dedupe via notified.json prevents repeat alerts.

const NOTIFIED_FILE = join(REPORT_DIR, "notified.json");

async function loadNotified(): Promise<Set<string>> {
	try {
		if (!existsSync(NOTIFIED_FILE)) return new Set();
		const raw = JSON.parse(await readFile(NOTIFIED_FILE, "utf-8")) as {
			dates?: string[];
		};
		return new Set(raw.dates || []);
	} catch {
		return new Set();
	}
}

async function saveNotified(dates: Set<string>): Promise<void> {
	await writeFile(
		NOTIFIED_FILE,
		JSON.stringify({ dates: Array.from(dates).sort() }, null, 2),
		"utf-8",
	);
}

/** Past `days` calendar dates (excluding today), most recent first. */
export function pastDateRange(end: Date, days: number): string[] {
	const result: string[] = [];
	for (let i = 1; i <= days; i++) {
		const d = new Date(end);
		d.setDate(d.getDate() - i);
		result.push(todayStr(d));
	}
	return result;
}

/**
 * Detect past days whose report JSON is missing and haven't been alerted yet.
 * Returns the newly-missed dates (caller decides whether to send the alert).
 * Pure aside from the injected `exists` probe.
 */
export function findUnnotifiedMissed(
	candidates: string[],
	notified: Set<string>,
	exists: (p: string) => boolean = existsSync,
): string[] {
	return candidates.filter(
		(date) => !exists(reportPath(date)) && !notified.has(date),
	);
}

export async function notifyMissedReports(
	targetChatId: string,
	lookbackDays = 7,
	now: Date = new Date(),
): Promise<string[]> {
	const notified = await loadNotified();
	const candidates = pastDateRange(now, lookbackDays);
	const newlyMissed = findUnnotifiedMissed(candidates, notified);
	if (newlyMissed.length === 0) return [];

	const lines = [
		`⚠️ 发现 ${newlyMissed.length} 天 AI 日报未生成（电脑休眠/离线导致）：`,
		"",
		...newlyMissed.map((d) => `  • ${d}`),
		"",
		"这些天的内容已过期，不会自动补发。如需手动重生成，回 `/daily-report YYYY-MM-DD` 重渲染（需有缓存 JSON）。",
	];
	await sendTextAlert(targetChatId, lines.join("\n"));

	for (const d of newlyMissed) notified.add(d);
	try {
		await saveNotified(notified);
	} catch (err) {
		console.error("[daily-report] Failed to persist notified.json:", err);
	}
	console.log(
		`[daily-report] Notified missed dates: ${newlyMissed.join(", ")}`,
	);
	return newlyMissed;
}

// ── Init ────────────────────────────────────────────

export function initDailyReport(
	runAgent: (options: AgentOptions) => Promise<void>,
) {
	const { schedule, timezone, chatId } = cfg();

	if (!chatId) {
		console.log(
			"[daily-report] DAILY_REPORT_CHAT_ID not set — scheduler inactive",
		);
		return;
	}

	if (!cron.validate(schedule)) {
		console.error(`[daily-report] Invalid cron expression: ${schedule}`);
		return;
	}

	// node-cron 3.0.3 default autorecover=false drops missed ticks. macOS App Nap
	// throttling can delay the 1s polling enough to skip the 7:00:00 boundary.
	// recoverMissedExecutions: true makes the next tick replay any missed seconds.
	cron.schedule(
		schedule,
		() => {
			runDailyReportOnce({ targetChatId: chatId, runAgent }).catch((err) => {
				console.error("[daily-report] Cron run failed:", err);
			});
		},
		{ timezone, recoverMissedExecutions: true } as any,
	);
	console.log(`[daily-report] Scheduler active: "${schedule}" (${timezone})`);

	const catchupGuard = new CatchupGuard();
	const tryCatchup = async (trigger: string) => {
		// Don't race the primary cron path — if an agent run is in flight, leave it alone.
		if (isAgentRunning()) return;
		const decision = isCatchupNeeded(schedule);
		if (!decision.needed) {
			// Polling fires every few minutes; only log skips for non-poll triggers.
			if (trigger !== "poll") {
				console.log(
					`[daily-report] Catchup (${trigger}): skip — ${decision.reason}`,
				);
			}
			return;
		}
		// Cross-restart dedup: a prior run today already alerted the user about the
		// failure. Don't burn another agent run + duplicate alert on every PM2 restart.
		// Manual `/daily-report` still works (it bypasses this gate by going through
		// runDailyReportOnce directly).
		try {
			const notified = await loadNotified();
			if (notified.has(decision.date)) {
				if (trigger !== "poll") {
					console.log(
						`[daily-report] Catchup (${trigger}): ${decision.date} already alerted (notified.json) — skip`,
					);
				}
				return;
			}
		} catch (err) {
			console.warn("[daily-report] Could not read notified.json:", err);
		}
		if (!catchupGuard.tryClaim(decision.date)) {
			if (trigger !== "poll") {
				console.log(
					`[daily-report] Catchup (${trigger}): ${decision.date} already attempted this lifetime`,
				);
			}
			return;
		}
		console.log(
			`[daily-report] Catchup (${trigger}): ${decision.reason} — running now`,
		);
		runDailyReportOnce({ targetChatId: chatId, runAgent }).catch((err) => {
			console.error("[daily-report] Catchup run failed:", err);
			catchupGuard.release(decision.date);
		});
	};

	// Layer 2 — Startup catchup: wait for Feishu WS / proxy to settle before firing.
	// Same delay also runs the missed-day notifier (path 3 — surface days where
	// laptop was off all day so the user knows why a day is missing, without
	// trying to backfill stale news).
	const startupDelayMs = Number(
		process.env.DAILY_REPORT_STARTUP_DELAY_MS || 60_000,
	);
	const lookbackDays = Number(process.env.DAILY_REPORT_LOOKBACK_DAYS || 7);
	setTimeout(() => {
		tryCatchup("startup");
		notifyMissedReports(chatId, lookbackDays).catch((err) => {
			console.error("[daily-report] Missed-day notifier failed:", err);
		});
	}, startupDelayMs);

	// Layer 3 — Periodic polling catchup: time-based, defense against cron miss
	// (node-cron + App Nap) and any silent failure of the primary cron path.
	// CatchupGuard + isAgentRunning() ensure at most one run per calendar date.
	// Hourly is sub-cron-cost; tighten via env if you want faster post-7am recovery.
	const pollIntervalMs = Number(
		process.env.DAILY_REPORT_POLL_INTERVAL_MS || 60 * 60_000,
	);
	setInterval(() => tryCatchup("poll"), pollIntervalMs);

	// Layer 4 — Sleep/wake fast-path: drift-based heartbeat. Fires within ~1
	// minute of wake (vs up to 5 min for the polling layer).
	const heartbeatMs = 60_000;
	const driftThresholdMs = 5 * 60_000;
	let lastTickAt = Date.now();
	setInterval(() => {
		const now = Date.now();
		const drift = now - lastTickAt;
		lastTickAt = now;
		if (drift > driftThresholdMs) {
			console.log(
				`[daily-report] Clock drift ${Math.round(drift / 1000)}s detected — likely wake from sleep`,
			);
			tryCatchup("wake");
		}
	}, heartbeatMs);
}
