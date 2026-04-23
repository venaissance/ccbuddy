# CCBuddy

[![Bun](https://img.shields.io/badge/Bun-%3E%3D1.3-f9f1e1?logo=bun)](https://bun.sh)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-3178c6?logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

[English](README.md) | [中文](README_ZH.md)

> 基于 Claude Code CLI 的飞书个人 AI 助手守护进程。约 2.1K 行代码，10 个模块，零 Docker 依赖。

CCBuddy 以单个 Bun 进程运行，通过 WebSocket 连接飞书，为每个对话生成 Claude Code CLI 子进程，并以打字机效果将回复以交互式卡片的形式流式返回。定时心跳机制保持 Agent 持续活跃并具备主动行动能力。

## 特性

- **流式回复** -- 基于 CardKit 的打字机效果，防抖更新，自动降级为 message.patch
- **斜杠命令** -- `/model`（模型+思考强度切换）、`/cost`（用量与费用）、`/new`、`/stop`、`/compact`、`/context`、`/status`、`/help`、`/daily-report`（按需触发 AI 日报）
- **AI 日报** -- 每天 07:00 唤醒 Agent 生成高密度飞书卡片（≥9 条 AI 新闻 + 5 条 Product Hunt + 5 条 GitHub Trending），追加到飞书 wiki 文档，卡片底部显示本次成本。覆盖 80+ 数据源，守护进程独占分发，5 分钟 agent watchdog 保底。
- **生产级稳定性** -- `ensureDataDirs()` 首次启动防 ENOENT，全局未捕获错误处理器抵御飞书 5xx 抖动，WS 网络监督器每 30 秒探活并在断网恢复时重建 WebSocket；连续 15 分钟不可达时 exit(1) 让 PM2 彻底重启
- **飞书 WebSocket** -- 持久长连接，无需 Webhook 服务器，支持纯文本和富文本消息
- **三层记忆** -- SOUL（人格定义）+ USER（用户画像）+ Topics（按关键词检索的会话级知识）
- **心跳定时任务** -- 每 30 分钟触发 Agent；Agent 自主决定执行何种操作
- **会话管理** -- 按聊天维度管理会话，JSONL 消息历史 + SQLite 元数据
- **OAuth Device Flow** -- `/auth` 命令获取用户级飞书 API 访问权限（日历、任务、文档）
- **两层 Skill 架构** -- 项目级和全局 Skill 由 Claude Code 从 `CLAUDE.md` 加载
- **React 管理面板** -- Web UI，可查看会话、任务、日志和记忆
- **REST API** -- 会话、任务、日志和记忆的 CRUD 端点

## 架构

```
                         +-----------+
                         |   飞书    |
                         |   平台    |
                         +-----+-----+
                               |
                          WebSocket（持久连接）
                               |
+------------------------------+------------------------------+
|                        Bun 进程                              |
|                                                             |
|  +---------+     +-----------+     +--------+               |
|  |  Hono   |     | 飞书 WS   |     |  定时   |               |
|  |  HTTP   |     | 消息接收   |     | (30分)  |               |
|  +----+----+     +-----+-----+     +---+----+               |
|       |                |               |                    |
|       |     +----------+----------+    |                    |
|       |     |                     |    |                    |
|  +----+-----+----+          +-----+----+----+               |
|  |   REST API    |          |    Agent      |               |
|  | sessions      |          | 生成 claude   |               |
|  | tasks/logs    |          | NDJSON 流     |               |
|  | memory        |          | 解析数据块    |               |
|  +---------------+          +-------+-------+               |
|                                     |                       |
|       +-----------------------------+---+                   |
|       |              |                  |                    |
|  +----+----+   +-----+------+   +------+-------+           |
|  | 会话    |   |   记忆     |   | 流式卡片      |           |
|  |  JSONL  |   | SOUL/USER/ |   |  CardKit API  |           |
|  | +SQLite |   |  topics/   |   |  + 降级方案   |           |
|  +---------+   +------------+   +--------------+            |
+-------------------------------------------------------------+
```

三个 IO 通道，一个进程：**HTTP**（管理面板 + API）、**WebSocket**（飞书事件）、**Cron**（心跳）。

## 快速开始

### 前置条件

- [Bun](https://bun.sh) >= 1.3
- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) 已安装并完成认证
- 飞书应用，需开启 **WebSocket 长连接**（开发者后台 > 事件与回调 > 使用长连接接收事件）

### 安装与启动

```bash
# 克隆项目
git clone <repo-url> ccbuddy && cd ccbuddy

# 一键安装（安装依赖、配置环境、启动 PM2）
bash scripts/setup.sh
```

或手动执行：

```bash
bun install
cp .env.example .env                       # 然后编辑填入飞书凭证
cp ecosystem.config.example.cjs ecosystem.config.cjs

# 开发模式（热重载）
bun run dev

# 生产模式（PM2 守护进程）
pm2 start ecosystem.config.cjs
```

服务启动后监听 `http://localhost:3000`，管理面板位于根路径。

#### 飞书开发者后台配置

1. 进入 **事件与回调** > **订阅方式**，选择 **使用长连接接收事件**
2. 订阅 `im.message.receive_v1` 事件
3. 在 **权限管理** 中开启所需权限

### 启动前检查（可选）

PM2 启动入口 `scripts/start.sh` 会检测 `~/.claude/hooks/preflight.sh` 是否存在。如果存在，会在启动 CCBuddy 前执行该脚本，失败则中止启动。可用于网络连通性、依赖服务等前置检查。如无此脚本则自动跳过。

### 开机自启

```bash
pm2 startup       # 会输出一条 sudo 命令，执行它
pm2 save           # 保存进程列表
```

## 工作原理

### 消息流

```
用户在飞书发送消息
  -> 飞书 WebSocket 投递事件
    -> extractText() 解析 text/post 内容
      -> addReaction("OnIt") 即时反馈
        -> getOrCreateSession() 按聊天 ID 获取会话
          -> 生成 `claude` CLI，参数 --output-format stream-json
            -> 逐行解析 NDJSON 流
              -> StreamingCard.pushContent()（防抖，打字机效果）
                -> StreamingCard.complete() 完成时切换终态
```

### 记忆系统

| 层级 | 文件 | 加载时机 | 用途 |
|------|------|----------|------|
| SOUL | `data/memory/SOUL.md` | 始终加载 | Agent 人格定义、核心特质、成长记录 |
| USER | `data/memory/USER.md` | 始终加载 | 用户画像、偏好、累积上下文 |
| Topics | `data/memory/topics/*.md` | 关键词匹配时 | 会话级知识，按相关性评分检索 |

Agent 通过 Claude Code 的文件系统工具读写这些文件。Topic 检索使用关键词提取（过滤停用词）和文件名 + 内容评分启发式算法。

### 心跳

每 30 分钟，定时调度器触发一次心跳。Agent 收到唤醒提示后执行 `/heartbeat` Skill -- 检查待办任务、查看日历，或在空闲时不做任何操作。并发守卫机制防止心跳重复执行。

### AI 日报

每天 07:00（`DAILY_REPORT_CRON`，时区 `DAILY_REPORT_TZ`）守护进程唤醒一个执行 `daily-report` Skill 的 Agent。Agent 从 80+ 数据源（实验室、arXiv、HuggingFace、Hacker News、中文 AI 媒体）汇总过去 24h 动态，写结构化 JSON 到 `data/daily-report/YYYY-MM-DD.json`。之后守护进程：

1. 读取 JSON 构建专属飞书卡片（蓝色 header、顶部 metadata 三列、扁平列表、折叠来源面板、wiki 按钮）
2. 落盘 `.cost.json` 侧车文件记录 token / 成本 / 耗时
3. 通过 `im.v1.message.create` 推送到 `DAILY_REPORT_CHAT_ID`
4. 通过 `lark-cli` 追加 markdown 到 `DAILY_REPORT_WIKI_TOKEN` 指向的 wiki 文档

5 分钟 watchdog 保障：超时 kill agent 但仍按已写内容发卡。调试入口：`/daily-report demo`（样本数据）、`/daily-report render`（复用今日 JSON）、`/daily-report YYYY-MM-DD`（重渲染历史）。

### OAuth

用户发送 `/auth` 时，CCBuddy 通过 `lark-cli` 发起 Device Flow：

1. 运行 `lark-cli auth login --no-wait` 获取验证 URL
2. 发送带有「授权」按钮的交互式卡片
3. 后台轮询直到用户完成授权
4. 发送授权成功通知卡片

授权后可获得用户级日历、任务、文档、通讯录和消息的访问权限。

## 项目结构

```
src/
  index.ts          引导启动：ensureDataDirs、DB、Memory、HTTP、WebSocket、Cron；全局错误处理
  agent.ts          生成 Claude CLI、解析 NDJSON 流、管理进程
  commands.ts       斜杠命令（/model、/cost、/new、/stop、/daily-report...）、状态行构建
  feishu-ws.ts      WebSocket 初始化、StreamingCard、卡片交互、网络监督器（断网恢复）
  feishu-auth.ts    OAuth Device Flow（lark-cli）
  usage.ts          持久化用量跟踪（SQLite）、成本格式化（CNY）
  session.ts        会话 CRUD、JSONL 消息追加
  memory.ts         三层记忆：SOUL、USER、Topic 检索
  db.ts             SQLite 建表（Drizzle ORM）、WAL 模式
  api.ts            Hono REST 路由：sessions、tasks、logs、memory
  cron.ts           心跳调度器，含并发守卫
  daily-report.ts   07:00 AI 日报：agent runner + JSON 合约 + 卡片构建 + wiki 追加

scripts/
  setup.sh          一键安装与 PM2 配置
  start.sh          PM2 启动入口（preflight + bun）
web/                React 管理面板（Vite + React）
tests/              193 个测试，分布在 12 个文件中
  unit/             9 个文件 -- agent、API、cron、daily-report、DB、feishu-auth、feishu-ws、memory、session
  integration/      2 个文件 -- API 端到端、消息管线
  e2e/              1 个文件 -- 服务器生命周期
data/               运行时数据（已 gitignore）
  ccbuddy.db        SQLite 数据库
  sessions/         JSONL 消息文件
  memory/           SOUL.md、USER.md、topics/
  daily-report/     YYYY-MM-DD.json + YYYY-MM-DD.cost.json
```

## 测试

```
193 tests | 0 failures | 488 assertions
12 files: 9 unit + 2 integration + 1 E2E
```

```bash
# 运行全部测试
bun test

# 监听模式
bun run test:watch

# CI 模式（无监听，严格校验）
bun run test:ci
```

## 技术栈

| 组件 | 技术 |
|------|------|
| 运行时 | Bun 1.3 |
| 框架 | Hono 4.7 |
| 数据库 | SQLite (bun:sqlite) + Drizzle ORM 0.45 |
| 飞书 SDK | @larksuiteoapi/node-sdk 1.60 |
| AI 引擎 | Claude Code CLI（spawn，NDJSON 流） |
| 定时调度 | node-cron |
| 管理面板 | React + Vite |
| 代码规范 | Biome |
| 进程管理 | PM2（可选） |

## 竞品对比

| 维度 | CCBuddy | 传统 Bot 框架 | SaaS AI 助手 |
|------|---------|--------------|-------------|
| AI 引擎 | Claude Code CLI（完整工具调用能力） | 自行对接 API | 平台锁定 |
| 部署方式 | 单进程守护，`bun run start` 即启 | 容器编排 / Serverless | 云托管 |
| 飞书接入 | WebSocket 长连接，无需公网 IP | Webhook 回调 | OAuth + API |
| 记忆 | 三层持久化，跨会话 | 无 / 简单 KV | 平台内置 |
| 自主性 | Heartbeat 定时唤醒，主动行动 | 被动响应 | 被动响应 |
| 可扩展性 | Skill 文件 + CLAUDE.md | 插件系统 | 有限配置 |
| 代码量 | ~2.1K 行 | 数万行 | 不可见 |
| 依赖 | 4 个运行时依赖 | 数十个 | N/A |

## 许可证

MIT
