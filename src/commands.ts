/**
 * Slash commands — intercepted before runAgent, reply directly via Feishu card.
 *
 * Supported:
 *   /new     — Start fresh session
 *   /stop    — Abort running agent
 *   /cost    — Show cumulative cost for this session
 *   /compact — Compress context (new session seeded with summary)
 *   /model   — Interactive model & effort picker (card buttons)
 *   /context — Show context usage estimate
 *   /status  — Session info at a glance
 *   /help    — List available commands
 */

import {
  abortAgent,
  getActiveCount,
  getClaudeSessionId,
  clearClaudeSession,
  clearSessionMeta,
  getSessionMeta,
  getOrCreateMeta,
  setSessionModel,
  setSessionEffort,
  runAgent,
  type EffortLevel,
  type SessionMeta,
} from "./agent";
import {
  buildDailyCard,
  getDemoCost,
  getDemoReport,
  isAgentRunning,
  runDailyReportOnce,
  todayStr,
} from "./daily-report";
import { getLarkClient, onCardAction } from "./feishu-ws";
import { formatCostCNY, getHistoricalUsage } from "./usage";

// ── Types ───────────────────────────────────────────

export interface CommandContext {
  sessionId: string;
  messageId: string;
  chatId: string;
  args: string;
}

interface CommandResult {
  /** Markdown body text */
  text: string;
  header?: string;
  template?: string;
  /** Override the entire card body elements (for interactive cards) */
  elements?: any[];
}

type CommandHandler = (ctx: CommandContext) => CommandResult | Promise<CommandResult>;

// ── Constants ──────────────────────────────────────

const VALID_MODELS = ["haiku", "sonnet", "opus"] as const;
type ModelAlias = (typeof VALID_MODELS)[number];

const VALID_EFFORTS: EffortLevel[] = ["low", "medium", "high", "max"];

const MODEL_LABELS: Record<string, string> = {
  haiku: "Haiku",
  sonnet: "Sonnet",
  opus: "Opus",
};

const EFFORT_LABELS: Record<string, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  max: "Max",
};

// ── Command Registry ───────────────────────────────

const commands: Record<string, CommandHandler> = {
  new: handleNew,
  clear: handleNew,
  stop: handleStop,
  cost: handleCost,
  compact: handleCompact,
  model: handleModel,
  context: handleContext,
  status: handleStatus,
  help: handleHelp,
  "daily-report": handleDailyReport,
};

// ── Public API ─────────────────────────────────────

/**
 * Parse and match a slash command from message text.
 * Returns null if not a command.
 */
export function parseCommand(text: string): { name: string; args: string } | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return null;

  const spaceIdx = trimmed.indexOf(" ");
  const name = (spaceIdx === -1 ? trimmed.slice(1) : trimmed.slice(1, spaceIdx)).toLowerCase();
  const args = spaceIdx === -1 ? "" : trimmed.slice(spaceIdx + 1).trim();

  if (!(name in commands)) return null;
  return { name, args };
}

/**
 * Execute a slash command and reply via Feishu card.
 */
export async function executeCommand(
  name: string,
  ctx: CommandContext,
): Promise<void> {
  const handler = commands[name];
  if (!handler) return;

  const result = await handler(ctx);
  await replyCard(ctx.messageId, result);
}

/**
 * Build a statusline string for embedding in reply card footers.
 * Format: "💰 opus · medium · $0.0312 · ctx 12% (3 turns) · resets 4h"
 */
export function buildStatusline(
  sessionId: string,
  turnCost?: number,
  turnUsage?: { inputTokens: number; outputTokens: number; cacheCreationTokens: number; cacheReadTokens: number },
): string {
  const meta = getSessionMeta(sessionId);
  if (!meta) return "";

  const parts: string[] = [];

  // Model + effort
  parts.push(`${meta.model}·${meta.effort}`);

  // Tokens — this turn
  if (turnUsage && (turnUsage.inputTokens > 0 || turnUsage.outputTokens > 0)) {
    let tokenStr = `${fmtTokens(turnUsage.inputTokens)}↑ ${fmtTokens(turnUsage.outputTokens)}↓`;
    if (turnUsage.cacheCreationTokens > 0) {
      tokenStr += ` +${fmtTokens(turnUsage.cacheCreationTokens)} cache`;
    }
    parts.push(tokenStr);
  }

  // API cost — this turn (RMB) + historical total
  const history = getHistoricalUsage();
  if (turnCost !== undefined && turnCost > 0) {
    parts.push(`本条 ${formatCostCNY(turnCost)}`);
  }
  if (history.totalCostUsd > 0) {
    parts.push(`历史 ${formatCostCNY(history.totalCostUsd)} (${fmtTokens(history.totalInputTokens + history.totalOutputTokens)} tokens)`);
  }

  // Context window size (from API modelUsage.contextWindow)
  if (meta.contextWindow > 0) {
    parts.push(`ctx ${fmtTokens(meta.contextWindow)}`);
  }

  // Rate limit reset times (from Claude API rate_limit_event)
  const now = Date.now();
  const fiveHour = meta.rateLimits["five_hour"];
  const sevenDay = meta.rateLimits["seven_day"];

  if (fiveHour) {
    const resetMs = fiveHour.resetsAt * 1000;
    if (resetMs > now) {
      parts.push(`5h resets ${formatUptime(resetMs - now)}`);
    }
  }
  if (sevenDay) {
    const resetMs = sevenDay.resetsAt * 1000;
    if (resetMs > now) {
      parts.push(`7d resets ${formatUptime(resetMs - now)}`);
    }
  }

  return `💰 ${parts.join(" · ")}`;
}

/**
 * Register card action handlers for interactive commands.
 * Call once during init.
 */
export function initCardActions(resolveSession: (chatId: string) => Promise<string | null>): void {
  // Model button click
  onCardAction("model_select", async (action) => {
    const model = action.actionValue.model;
    if (!model || !VALID_MODELS.includes(model as ModelAlias)) return;

    const sessionId = await resolveSession(action.chatId);
    if (!sessionId) return;

    setSessionModel(sessionId, model);
    const meta = getOrCreateMeta(sessionId);
    console.log(`[cmd] Model changed to ${model} for ${sessionId}`);

    return { card: buildModelCard(meta), toastText: `已切换到 ${MODEL_LABELS[model]}` };
  });

  // Effort button click
  onCardAction("effort_select", async (action) => {
    const effort = action.actionValue.effort as EffortLevel;
    if (!effort || !VALID_EFFORTS.includes(effort)) return;

    const sessionId = await resolveSession(action.chatId);
    if (!sessionId) return;

    setSessionEffort(sessionId, effort);
    const meta = getOrCreateMeta(sessionId);
    console.log(`[cmd] Effort changed to ${effort} for ${sessionId}`);

    return { card: buildModelCard(meta), toastText: `Effort 已设为 ${EFFORT_LABELS[effort]}` };
  });
}

// ── Command Handlers ───────────────────────────────

function handleNew(ctx: CommandContext): CommandResult {
  clearClaudeSession(ctx.sessionId);
  clearSessionMeta(ctx.sessionId);
  return {
    header: "🔄 新会话",
    template: "green",
    text: "已清除上下文，下一条消息将开始全新对话。",
  };
}

function handleStop(ctx: CommandContext): CommandResult {
  const killed = abortAgent(ctx.sessionId);
  if (killed) {
    return {
      header: "⏹ 已停止",
      template: "orange",
      text: "当前任务已中断。",
    };
  }
  return {
    header: "⏹ 停止",
    template: "grey",
    text: "当前没有运行中的任务。",
  };
}

function handleCost(ctx: CommandContext): CommandResult {
  const meta = getSessionMeta(ctx.sessionId);
  const history = getHistoricalUsage();

  if ((!meta || meta.turnCount === 0) && history.totalTurns === 0) {
    return { header: "💰 用量", template: "grey", text: "尚无调用记录。" };
  }

  // Current session column
  let currentCol = "**📋 当前会话**\n\n";
  if (meta && meta.turnCount > 0) {
    currentCol += `**模型**: ${meta.model} · ${meta.effort}\n`;
    currentCol += `**轮数**: ${meta.turnCount}\n`;
    currentCol += `**Tokens**: ${fmtTokens(meta.totalInputTokens)}↑ ${fmtTokens(meta.totalOutputTokens)}↓\n`;
    currentCol += `**费用**: ${formatCostCNY(meta.totalCost)}（$${meta.totalCost.toFixed(4)}）\n`;
    currentCol += `**时长**: ${formatUptime(Date.now() - meta.createdAt)}`;
  } else {
    currentCol += "无活跃会话";
  }

  // Historical column
  let historyCol = "**📈 历史总计**\n\n";
  if (history.totalTurns > 0) {
    historyCol += `**总轮数**: ${history.totalTurns}\n`;
    historyCol += `**总 Tokens**: ${fmtTokens(history.totalInputTokens + history.totalOutputTokens)}\n`;
    historyCol += `（${fmtTokens(history.totalInputTokens)}↑ ${fmtTokens(history.totalOutputTokens)}↓）\n`;
    historyCol += `**总费用**: ${formatCostCNY(history.totalCostUsd)}（$${history.totalCostUsd.toFixed(2)}）`;
  } else {
    historyCol += "暂无历史数据";
  }

  return {
    header: "💰 用量统计",
    template: "blue",
    text: "",
    elements: [
      {
        tag: "column_set",
        flex_mode: "none",
        background_style: "grey",
        columns: [
          {
            tag: "column",
            width: "weighted",
            weight: 1,
            elements: [{ tag: "markdown", content: currentCol }],
          },
          {
            tag: "column",
            width: "weighted",
            weight: 1,
            elements: [{ tag: "markdown", content: historyCol }],
          },
        ],
      },
    ],
  };
}

async function handleCompact(ctx: CommandContext): Promise<CommandResult> {
  const claudeUuid = getClaudeSessionId(ctx.sessionId);
  if (!claudeUuid) {
    return {
      header: "📦 压缩",
      template: "grey",
      text: "当前会话无上下文可压缩。发几条消息后再试。",
    };
  }

  const compactPrompt = ctx.args
    ? `请压缩当前对话上下文，重点保留以下内容：${ctx.args}`
    : "请压缩当前对话上下文，保留关键决策、代码变更和待办事项，丢弃中间过程。";

  return new Promise((resolve) => {
    let summary = "";
    runAgent({
      sessionId: ctx.sessionId,
      prompt: compactPrompt,
      onStream: (chunk) => {
        if (chunk.type === "assistant" && chunk.content) {
          summary += chunk.content;
        }
      },
      onEnd: () => {
        clearClaudeSession(ctx.sessionId);
        resolve({
          header: "📦 上下文已压缩",
          template: "green",
          text: "",
          elements: summary
            ? [
                { tag: "markdown", content: "已压缩为摘要，下一条消息将基于此摘要开始新会话。" },
                {
                  tag: "collapsible_panel",
                  expanded: false,
                  header: {
                    title: { tag: "lark_md", content: "📄 摘要（点击展开）" },
                    background_color: "grey",
                  },
                  elements: [{ tag: "markdown", content: summary }],
                },
              ]
            : [{ tag: "markdown", content: "已压缩。下一条消息将开始新会话。" }],
        });
      },
      onError: (err) => {
        resolve({
          header: "📦 压缩失败",
          template: "red",
          text: `压缩过程出错: ${err.message}`,
        });
      },
    });
  });
}

function handleModel(ctx: CommandContext): CommandResult {
  const meta = getOrCreateMeta(ctx.sessionId);
  const card = buildModelCard(meta);
  return {
    header: card.header.title.content,
    template: card.header.template,
    text: "",
    elements: card.body.elements,
  };
}

function handleContext(ctx: CommandContext): CommandResult {
  const meta = getSessionMeta(ctx.sessionId);
  const claudeUuid = getClaudeSessionId(ctx.sessionId);

  if (!meta || !claudeUuid) {
    return {
      header: "📊 上下文",
      template: "grey",
      text: "当前会话无上下文。",
    };
  }

  const estimatedTokens = meta.turnCount * 4000;
  const contextLimit = 200_000;
  const usagePct = Math.min((estimatedTokens / contextLimit) * 100, 100);
  const bar = renderBar(usagePct);

  let hint = "";
  if (usagePct > 80) {
    hint = "\n\n⚠️ 上下文即将用尽，建议 `/compact` 压缩或 `/new` 重新开始。";
  } else if (usagePct > 50) {
    hint = "\n\n💡 上下文过半，可考虑 `/compact` 压缩。";
  }

  return {
    header: "📊 上下文使用",
    template: usagePct > 80 ? "red" : usagePct > 50 ? "orange" : "blue",
    text: "",
    elements: [
      {
        tag: "markdown",
        content:
          `${bar} **${usagePct.toFixed(0)}%**\n\n` +
          `**估算 tokens**: ~${formatNumber(estimatedTokens)} / ${formatNumber(contextLimit)}\n` +
          `**对话轮数**: ${meta.turnCount}` +
          hint,
      },
      {
        tag: "collapsible_panel",
        expanded: false,
        header: {
          title: { tag: "lark_md", content: "🔧 技术细节" },
          background_color: "grey",
        },
        elements: [
          {
            tag: "markdown",
            content:
              `**Claude Session**: \`${claudeUuid.slice(0, 8)}...\`\n` +
              `**估算公式**: turnCount × 4,000 tokens/turn\n` +
              `**上下文上限**: 200K tokens`,
          },
        ],
      },
    ],
  };
}

function handleStatus(ctx: CommandContext): CommandResult {
  const meta = getSessionMeta(ctx.sessionId);
  const claudeUuid = getClaudeSessionId(ctx.sessionId);
  const activeCount = getActiveCount();

  let leftCol = "**🔗 会话信息**\n\n";
  leftCol += `**Session**: \`${ctx.sessionId.slice(0, 16)}...\`\n`;
  leftCol += `**Claude**: ${claudeUuid ? `\`${claudeUuid.slice(0, 8)}...\`` : "无（新会话）"}\n`;
  leftCol += `**运行中**: ${activeCount}`;

  let rightCol = "**⚙️ 配置 & 用量**\n\n";
  rightCol += `**模型**: ${meta?.model || "opus"} · ${meta?.effort || "medium"}\n`;
  rightCol += `**轮数**: ${meta?.turnCount || 0}\n`;
  rightCol += `**费用**: $${(meta?.totalCost || 0).toFixed(4)}`;
  if (meta?.createdAt) {
    rightCol += `\n**时长**: ${formatUptime(Date.now() - meta.createdAt)}`;
  }

  return {
    header: "📋 会话状态",
    template: "blue",
    text: "",
    elements: [
      {
        tag: "column_set",
        flex_mode: "none",
        background_style: "grey",
        columns: [
          {
            tag: "column",
            width: "weighted",
            weight: 1,
            elements: [{ tag: "markdown", content: leftCol }],
          },
          {
            tag: "column",
            width: "weighted",
            weight: 1,
            elements: [{ tag: "markdown", content: rightCol }],
          },
        ],
      },
    ],
  };
}

function handleHelp(): CommandResult {
  return {
    header: "📖 可用命令",
    template: "indigo",
    text: "",
    elements: [
      {
        tag: "collapsible_panel",
        expanded: true,
        header: {
          title: { tag: "lark_md", content: "🔄 会话管理" },
          background_color: "grey",
        },
        elements: [
          {
            tag: "markdown",
            content:
              "| 命令 | 说明 |\n| --- | --- |\n" +
              "| `/new` | 开始全新对话（清除上下文） |\n" +
              "| `/stop` | 中断当前运行中的任务 |\n" +
              "| `/compact [重点]` | 压缩上下文（可指定保留重点） |",
          },
        ],
      },
      {
        tag: "collapsible_panel",
        expanded: false,
        header: {
          title: { tag: "lark_md", content: "🤖 模型设置" },
          background_color: "grey",
        },
        elements: [
          {
            tag: "markdown",
            content: "| 命令 | 说明 |\n| --- | --- |\n| `/model` | 切换模型和 effort 级别 |",
          },
        ],
      },
      {
        tag: "collapsible_panel",
        expanded: false,
        header: {
          title: { tag: "lark_md", content: "📊 查询状态" },
          background_color: "grey",
        },
        elements: [
          {
            tag: "markdown",
            content:
              "| 命令 | 说明 |\n| --- | --- |\n" +
              "| `/cost` | 查看当前会话用量和费用 |\n" +
              "| `/context` | 查看上下文使用情况 |\n" +
              "| `/status` | 查看会话详细状态 |",
          },
        ],
      },
      {
        tag: "collapsible_panel",
        expanded: false,
        header: {
          title: { tag: "lark_md", content: "🗞️ 日报" },
          background_color: "grey",
        },
        elements: [
          {
            tag: "markdown",
            content:
              "| 命令 | 说明 |\n| --- | --- |\n" +
              "| `/daily-report` | 立即生成今日 AI 日报（Agent 采集，2-5 分钟，发到本聊天） |\n" +
              "| `/daily-report demo` | 样式预览：秒级发送内置样本卡片（无需 Agent） |\n" +
              "| `/daily-report render` | 从缓存 JSON 重新渲染今日卡片（秒级，用于调试样式） |\n" +
              "| `/daily-report YYYY-MM-DD` | 重新渲染指定日期的历史日报 |",
          },
        ],
      },
      {
        tag: "collapsible_panel",
        expanded: false,
        header: {
          title: { tag: "lark_md", content: "🔐 系统" },
          background_color: "grey",
        },
        elements: [
          {
            tag: "markdown",
            content:
              "| 命令 | 说明 |\n| --- | --- |\n" +
              "| `/auth` | 飞书数据授权 |\n" +
              "| `/help` | 显示本帮助 |",
          },
        ],
      },
    ],
  };
}

// ── Interactive Model Card Builder ─────────────────

function buildModelCardElements(meta: SessionMeta): any[] {
  const modelButtons = VALID_MODELS.map((m) => ({
    tag: "button",
    text: { tag: "plain_text", content: MODEL_LABELS[m] },
    type: m === meta.model ? "primary" : "default",
    value: { action: "model_select", model: m },
  }));

  const effortButtons = VALID_EFFORTS.map((e) => ({
    tag: "button",
    text: { tag: "plain_text", content: EFFORT_LABELS[e] },
    type: e === meta.effort ? "primary" : "default",
    value: { action: "effort_select", effort: e },
  }));

  return [
    {
      tag: "markdown",
      content: `当前: **${MODEL_LABELS[meta.model] || meta.model}** · **${EFFORT_LABELS[meta.effort] || meta.effort}**`,
    },
    { tag: "hr" },
    {
      tag: "column_set",
      flex_mode: "none",
      columns: [
        {
          tag: "column",
          width: "weighted",
          weight: 1,
          elements: [
            { tag: "markdown", content: "**模型**　选择 Claude 模型" },
            ...modelButtons,
          ],
        },
        {
          tag: "column",
          width: "weighted",
          weight: 1,
          elements: [
            { tag: "markdown", content: "**Effort**　控制推理深度" },
            ...effortButtons,
          ],
        },
      ],
    },
    {
      tag: "markdown",
      content: "点击按钮即时切换，下一条消息生效。Opus 最强但最贵，Haiku 最快最便宜。",
      text_size: "notation",
    },
  ];
}

/** Schema 2.0 format — for im.message.reply */
function buildModelCard(meta: SessionMeta): any {
  return {
    schema: "2.0",
    config: { wide_screen_mode: true },
    header: {
      title: { tag: "plain_text", content: "🤖 模型设置" },
      template: "blue",
    },
    body: { elements: buildModelCardElements(meta) },
  };
}

/** Legacy format — for im.message.patch */
function buildModelCardLegacy(meta: SessionMeta): any {
  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: "plain_text", content: "🤖 模型设置" },
      template: "blue",
    },
    elements: buildModelCardElements(meta),
  };
}

// ── Reply Helper ───────────────────────────────────

async function replyCard(messageId: string, result: CommandResult): Promise<void> {
  const client = getLarkClient();
  if (!client) return;

  const elements = result.elements || [{ tag: "markdown", content: result.text }];

  const card = {
    schema: "2.0",
    config: { wide_screen_mode: true },
    header: {
      title: { tag: "plain_text", content: result.header || "CCBuddy" },
      template: result.template || "blue",
    },
    body: { elements },
  };

  try {
    await client.im.message.reply({
      path: { message_id: messageId },
      data: {
        msg_type: "interactive",
        content: JSON.stringify(card),
      },
    });
  } catch (err: any) {
    console.error("[cmd] Reply failed:", err?.message);
  }
}

// ── Formatting Helpers ─────────────────────────────

export function formatUptime(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h`;
}

function formatNumber(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(0)}K`;
  return n.toString();
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return n.toString();
}

function renderBar(pct: number): string {
  const filled = Math.round(pct / 5);
  const empty = 20 - filled;
  return "█".repeat(filled) + "░".repeat(empty);
}

// ── /daily-report ──────────────────────────────────

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Debug entry — runs the daily-report flow and sends the card to the chat
 * where the command was invoked (NOT DAILY_REPORT_CHAT_ID).
 *
 * Modes:
 *   /daily-report              — full flow: agent curates + writes JSON + sends card
 *   /daily-report render       — skip agent, re-render today's cached JSON (fast style iteration)
 *   /daily-report 2026-04-22   — re-render a specific date from cached JSON
 */
function handleDailyReport(ctx: CommandContext): CommandResult {
  const arg = ctx.args.trim();
  // Only the full real run (no args) targets DAILY_REPORT_CHAT_ID.
  // demo / render / specific-date all stay in the invoking chat for debugging.
  const configuredChatId = process.env.DAILY_REPORT_CHAT_ID?.trim();
  const debugChatId = ctx.chatId;

  if (!debugChatId) {
    return {
      header: "⚠️ 无法调试",
      template: "red",
      text: "/daily-report 仅在群聊 / 单聊中可用，需要能定位到 chat_id。",
    };
  }

  // demo — instant style preview using built-in sample (no agent, no disk, no network).
  // Sends the real daily card as a second message so what you see == what the group gets.
  if (arg === "demo" || arg === "sample") {
    const client = getLarkClient();
    void (async () => {
      if (!client) return;
      try {
        await client.im.v1.message.create({
          params: { receive_id_type: "chat_id" },
          data: {
            receive_id: debugChatId,
            msg_type: "interactive",
            content: JSON.stringify(
              buildDailyCard(getDemoReport(), getDemoCost()),
            ),
          },
        });
      } catch (err) {
        console.error("[/daily-report demo] send failed:", err);
      }
    })();
    return {
      header: "🎨 样式预览",
      template: "blue",
      text: "下面在本聊天发一张样本卡片（秒级）。真跑 `/daily-report` 才会发到生产群。",
    };
  }

  // render — specific date or today from cached JSON (debug, stays in this chat)
  if (arg === "render" || arg === "preview" || DATE_RE.test(arg)) {
    const date = DATE_RE.test(arg) ? arg : todayStr();
    runDailyReportOnce({
      targetChatId: debugChatId,
      date,
      skipAgent: true,
    }).catch((err) => {
      console.error("[/daily-report] Render failed:", err);
    });
    return {
      header: "🔁 重新渲染中",
      template: "blue",
      text: `正在从缓存 JSON 渲染 **${date}** 的日报卡片到本聊天...`,
    };
  }

  // Full flow — spawn agent, wait, send card
  if (isAgentRunning()) {
    return {
      header: "⏳ 生成中",
      template: "orange",
      text: "另一份日报已在生成，请稍等（通常 2-5 分钟）。",
    };
  }

  const date = todayStr();
  // Full real run: target production group if configured, else fall back to the
  // invoking chat (useful when env is not yet set).
  const prodTargetChatId = configuredChatId || debugChatId;
  const willSendToGroup =
    Boolean(configuredChatId) && configuredChatId !== debugChatId;

  void runDailyReportOnce({
    targetChatId: prodTargetChatId,
    date,
    runAgent,
  }).catch((err) => {
    console.error("[/daily-report] Run failed:", err);
  });

  return {
    header: "🚀 日报生成中",
    template: "blue",
    text: "",
    elements: [
      {
        tag: "markdown",
        content: `**${date}** AI Daily 正在生成...\n\n` +
          "Agent 正在采集 80+ 数据源、筛选、压缩描述，预计 **2-5 分钟**。\n\n" +
          (willSendToGroup
            ? "完成后发到 **生产群**（`DAILY_REPORT_CHAT_ID`）。"
            : "完成后发到本聊天（未配置 `DAILY_REPORT_CHAT_ID`）。"),
      },
      {
        tag: "markdown",
        text_size: "notation",
        content: "💡 快速迭代样式：`/daily-report render`（跳过采集，复用今日 JSON）",
      },
    ],
  };
}
