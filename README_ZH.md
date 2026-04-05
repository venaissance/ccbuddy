# CCBuddy

[![Bun](https://img.shields.io/badge/Bun-%3E%3D1.3-f9f1e1?logo=bun)](https://bun.sh)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-3178c6?logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

[English](README.md) | [中文](README_ZH.md)

> 基于 Claude Code CLI 的飞书个人 AI 助手守护进程。1.6K 行代码，9 个模块，零 Docker 依赖。

CCBuddy 以单个 Bun 进程运行，通过 WebSocket 连接飞书，为每个对话生成 Claude Code CLI 子进程，并以打字机效果将回复以交互式卡片的形式流式返回。定时心跳机制保持 Agent 持续活跃并具备主动行动能力。

## 特性

- **流式回复** -- 基于 CardKit 的打字机效果，防抖更新，自动降级为 message.patch
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

# 安装依赖
bun install

# 配置环境变量
cp .env.example .env
# 编辑 .env，填入你的凭证：
#   FEISHU_APP_ID=cli_xxxxxxxxxxxx
#   FEISHU_APP_SECRET=xxxxxxxxxxxxxxxxxxxxxxxx
#   PORT=3001  (可选，默认 3000)

# 开发模式（热重载）
bun run dev

# 生产模式
bun run start
```

服务启动后监听 `http://localhost:3000`，管理面板位于根路径。

#### 飞书开发者后台配置

1. 进入 **事件与回调** > **订阅方式**，选择 **使用长连接接收事件**
2. 订阅 `im.message.receive_v1` 事件
3. 在 **权限管理** 中开启所需权限

### 使用 PM2 部署生产环境

```bash
pm2 start ecosystem.config.cjs
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
  index.ts          引导启动：DB、Memory、HTTP、WebSocket、Cron
  agent.ts          生成 Claude CLI、解析 NDJSON 流、管理进程
  feishu-ws.ts      WebSocket 初始化、文本提取、StreamingCard（CardKit）
  feishu-auth.ts    OAuth Device Flow（lark-cli）
  session.ts        会话 CRUD、JSONL 消息追加
  memory.ts         三层记忆：SOUL、USER、Topic 检索
  db.ts             SQLite 建表（Drizzle ORM）、WAL 模式
  api.ts            Hono REST 路由：sessions、tasks、logs、memory
  cron.ts           心跳调度器，含并发守卫

web/                React 管理面板（Vite + React）
tests/              169 个测试，分布在 11 个文件中
  unit/             8 个文件 -- agent、API、cron、DB、feishu-auth、feishu-ws、memory、session
  integration/      2 个文件 -- API 端到端、消息管线
  e2e/              1 个文件 -- 服务器生命周期
data/               运行时数据（已 gitignore）
  openclaw.db       SQLite 数据库
  sessions/         JSONL 消息文件
  memory/           SOUL.md、USER.md、topics/
```

## 测试

```
169 tests | 0 failures | 447 assertions
11 files: 8 unit + 2 integration + 1 E2E
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
| 代码量 | ~1.6K 行 | 数万行 | 不可见 |
| 依赖 | 4 个运行时依赖 | 数十个 | N/A |

## 许可证

MIT
