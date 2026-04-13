# Changelog

## [Unreleased] — 2026-04-13

### Features

#### Slash Commands (`src/commands.ts` — 新增)
- `/new` `/clear` — 清除 Claude session + 元数据，开始全新对话
- `/stop` — 中断运行中的 agent 进程
- `/model` — 交互式卡片选择模型（Haiku/Sonnet/Opus）和 effort 级别（Low/Medium/High/Max），按钮点击原地更新卡片 + toast 反馈
- `/cost` — 当前会话 + 历史总计用量统计（token 数、API 等价费用 ¥）
- `/compact [重点]` — 压缩上下文：spawn claude 生成摘要，清除旧 session，下轮基于摘要继续
- `/context` — 上下文窗口使用情况
- `/status` — 会话详细状态（session ID、模型、轮数、费用、运行中任务数）
- `/help` — 列出所有可用命令

#### 飞书卡片交互 (`src/feishu-ws.ts`)
- 注册 `card.action.trigger` 事件处理，支持按钮回调
- 回调返回格式对齐飞书规范：`{ card: { type: "raw", data: cardJson }, toast: { type, content } }`
- `/model` 卡片按钮：`value: { action: "model_select", model: "opus" }`，无 `name` 字段（Schema 2.0）

#### 流式回复优化 (`src/agent.ts`, `src/feishu-ws.ts`)
- `--include-partial-messages` 开启 token 级 `text_delta` 流式输出
- 解析 `stream_event` → `content_block_delta` → `text_delta` / `thinking_delta`
- 智能 FlushController：300ms 间隔 + 30 字符阈值，满足任一立即推送
- 懒创建卡片：不预创建空卡片，等第一个 `thinking_delta` 或 `text_delta` 到达才创建
- Thinking 状态展示：收到 thinking 事件时显示 "💭 思考中..."
- 文本开始时标题更新为 "✍️ 生成中 (思考 2.3s)"，展示思考耗时

#### Statusline — 每条回复卡片底部 (`src/commands.ts`)
- 格式：`💰 opus·medium · 10↑ 311↓ +59.6K cache · 本条 ¥0.54 · 历史 ¥12.36 (180K tokens) · ctx 1.0M · 5h resets 33m`
- 数据源全部来自 Claude CLI stream-json 事件，无推算
- `text_size: "notation"` 渲染为飞书小字（对齐 happyclaw）

#### 模型与 Effort (`src/agent.ts`)
- 默认模型改为 Opus + Medium effort
- `SessionMeta` 新增 `effort`、`contextWindow`、`rateLimits`、token 统计字段
- `buildAgentArgs` 支持 `--model` 和 `--effort` 参数
- `runAgent` 每轮记录 cost、duration、token usage、rate limit 信息

#### 用量追踪 (`src/usage.ts` — 新增, `src/db.ts`)
- SQLite `usage_stats` 表持久化历史总量（input tokens、output tokens、cost USD、turns）
- PM2 重启不丢失
- `getHistoricalUsage()` / `recordUsage()` API
- 费用显示为人民币（USD × 7.2）

#### Rate Limit (`src/agent.ts`)
- 解析 `rate_limit_event` 捕获 `resetsAt`、`rateLimitType`、`status`
- 支持 `five_hour` 和 `seven_day` 两种窗口
- Statusline 显示精确的 reset 倒计时

#### Token 统计 (`src/agent.ts`)
- 解析 `result` 事件的 `usage` 字段：`input_tokens`、`output_tokens`、`cache_creation_input_tokens`、`cache_read_input_tokens`
- 解析 `modelUsage` 的 `contextWindow` 获取精确上下文窗口大小
- Cache creation tokens 单独展示

#### 代理管理 (`scripts/claude-wrapper.sh` — 新增)
- Wrapper 脚本：每次 spawn claude 前运行 preflight 代理检查
- 通过 `CCBUDDY_CLAUDE_BIN` 环境变量注入，agent.ts 代码零代理逻辑
- Revert 了 agent.ts 中的硬编码 preflight，改为部署层控制

### Bugfixes

- **`/model` 卡片 400 错误** — 飞书 button 不支持 `name` 字段和 `behaviors` 包装，改为直接 `value: { action: ... }`
- **Card action 路由错误** — 数据结构兼容 `data.event.action` 和 `data.action` 两种路径
- **Statusline 不显示** — 从 `{ tag: "note" }` + `{ tag: "hr" }` 改为 `{ tag: "markdown", text_size: "notation" }`（对齐 happyclaw）
- **卡片按钮点击后不更新** — `message.patch` 的 schema 版本必须匹配原卡片（v2 → v2）
- **卡片更新后又回退** — `message.patch` 和回调返回值冲突，改为仅用回调返回值
- **回调返回 200672 错误** — 回调响应体格式错误，改为 `{ card: { type: "raw", data: cardJson }, toast: { ... } }`

### Architecture Decisions

- **Slash 命令不做框架** — 参考 happyclaw（只有 `/clear`）和 agentara（只有 `/stop`），不做注册表/路由模式，直接 if-else 拦截
- **代理逻辑不入代码** — preflight 属于部署环境，通过 wrapper 脚本 + 环境变量注入
- **不获取 rate limit 百分比** — 需要 OAuth token 调 `/api/oauth/usage`，ROI 不高，终端 statusline 已有
- **上下文百分比去掉** — 无法准确计算（compaction 机制），只显示 contextWindow 大小

---

## [0.1.0] — 2026-04-11

### Initial Release
- 飞书 WebSocket 长连接接收消息
- Claude CLI spawn + stream-json 流式回复
- CardKit 流式卡片（typewriter 效果）
- Session 管理（chatId 绑定）
- OAuth Device Flow 授权（`/auth`）
- Heartbeat cron（30 分钟自唤醒）
- SQLite WAL 模式持久化
