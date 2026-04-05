# OpenClaw MVP 技术设计文档

> 极简守护方案 — ~1500 行核心代码（9 个模块）
> 
> 面向面试深挖：每个模块覆盖 5+ 轮技术问答

## 目录

1. [整体架构与入口 (index.ts)](#1-整体架构与入口-indexts)
2. [飞书 WebSocket 通信 (feishu-ws.ts)](#2-飞书-websocket-通信-feishu-wsts)
3. [Claude Code CLI 封装 (agent.ts)](#3-claude-code-cli-封装-agentts)
4. [会话管理 (session.ts)](#4-会话管理-sessionts)
5. [定时调度与 Heartbeat (cron.ts)](#5-定时调度与-heartbeat-cronts)
6. [记忆系统 (memory.ts)](#6-记忆系统-memoryts)
7. [飞书 OAuth 授权 (feishu-auth.ts)](#7-飞书-oauth-授权-feishu-authts)
8. [Skill 系统](#8-skill-系统)
9. [API 与 Web Dashboard](#9-api-与-web-dashboard)

## 技术栈

| 层级 | 选型 | 替代方案 | 选择理由 |
|------|------|---------|---------|
| Runtime | Bun | Node.js | 原生 TS、内置 SQLite、启动快 50ms vs 300ms |
| HTTP | Hono | Express/Fastify | Bun-native、类型安全、5-10x RPS |
| Database | SQLite + Drizzle | PostgreSQL/Prisma | 零部署、Bun 内置驱动、足够 MVP |
| Daemon | PM2 | Docker/systemd | 低内存开销、原生 Bun 支持 |
| Cron | node-cron | system crontab | 进程内管理、动态任务 |
| LLM Engine | Claude Code CLI | Claude API | 内置上下文管理、tool use、file access |
| 飞书通信 | @larksuiteoapi/node-sdk (WS) | Webhook | 无需公网 IP、实时性 <100ms |
| Frontend | React 19 + Vite + Tailwind v4 | Next.js | 纯 SPA、Hono 静态服务即可 |

## 项目结构

```
openclaw/
├── src/
│   ├── index.ts          # 入口：启动 Hono + WS + Cron    (139行)
│   ├── feishu-ws.ts      # 飞书 WebSocket + CardKit 流式  (427行)
│   ├── feishu-auth.ts    # 飞书 OAuth Device Flow         (252行)
│   ├── agent.ts          # Claude Code CLI 封装            (198行)
│   ├── session.ts        # 会话管理 JSONL + SQLite         (121行)
│   ├── cron.ts           # 定时任务 + Heartbeat            (69行)
│   ├── memory.ts         # 记忆读写 + 压缩召回             (143行)
│   ├── api.ts            # Hono REST API                   (138行)
│   └── db.ts             # SQLite schema + 操作            (81行)
├── web/                   # React Dashboard
│   └── src/
│       ├── pages/         # Sessions / Detail / Scheduler / Logs
│       └── components/    # 共享组件
├── data/                  # 运行时数据（.gitignore）
│   ├── memory/            # SOUL.md + USER.md + topics/
│   ├── sessions/          # 会话 JSONL 文件
│   ├── skills/            # Skill 定义 (SKILL.md)
│   └── openclaw.db        # SQLite 数据库
├── ecosystem.config.cjs   # PM2 配置
├── .env                   # 飞书凭证（不进 git）
├── package.json
└── tsconfig.json
```

---

## 1. 整体架构与入口 (index.ts)

### 1.1 架构概述

OpenClaw 采用**事件驱动的单进程守护架构**，所有子系统运行在同一个 Bun 进程内，由 PM2 进行进程守护。

```
┌─────────────────────────────────────────────────────┐
│                    PM2 Process Guard                 │
│  ┌───────────────────────────────────────────────┐  │
│  │              Bun Runtime (单进程)               │  │
│  │                                               │  │
│  │   ┌─────────┐  ┌──────────┐  ┌────────────┐  │  │
│  │   │  Hono   │  │ Feishu   │  │   Cron     │  │  │
│  │   │  HTTP   │  │ WebSocket│  │  Scheduler │  │  │
│  │   │  Server │  │ Client   │  │            │  │  │
│  │   └────┬────┘  └────┬─────┘  └─────┬──────┘  │  │
│  │        │            │               │         │  │
│  │        v            v               v         │  │
│  │   ┌─────────────────────────────────────────┐ │  │
│  │   │         Shared In-Process State         │ │  │
│  │   │   (SQLite · Session Map · Memory Store) │ │  │
│  │   └─────────────────────────────────────────┘ │  │
│  └───────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────┘
```

核心设计特征：

- **运行时**：Bun — 原生 TypeScript 执行，内置 SQLite 绑定，启动时间 ~50ms
- **HTTP 框架**：Hono — 基于 Web Standards 的轻量框架，Bun 原生适配
- **进程守护**：PM2 — 自动重启、日志轮转、内存阈值保护
- **初始化入口**：index.ts 作为唯一入口，顺序初始化 DB、HTTP、WebSocket、Cron 四个子系统

选择单进程架构的根本原因：全部模块加起来约 1000 行代码，三个 IO-bound 子系统在 Event Loop 中天然并发，不存在 CPU-bound 瓶颈。引入微服务或多进程只会带来不必要的复杂度。

### 1.2 核心代码模式

```typescript
// index.ts (139 lines)
async function main() {
  // 1. Init database — 必须最先完成，后续子系统依赖 DB 就绪
  const { db, sqlite } = createDB(DB_PATH);
  await initDB(sqlite);

  // 2. Init memory — 确保 SOUL.md/USER.md 存在
  await initMemory(MEMORY_DIR);

  // 3. Create session manager (依赖注入 DB)
  const sessions = createSessionManager(db, sqlite, SESSIONS_DIR);

  // 4. Setup HTTP server (API + Dashboard static files)
  const app = new Hono();
  registerRoutes(app, sqlite, SESSIONS_DIR, MEMORY_DIR);
  app.use("/*", serveStatic({ root: "./web/dist" }));
  serve({ port: PORT, fetch: app.fetch });

  // 5. Start Feishu WebSocket (graceful degradation if no credentials)
  if (process.env.FEISHU_APP_ID && process.env.FEISHU_APP_SECRET) {
    try {
      await initFeishuWS({
        onMessage: async ({ text, threadId, senderId, messageId, chatId }) => {
          // 0. Handle /auth command — send OAuth card
          if (isAuthCommand(text)) {
            await handleAuth(messageId, chatId);
            return;
          }
          // 1. Instant reaction — zero-latency feedback
          addReaction(messageId, "OnIt");
          // 2. chatId 优先路由（同一群聊共享上下文），fallback threadId
          const sessionKey = chatId || threadId;
          const session = await sessions.getOrCreateSession(sessionKey, senderId);
          // 3. StreamingCard 打字机效果 + Agent 处理
          // ...
        },
      });
    } catch (err) {
      console.error("[init] Feishu WS failed, server continues without it");
    }
  }

  // 6. Start cron scheduler
  initCron(runAgent);

  // Graceful shutdown: WAL checkpoint → close
  process.on("SIGINT", () => {
    sqlite.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    sqlite.close();
    process.exit(0);
  });
}
```

初始化顺序是刻意设计的依赖链：DB → Memory → SessionManager → HTTP → WS → Cron。

关键设计变化：
- **SessionManager 工厂模式**：通过 `createSessionManager()` 注入 DB 依赖，避免全局状态
- **chatId 优先路由**：`chatId || threadId` — 同一群聊的所有消息共享上下文，而非按话题线程分割
- **Auth 命令拦截**：在消息处理最前端拦截 `/auth`，不进入 Agent 流程
- **Graceful Degradation**：飞书凭证缺失或 WS 连接失败时，HTTP 和 Cron 继续运行

### 1.3 设计决策

#### Why Bun over Node.js

| 维度 | Bun | Node.js |
|------|-----|---------|
| TypeScript | 原生执行，零配置 | 需要 tsc / tsx / ts-node |
| 启动速度 | ~50ms | ~300ms（影响 PM2 restart 恢复时间） |
| SQLite | `bun:sqlite` C binding，3-5x faster | better-sqlite3（需要 node-gyp 编译） |
| 测试 | `bun test` 内置 | 需要 jest / vitest |
| npm 兼容性 | 99%+，@larksuiteoapi/node-sdk 实测正常 | 100% |

#### Why Hono over Express

| 维度 | Hono | Express |
|------|------|---------|
| 设计理念 | Web Standards (Request/Response) | 自有抽象 (req/res 可变对象) |
| 类型安全 | 路由参数、query、body 完整 TS 推断 | 需要额外类型声明 |
| Bundle 大小 | ~14KB | ~200KB + 常用中间件 |
| 性能 (Bun 上) | ~150K RPS | ~15-30K RPS |
| 中间件模型 | Onion model（类似 Koa） | 线性 callback chain |

#### PM2 配置

```javascript
// ecosystem.config.cjs
module.exports = {
  apps: [{
    name: "openclaw",
    script: "src/index.ts",
    interpreter: "bun",
    autorestart: true,
    max_restarts: 10,
    restart_delay: 3000,
    max_memory_restart: "500M",
    env: { NODE_ENV: "production" }
  }]
};
```

#### Why 扁平文件结构

总计约 1000 行，8 个文件。如果引入 `core/`、`channels/` 等目录分层，每个目录下只有 1-2 个文件，目录结构本身成为认知负担。过早抽象比扁平结构更有害。

### 1.4 面试深挖 Q&A

**Round 1: 为什么选择单进程架构而不是微服务？**

- MVP 阶段全部模块共享一个进程，zero IPC overhead
- 飞书 WS、Cron、API 都是 IO-bound，单线程 Event Loop 天然并发
- 如果需要 CPU 密集计算（如 embedding），用 Bun 的 `worker_threads` 在独立线程执行
- 微服务引入的额外成本：JSON 序列化/反序列化、服务发现、分布式追踪
- **Trade-off**：单进程崩溃意味着全部功能不可用，PM2 `autorestart` + 3s delay 兜底
- 演进路径：需要水平扩展时拆分为独立进程，通过 Redis Pub/Sub 通信

**Round 2: Bun vs Node.js 具体优势？能量化吗？**

- 启动速度 ~50ms vs ~300ms：PM2 autorestart 场景下直接等于服务恢复时间
- 原生 TS：跳过 esbuild/tsc 转译步骤，减少启动时间和内存占用
- SQLite 性能：`bun:sqlite` 直接 C FFI 绑定 ~300K ops/sec vs `better-sqlite3` ~60-80K ops/sec
- npm 兼容性实测：`@larksuiteoapi/node-sdk`（ws + axios）在 Bun 上全功能正常
- 风险：Bun 的 `node:cluster`、`node:inspector` 等边缘模块可能有差异，但 OpenClaw 不使用

**Round 3: PM2 的 max_memory_restart 是怎么工作的？有什么坑？**

- 工作机制：PM2 通过 `pidusage` 定期（每 30s）轮询 RSS。超阈值时先 SIGINT，1600ms 后 SIGKILL
- **坑 1 — RSS 虚高**：RSS 包含共享库内存，实际私有内存可能只有 RSS 的 60-70%
- **坑 2 — 请求中断**：SIGINT 到达时进程可能在执行 API 请求或 SQLite 事务
- **坑 3 — SQLite WAL 安全**：被 SIGKILL 后 SQLite 下次打开时自动 recovery
- 最佳实践：监听 SIGINT，flush 数据库、关闭 WebSocket，然后 `process.exit(0)`

**Round 4: Hono 的中间件机制和 Express 有什么本质区别？**

- Express: 线性 callback chain，`req`/`res` 可变对象
- Hono: Onion Model，`await next()` 前后切面（进入/退出阶段）
- Hono 基于 Web Standards（Request/Response），可在 Bun/Deno/Cloudflare Workers 零修改运行
- 类型安全：路由参数通过 TypeScript 泛型自动推断
- 性能差距本质：Hono 直接使用 Bun 原生 `fetch` handler，零适配层

**Round 5: 如果飞书 WebSocket 断连了，会影响其他子系统吗？**

- 飞书 SDK WSClient 内置自动重连（指数退避，最大 30s），index.ts 不感知
- 三个子系统完全独立：WS 断连时 API 和 Cron 正常运行
- 监控：Heartbeat 可以检测"最近 5 分钟是否收到过飞书消息"
- 极端场景：飞书全局故障，WSClient 持续重试，每 30s 一次 TCP 连接尝试，资源占用可忽略

**Round 6: 为什么不用 Docker 而是 PM2？**

- 2GB VPS 内存预算：Docker daemon + 容器运行时 ~200-300MB overhead（10-15%），PM2 只占 ~30MB
- 部署极简：`git pull && bun install && pm2 reload openclaw --update-env`
- 调试便利：直接 `pm2 logs`、`pm2 monit`，无需 `docker exec -it`
- Trade-off: Docker 提供更好的环境一致性，但 MVP 依赖简单（Bun + npm），环境差异风险低
- 迁移成本低：写 Dockerfile + 把 `pm2 start` 换成 `bun run src/index.ts`

---

## 2. 飞书 WebSocket 通信 (feishu-ws.ts)

### 2.1 设计概述

feishu-ws.ts 是 OpenClaw 与外部世界的唯一消息入口：

1. 通过 `@larksuiteoapi/node-sdk` 的 `WSClient` 建立飞书长连接
2. 监听 `im.message.receive_v1` 事件，解析用户消息
3. 将消息路由到 Agent Runner，获取流式响应
4. POST 创建 + PATCH 增量更新实现"打字机"效果的流式回复

```
用户发送消息
      │
      v
┌──────────────┐    im.message.receive_v1     ┌──────────────────┐
│  Feishu      │ ──────────────────────────>  │  feishu-ws.ts    │
│  Server      │                              │                  │
│              │  <── POST reply (首条消息) ──  │  extractText()   │
│              │  <── PATCH x N (流式更新) ──  │  handleMessage() │
│              │  <── PATCH final (最终版本) ── │  sendStreaming()  │
└──────────────┘    debounce 500ms            └────────┬─────────┘
                                                       │
                                                       v
                                              ┌──────────────────┐
                                              │  agent.ts        │
                                              │  AsyncGenerator  │
                                              └──────────────────┘
```

### 2.2 核心代码模式

```typescript
// feishu-ws.ts (427 lines) — 最大模块

// WebSocket 初始化：延迟 import + 依赖注入
export async function initFeishuWS(config: {
  appId: string; appSecret: string;
  onMessage: (params: { text, threadId, senderId, messageId, chatId }) => Promise<void>;
}) {
  const lark = await import("@larksuiteoapi/node-sdk");
  larkClient = new lark.Client({ appId, appSecret });

  const eventDispatcher = new lark.EventDispatcher({}).register({
    "im.message.receive_v1": async (data) => {
      const text = extractText(data.message);
      if (!text) return;  // 空消息（只有 @提及）不触发
      const threadId = data.message.thread_id || data.message.message_id;
      await config.onMessage({
        text, threadId,
        senderId: data.sender.sender_id.open_id,
        messageId: data.message.message_id,
        chatId: data.message.chat_id,  // 新增：群聊 ID，用于 session 路由
      });
    },
  });

  const wsClient = new lark.WSClient({ appId, appSecret });
  await wsClient.start({ eventDispatcher });
}

// StreamingCard — CardKit 流式卡片控制器（5 步生命周期）
//   1. cardkit.v1.card.create — 创建 streaming_mode 卡片
//   2. im.message.reply — 作为回复消息发送
//   3. cardkit.v1.cardElement.content — 推送文本（平台渲染打字机效果）
//   4. cardkit.v1.card.settings — 关闭 streaming mode
//   5. cardkit.v1.card.update — 设置最终状态
export class StreamingCard {
  private cardId: string | null = null;
  private sequence = 0;
  private lastFlush = 0;
  private dirty = false;
  private useFallback = false;  // CardKit 不可用时降级

  async create(replyToMsgId: string) {
    try {
      const resp = await larkClient.cardkit.v1.card.create({
        data: { type: "card_json", data: JSON.stringify({
          config: { streaming_mode: true, streaming_config: {
            print_frequency_ms: { default: 50 },  // 打字机速度
            print_step: { default: 2 },
            print_strategy: "fast",
          }},
          header: { title: { content: "💭 思考中..." }, template: "wathet" },
          body: { elements: [
            { tag: "markdown", content: "...", element_id: "main_content" },
          ]},
        })},
      });
      this.cardId = resp?.data?.card_id;
      // 作为回复消息发送
      await larkClient.im.message.reply({ ... });
    } catch {
      this.useFallback = true;  // 降级到 message.patch
      await this.createFallback(replyToMsgId);
    }
  }

  async pushContent(fullText: string) {
    this.dirty = true;
    if (Date.now() - this.lastFlush < 300) return;  // 300ms debounce
    await this.flush();
  }

  async complete(finalText: string) {
    await larkClient.cardkit.v1.card.settings({  // 关闭 streaming
      data: { settings: JSON.stringify({ config: { streaming_mode: false } }) },
    });
    await larkClient.cardkit.v1.card.update({  // 最终卡片
      data: { card: { type: "card_json", data: JSON.stringify(finalCard) } },
    });
  }
}
```

### 2.3 设计决策

| 决策 | 选择 | 理由 |
|------|------|------|
| 通信方式 | WebSocket (WSClient) | 无需公网 IP，实时性 <100ms，SDK 自动重连 |
| 流式渲染 | CardKit streaming_mode | 原生打字机动画（50ms/2字符），比 message.patch 体验好一个量级 |
| 流式限流 | debounce 300ms | CardKit 限制 5次/秒/消息，300ms ≈ 3.3次/秒，留 30% 余量 |
| 会话路由 | chatId \|\| threadId | chatId 优先：同一群聊共享上下文；threadId fallback 支持话题线程 |
| 降级策略 | CardKit → message.patch | CardKit 不可用自动 fallback，streaming 超时自动 reEnable |
| Markdown 渲染 | 直接透传 | 飞书卡片支持 Markdown 子集，Claude 输出天然兼容 |

### 2.4 面试深挖 Q&A

**Round 1: WebSocket 和 Webhook 的本质区别？**

- Webhook: HTTP POST 回调，需要公网可达 URL，有延迟（DNS + TCP + TLS ~150ms）
- WebSocket: 全双工长连接，客户端主动连接，延迟 <10ms
- 飞书 SDK WSClient 底层是 WebSocket + 自动重连 + 消息确认
- 选择原因：(1) 无需 ngrok/frp (2) VPS 只需出站连接 (3) 实时性高
- 如果是 SaaS 服务数千租户，Webhook 更合适（无状态、易扩展）

**Round 2: CardKit streaming_mode 和 message.patch 的区别？**

- CardKit streaming_mode 是飞书原生的"打字机"渲染引擎，开启后飞书客户端对推送文本做逐字动画
- `print_frequency_ms: 50, print_step: 2`：每 50ms 显示 2 个字符，类似 ChatGPT 效果
- message.patch 是整体替换消息内容，用户看到的是"闪烁更新"，体验差距明显
- streaming_mode 有内置超时（~60s 无更新自动关闭），需要 reEnableStreaming 恢复
- fallback 策略：CardKit 不可用 → 自动降级到 message.patch，同一卡片内不可逆（下条消息重试 CardKit）

**Round 3: debounce 300ms 策略有什么问题？**

- 飞书 API 限流：消息创建 50次/秒/应用，CardKit content 推送 5次/秒/消息
- 300ms debounce ≈ 3.3次/秒，留约 30% 余量
- 问题 1：10+ 并发会话同时创建消息可能触发 50/sec 全局限制
- 问题 2：debounce 期间进程崩溃，最后一段回复丢失（dirty flag 为 true 但未 flush）
- 额外优化：`simpleHash` 对 fullText 做 DJB2 哈希，内容未变时跳过 API 调用
- 改进：Token Bucket 算法替代简单 debounce，但 MVP 阶段没必要

**Round 3: 飞书 WebSocket 断连后消息会丢失吗？**

- 飞书保证 at-least-once 投递：断连期间消息在服务端排队，重连后按序推送
- at-least-once 意味着可能重复：用 message_id 作为幂等键在 SQLite 中去重
- 先标记再处理（at-most-once）vs 先处理再标记（at-least-once）：对话场景选前者更安全
- 已处理的 message_id 保留 24h 后清理

**Round 4: extractText 怎么处理不同消息类型？**

- text: `JSON.parse(content).text`，strip `@_user_\d+` 占位符
- post（富文本）：递归遍历 content 树，提取 `tag === "text"` 和 `tag === "a"` 节点
- image/file/audio: 暂不支持，回复"请发送文字消息"
- 边界：空消息（只有 @提及）→ strip 后为空 → 不触发 Agent

**Round 5: chatId 和 threadId 作为 session key 有什么区别？**

- `chatId`：飞书群聊/私聊的唯一标识，同一群里所有消息共享一个 session
- `threadId`：话题线程标识，同一话题内的消息共享 session
- 当前策略 `chatId || threadId`：优先 chatId，让同群消息共享上下文
- 优势：用户不需要在特定话题中回复，群里随便发消息都能延续对话
- 劣势：多人同时在一个群里发消息会混入同一个 session
- 演进：多用户场景可改为 `chatId + senderId` 或 `threadId` 优先

**Round 6: 用户在 Agent 处理时发送新消息怎么办？**

- 方案 1 — 串行队列：当前 thread 有任务执行时入队，完成后依次处理
- 方案 2 — 中断重定向：检测"取消/算了"关键词，kill 当前 Agent 进程
- MVP 选择方案 1 + 友好提示（"收到，当前任务完成后会处理"）
- 队列深度限制：最大 5 条，超出后回复"请等待当前任务完成"

---

## 3. Claude Code CLI 封装 (agent.ts)

### 3.1 设计概述

- 通过 `child_process.spawn` 调用 `claude` CLI
- 使用 `--output-format stream-json` 获取流式 JSON 输出
- 使用 `--session-id` + `--resume` 实现会话续接
- 每个飞书 thread 对应一个 Claude Code session

### 3.2 核心代码模式

```typescript
// agent.ts (198 lines)
import { spawn, type ChildProcess } from "child_process";

const DEFAULT_AGENT_CWD = "./data";  // 包含 CLAUDE.md, memory/, skills/

interface StreamChunk {
  type: "assistant" | "tool_use" | "tool_result" | "status" | "result";
  content?: string;
  tool?: string;
  duration?: number;
  cost?: number;
}

// ── 进程生命周期管理 ──
const activeProcesses = new Map<string, ChildProcess>();

// ── Session UUID 映射 ──
// OpenClaw sessionId ↔ Claude Code 内部 session UUID
const claudeSessionMap = new Map<string, string>();

export function buildAgentArgs(options: {
  sessionId: string; prompt: string; claudeSessionUuid?: string;
}): string[] {
  const args = [
    "--output-format", "stream-json",
    "--print",                          // 非交互模式
    "--verbose",
    "--dangerously-skip-permissions",   // 守护进程无法交互确认
  ];
  if (options.claudeSessionUuid) {
    args.push("--resume", options.claudeSessionUuid);  // 续接 Claude 会话
  }
  args.push(options.prompt);
  return args;
}

export async function runAgent(options: AgentOptions): Promise<void> {
  const claudeUuid = claudeSessionMap.get(options.sessionId);
  const args = buildAgentArgs({ ...options, claudeSessionUuid: claudeUuid });

  const proc = spawn("claude", args, {
    cwd: options.workDir || DEFAULT_AGENT_CWD,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, CLAUDE_CODE_ENTRYPOINT: "openclaw" },
  });
  activeProcesses.set(options.sessionId, proc);

  let buffer = "";
  proc.stdout.on("data", (data: Buffer) => {
    buffer += data.toString();
    const { lines, remaining } = processStreamBuffer(buffer);
    buffer = remaining;

    for (const line of lines) {
      // 首次捕获 Claude 的 session UUID
      if (!claudeSessionMap.has(options.sessionId)) {
        try {
          const parsed = JSON.parse(line);
          if (parsed.session_id) {
            claudeSessionMap.set(options.sessionId, parsed.session_id);
          }
        } catch {}
      }
      const chunk = parseStreamLine(line);
      if (chunk) options.onStream?.(chunk);
    }
  });

  proc.on("close", (code) => {
    activeProcesses.delete(options.sessionId);
    code === 0 ? options.onEnd?.({ ... }) : options.onError?.(new Error(`Exit ${code}`));
  });
}
```

### 3.3 设计决策

| 决策 | 选型 | 理由 |
|------|------|------|
| 进程创建 | spawn over exec | spawn 流式输出，exec 全量缓冲（默认 200KB maxBuffer） |
| LLM 接入 | CLI over API | CLI 内置上下文管理、tool use、file access、git 操作 |
| 输出格式 | stream-json | NDJSON 格式逐行解析，获取实时输出 |
| 会话续接 | UUID 映射 + --resume | 从 stream 中捕获 Claude session_id，下次用 --resume 续接 |
| 权限模式 | --dangerously-skip-permissions | 守护进程无法交互确认，需跳过权限提示 |
| 工作目录 | `./data` | 包含 CLAUDE.md、memory/、skills/，Agent 在此上下文中运行 |
| stdio | `['pipe', 'pipe', 'pipe']` | 读 stdout（流式）、stderr（错误）、stdin 预留交互能力 |

### 3.4 面试深挖 Q&A

**Round 1: spawn 和 exec 的本质区别？**

- exec: `/bin/sh -c` 创建 shell → 缓冲全部 stdout → 进程结束后回调
- spawn: 直接 fork+execve → stdout/stderr 是 Stream → 数据实时可读
- exec 问题：(1) 输出大则 OOM (2) 必须等进程结束
- spawn 优势：(1) 流式读取，内存恒定 (2) 实时转发 (3) 可 kill 中断
- 底层都是 libuv 的 uv_spawn，Bun 用 zig 的 posix_spawn 更快

**Round 2: stream-json 输出格式是什么？怎么解析？**

- NDJSON 格式，每行一个 JSON 对象
- 事件类型：system（状态）、assistant（文本/工具调用）、tool_result、result（最终结果）
- 关键：stdout `data` 事件可能收到半行 JSON（TCP 分包），必须 buffer + split("\n")
- 常见 bug：直接 `JSON.parse(data.toString())` 会因不完整 JSON 失败

**Round 3: --session-id 和 --resume 怎么实现会话续接？**

- Claude Code 在 `~/.claude/sessions/` 维护 JSONL session 文件
- `--resume` 在现有上下文基础上继续，Claude Code 自动压缩旧消息
- 好处：无需自己实现上下文管理、token 计数、消息裁剪
- session 文件存储完整 message history，resume 时读取 + 构建上下文

**Round 4: activeProcesses Map 的作用？不清理会怎样？**

- 跟踪运行中进程，支持 abortAgent() 和 graceful shutdown
- 不清理后果：(1) 孤儿进程被 init 接管 (2) PM2 重启后旧 claude 子进程仍在跑 (3) 多进程写同一个 session file 导致数据损坏
- 最佳实践：`process.on("SIGTERM", () => { activeProcesses.forEach(p => p.kill()); })`

**Round 5: Claude Code CLI 超时怎么办？**

```typescript
const timeout = setTimeout(() => {
  proc.kill("SIGTERM");
  onError(new Error("Agent timeout after 5 minutes"));
}, 5 * 60 * 1000);
proc.on("close", () => clearTimeout(timeout));
```

- 先 SIGTERM（允许 cleanup），5 秒后 SIGKILL
- `proc.kill()` 只是发送信号，不保证立即退出
- `--max-turns` 限制 Claude Code 的工具调用轮数

**Round 6: 背压(backpressure)问题？**

- 场景：Claude 每秒 10 chunk，飞书 PATCH 限制 5次/秒
- onStream 应该是同步的（追加 buffer），异步飞书 API 由独立 flush 循环处理
- Bun 的 spawn 和 Node.js 行为不同：Bun 默认不 pause readable stream
- 最佳实践：分离数据收集（同步）和数据发送（异步 + debounce）

---

## 4. 会话管理 (session.ts)

### 4.1 设计概述

- 飞书 Thread ID → OpenClaw Session ID 映射
- Session 状态机：idle → active → streaming → completed/error
- JSONL 文件持久化消息，SQLite 存储 session 元数据

### 4.2 核心代码模式

```typescript
// session.ts (121 lines) — 工厂模式 + 依赖注入

// 工厂函数：返回带闭包的 API 对象，注入 DB 依赖
export function createSessionManager(db: any, sqlite: Database, sessionsDir: string) {
  return {
    getOrCreateSession: (threadId: string, userId: string) =>
      getOrCreateSession(sqlite, sessionsDir, threadId, userId),
    appendMessage: (sessionId: string, message: Omit<Message, "timestamp">) =>
      appendMessage(sqlite, sessionsDir, sessionId, message),
    getMessages: (sessionId: string) => getMessages(sessionsDir, sessionId),
    updateStatus: (sessionId: string, status: SessionStatus) =>
      updateStatus(sqlite, sessionId, status),
  };
}

// 注意：threadId 参数实际传入的是 chatId || threadId（由 index.ts 决定）
async function getOrCreateSession(
  sqlite: Database, sessionsDir: string, threadId: string, userId: string
): Promise<Session> {
  const existing = sqlite
    .query("SELECT * FROM sessions WHERE thread_id = ? LIMIT 1")
    .get(threadId);

  if (existing) return mapRow(existing);

  const id = `sess_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  sqlite.query(
    `INSERT INTO sessions (id, thread_id, user_id, status, message_count, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(id, threadId, userId, "idle", 0, Date.now(), Date.now());

  return { id, threadId, userId, status: "idle", messageCount: 0, ... };
}

// JSONL append + SQLite message_count++
async function appendMessage(sqlite: Database, sessionsDir: string,
  sessionId: string, message: Omit<Message, "timestamp">): Promise<void> {
  const line = JSON.stringify({ ...message, timestamp: Date.now() }) + "\n";
  await appendFile(join(sessionsDir, `${sessionId}.jsonl`), line);
  sqlite.query("UPDATE sessions SET message_count = message_count + 1, updated_at = ? WHERE id = ?")
    .run(Date.now(), sessionId);
}
```

注意：代码中混用了 Drizzle schema 定义（`db.ts` 中的 `sqliteTable`）和裸 SQL 查询（`sqlite.query(...)`）。这是有意为之：Drizzle schema 提供类型文档和迁移能力，裸 SQL 保持查询直接简单。

### 4.3 设计决策

| 决策 | 选型 | 理由 |
|------|------|------|
| 消息存储 | JSONL 文件 | append-only，写入极快，debug 友好 |
| 元数据存储 | SQLite | 需要查询能力（按状态/时间排序） |
| 双存储 | JSONL + SQLite | 关注点分离：事件流 vs 可变状态 |
| Session ID | `sess_{timestamp}_{random}` | 时间戳排序 + 随机数防冲突 |

### 4.4 面试深挖 Q&A

**Round 1: 为什么消息用 JSONL 而不是 SQLite？**

- JSONL 是 append-only log，一次 append syscall，写入极快
- 对话消息"写多读少"：每次对话写 N 条，只查看历史时读
- Debug 友好：`cat session.jsonl | jq`
- Trade-off: 不支持按条件查询、原子更新、索引

**Round 2: "文件系统 atomic append" 真的并发安全吗？**

- POSIX：O_APPEND 模式 write() 在 <= PIPE_BUF（4096 bytes）时是原子的
- 一条 JSON 消息 <1KB，在 PIPE_BUF 范围内
- 但 `fs.appendFile` 可能不是单次 syscall → 用 `Bun.write()` 或同步版本更安全
- 实际不会发生并发写入：一个 session 同时只有一个 Agent

**Round 3: Session 状态机怎么设计？**

```
idle → active → streaming → completed
  ↑       ↑         │            │
  │       │         ↓            │
  │       └── error ←────────────┘
  └─────────────┘
```

- `validateTransition(from, to)` 白名单校验
- MVP 不需要严格状态机，直接 updateStatus

**Round 4: threadId 和 sessionId 为什么分开？**

- threadId 是飞书概念（外部依赖），sessionId 是内部概念
- 一个 threadId 可能对应多个 session（用户 /reset）
- 未来多通道（微信/Slack）的 thread 概念不同
- Claude Code 的 `--session-id` 需要稳定 ID

**Round 5: JSONL 文件很大时性能问题？**

- 10000 条 × 500B = 5MB，`readFile` 全量读入可接受
- 优化方向：流式 readline、分页、文件分片
- MVP 不优化，10000 条场景极少出现

**Round 6: 为什么用 Drizzle 而不是裸 SQL？**

- TypeScript-first：schema 即 TS 代码，类型推断完整
- vs Prisma：无需 generate，无运行时引擎，bundle 极小
- vs 裸 SQL：类型安全、防注入、IDE 补全
- 零运行时开销：生成的 SQL 和手写几乎一样

---

## 5. 定时调度与 Heartbeat (cron.ts)

### 5.1 设计概述

Heartbeat 是 OpenClaw 的核心创新：定时唤醒一个有记忆、有技能的 AI Agent，让它自主决定做什么。

- node-cron 实现进程内定时调度
- 每 30 分钟唤醒 Claude Code，触发 /heartbeat skill
- 固定 session 保证记忆延续
- 内存级 mutex 防止并发执行

### 5.2 核心代码模式

```typescript
// cron.ts (69 lines) — HeartbeatGuard 类 + 依赖注入

// 内存级互斥锁，封装为类（比裸 boolean flag 更安全）
export class HeartbeatGuard {
  private running = false;
  isRunning(): boolean { return this.running; }
  tryAcquire(): boolean {
    if (this.running) return false;
    this.running = true;
    return true;
  }
  release(): void { this.running = false; }
}

// 工厂函数：创建 Heartbeat 回调，注入 guard + runAgent 依赖
export function createHeartbeatHandler(
  guard: HeartbeatGuard,
  runAgent: (options: AgentOptions) => Promise<void>
) {
  return async () => {
    if (!guard.tryAcquire()) return;  // 已有 Heartbeat 在运行

    try {
      await runAgent({
        sessionId: "heartbeat-main",  // 固定 ID 保证记忆延续
        prompt: "You are woken up by the heartbeat cron. Execute /heartbeat skill.",
        onStream: () => {},
        onEnd: () => { guard.release(); },
        onError: (err) => { guard.release(); },
      });
    } catch { guard.release(); }
  };
}

export function initCron(runAgent: (options: AgentOptions) => Promise<void>) {
  const guard = new HeartbeatGuard();
  const handler = createHeartbeatHandler(guard, runAgent);
  cron.schedule("*/30 * * * *", handler);
  return { guard, handler };  // 返回引用，便于测试
}
```

### 5.3 Heartbeat Skill 示例

```markdown
# /heartbeat (data/skills/heartbeat/SKILL.md)

You are triggered by the heartbeat timer.

## Tasks
1. Check pending reminders
2. Review recent conversations — follow up?
3. Check calendar — upcoming meetings to prepare?
4. Update USER.md with new insights
5. If nothing to do, log "heartbeat: all clear" and exit
```

### 5.4 面试深挖 Q&A

**Round 1: Heartbeat 为什么是核心创新？**

| 维度 | 普通 cron job | Heartbeat |
|------|--------------|-----------|
| 执行内容 | 固定脚本 | AI Agent 自主决策 |
| 上下文 | 无状态 | 固定 session，有记忆 |
| 能力 | 脚本硬编码 | 可调用任意 skill |
| 判断力 | 无条件执行 | 没事就退出，有事才行动 |

核心："context, not control" — 给 Agent 上下文，不控制每一步。

**Round 2: heartbeatRunning mutex 有什么问题？**

- 问题 1：异常死锁 — `onEnd` 回调抛异常时 flag 永远为 true → 用 try-finally 修复
- 问题 2：PM2 重启竞态 — 新进程 flag 为 false 但旧 claude 子进程还在 → PID file 检查
- 分布式场景需要 Redis SETNX 或 SQLite advisory lock
- MVP 单进程场景内存 mutex + try-finally 足够

**Round 3: Heartbeat 超过 30 分钟怎么办？**

```typescript
const timer = setTimeout(() => {
  abortAgent(HEARTBEAT_SESSION);
  heartbeatRunning = false;
}, 10 * 60 * 1000); // 10 min timeout
```

- 超时 10 分钟（留 20 分钟 buffer）
- `--max-turns` 限制 Agent 执行深度
- 正常 Heartbeat 应该在 1-2 分钟内完成

**Round 4: node-cron vs system crontab？**

| 维度 | node-cron | system crontab |
|------|-----------|----------------|
| 精度 | 秒级 | 分钟级 |
| 可靠性 | 依赖进程存活 | 独立于应用 |
| 漂移 | event loop 阻塞时漂移 | OS 内核调度不漂移 |
| 集成 | 进程内调用 runAgent() | 需 HTTP API 间接调用 |

选 node-cron：Heartbeat 需要直接调用 `runAgent()`，进程内调用比 HTTP 间接调用简单。

**Round 5: 动态定时任务怎么实现？安全考虑？**

- SQLite 存储 `{ id, cronExpr, prompt, enabled }`
- `cron.validate(expr)` 校验表达式
- 最小间隔限制（不允许每秒执行）
- Claude Code `--permission-mode` 沙箱隔离 prompt 注入
- MVP 先不实现，硬编码 Heartbeat

**Round 6: Heartbeat 成本控制？**

- 每次 ~2000-5000 tokens，Claude Sonnet $3/1M input + $15/1M output
- 保守估算：48次/天 → ~$1.87/天 ≈ $56/月
- 优化：快速退出路径（无事则 ~$15/月）、降频到 1h/次（减半）、Haiku 降级（$5/月）

---

## 6. 记忆系统 (memory.ts)

### 6.1 设计概述

三层记忆架构，文件系统存储，关键词匹配召回：

```
data/memory/
├── SOUL.md          ← Layer 1: 身份（几乎不变）
├── USER.md          ← Layer 2: 用户画像（缓慢变化）
└── topics/          ← Layer 3: 话题记忆（频繁变化）
    ├── project-alpha.md
    ├── calendar.md
    └── career-goals.md
```

设计约束：全英文（token 效率 2-3x）、每文件 <1000 tokens、零依赖召回。

### 6.2 核心代码模式

```typescript
// memory.ts (~200 lines)
import { readFile, writeFile, readdir, mkdir } from "fs/promises";
import { existsSync } from "fs";

const MEMORY_DIR = "./data/memory";

export async function initMemory(): Promise<void> {
  await mkdir(`${MEMORY_DIR}/topics`, { recursive: true });
  if (!existsSync(`${MEMORY_DIR}/SOUL.md`)) {
    await writeFile(`${MEMORY_DIR}/SOUL.md`, DEFAULT_SOUL_TEMPLATE);
  }
  if (!existsSync(`${MEMORY_DIR}/USER.md`)) {
    await writeFile(`${MEMORY_DIR}/USER.md`, DEFAULT_USER_TEMPLATE);
  }
}

export async function getCoreMemory(): Promise<{ soul: string; user: string }> {
  const soul = await readFile(`${MEMORY_DIR}/SOUL.md`, "utf-8");
  const user = await readFile(`${MEMORY_DIR}/USER.md`, "utf-8");
  return { soul, user };
}

export async function recallMemories(query: string, maxFiles = 3): Promise<MemoryFile[]> {
  const topicsDir = `${MEMORY_DIR}/topics`;
  if (!existsSync(topicsDir)) return [];
  
  const files = await readdir(topicsDir);
  const keywords = extractKeywords(query);
  
  const scored = await Promise.all(
    files.filter(f => f.endsWith(".md")).map(async f => {
      const content = await readFile(`${topicsDir}/${f}`, "utf-8");
      const score = scoreRelevance(keywords, f, content);
      return { name: f, content, tokens: Math.ceil(content.length / 4), score };
    })
  );
  
  return scored.filter(m => m.score > 0).sort((a, b) => b.score - a.score).slice(0, maxFiles);
}

function scoreRelevance(keywords: string[], filename: string, content: string): number {
  const target = (filename + " " + content).toLowerCase();
  return keywords.reduce((score, kw) => {
    if (filename.toLowerCase().includes(kw)) return score + 3; // filename match 权重 3x
    if (target.includes(kw)) return score + 1;
    return score;
  }, 0);
}
```

### 6.3 CLAUDE.md 集成

```markdown
# CLAUDE.md
You have just been awakened by your user.
First read SOUL.md to recall who you are:
@memory/SOUL.md

Then read USER.md to recall who the user is:
@memory/USER.md
```

### 6.4 面试深挖 Q&A

**Round 1: 为什么文件系统而不是数据库/RAG？**

- Claude Code 原生 `@file` 引用，无需额外 API
- 人类可直接 vim 编辑，Git 追踪变更历史
- 文件 I/O <1ms vs 数据库 >5ms
- RAG 需要 embedding 模型（额外成本/延迟），50 个文件全量扫描 <1ms
- 切换到 RAG 的触发条件：文件 >1000 个，或需要语义搜索

**Round 2: 为什么每文件限制 <1000 tokens？**

- SOUL + USER 通过 @引用始终加载到 context
- 无限制方案：10000 tokens/次 × 50 次/天 = 500K tokens/天 ≈ $45/月
- 限制方案：1600 tokens/次 × 50 次/天 = 80K tokens/天 ≈ $7.2/月
- 核心原则：**memory 是索引，不是数据库**

**Round 3: 关键词匹配 vs Embedding？**

| 维度 | 关键词匹配 | Embedding |
|------|-----------|-----------|
| 50 文件延迟 | <1ms | ~100ms (API) |
| 精确查询 | 强 | 弱 |
| 语义理解 | 无 | 强 |
| 依赖 | 零 | embedding 模型 |

MVP 选关键词：文件名即标签、数据量小、用户可调优命名。

**Round 4: 记忆压缩怎么工作？**

- 触发时机：对话结束后 / Heartbeat 巡检
- 压缩流程：读超标文件 → Claude 压缩到 500 tokens → 写回
- 保留：决策、偏好、教训；丢弃：时间戳、临时上下文
- 安全网：原始对话在 JSONL 中保留，Git 追踪变更

**Round 5: SOUL.md 和 USER.md 为什么分离？**

- SOUL（身份）几乎不变 → 类比宪法
- USER（画像）缓慢变化 → 类比个人档案
- topics（笔记）频繁变化 → 类比日志
- SOUL + USER 始终加载（成本可控），topics 按需召回

**Round 6: 如何防止记忆污染？**

- Layer 1 — Permission Control: Claude Code tool use 需权限确认
- Layer 2 — Git Audit: 所有 memory 变更被追踪，可 revert
- Layer 3 — Self-Correction: SOUL.md Lessons Learned 记录错误
- Layer 4 — Human Review: Dashboard 展示 memory 内容和变更
- MVP 依赖 Git + 人类 review，不做自动防御

---

## 7. 飞书 OAuth 授权 (feishu-auth.ts)

### 7.1 设计概述

feishu-auth.ts 实现了 **OAuth 2.0 Device Flow**，让用户在飞书群聊中通过点击卡片按钮完成授权，无需手动复制 token。

核心流程：

```
用户发送 "/auth"
      │
      v
┌──────────────────┐    lark-cli auth login     ┌─────────────────┐
│  feishu-auth.ts  │ ──── --no-wait --json ──>  │   lark-cli      │
│                  │ <── device_code +           │   Device Flow   │
│  isAuthCommand() │     verification_url        │                 │
│  handleAuth()    │                             └─────────────────┘
└────────┬─────────┘
         │
         v  发送 OAuth 卡片（带授权按钮）
┌──────────────────┐
│  飞书客户端      │  用户点击按钮 → 浏览器授权
└────────┬─────────┘
         │
         v  后台 polling（fire-and-forget）
┌──────────────────┐    lark-cli auth login     ┌─────────────────┐
│  feishu-auth.ts  │ ──── --device-code xxx ──> │   lark-cli      │
│  pollDeviceCode()│ <── exit code 0 (成功)     │   Token 交换    │
│                  │                             └─────────────────┘
│  checkAuthStatus │  ← fallback: 超时后检查
└────────┬─────────┘     token 是否已有效
         │
         v  成功时发送确认卡片
┌──────────────────┐
│  飞书客户端      │  "✅ 授权成功！"
└──────────────────┘
```

### 7.2 核心代码模式

```typescript
// feishu-auth.ts (252 lines)

// 13 个飞书 API scope，覆盖日历、任务、文档、通讯录、消息
const ALL_SCOPES = [
  "calendar:calendar.event:read", "calendar:calendar.event:write",
  "task:task:read", "task:task:write",
  "contact:user.base:readonly",
  "im:message:readonly", "im:message",
  "docs:document:readonly", "docx:document:readonly",
  "wiki:node:read", "wiki:wiki:readonly",
  "drive:drive.metadata:readonly", "sheets:spreadsheet:readonly",
].join(" ");

// 命令检测（支持中英文）
export function isAuthCommand(text: string): boolean {
  const t = text.trim().toLowerCase();
  return t === "/auth" || t === "授权" || t === "auth" || t === "/授权";
}

export async function handleAuth(messageId: string, chatId: string) {
  // Step 1: 获取 verification URL（非阻塞）
  const deviceInfo = await runLarkCliNoWait();
  // → spawn("lark-cli", ["auth", "login", "--no-wait", "--domain", "all", "--json"])
  // → 解析 stdout JSON: { device_code, verification_url, expires_in }

  // Step 2: 发送带授权按钮的卡片
  const card = buildAuthCard(deviceInfo.verificationUrl);
  await larkClient.im.message.reply({ ... });

  // Step 3: 后台 polling — fire-and-forget，只在成功时通知
  pollDeviceCode(deviceInfo.deviceCode).then(async (success) => {
    if (success) {
      await larkClient.im.v1.message.create({
        data: { receive_id: chatId, content: JSON.stringify(successCard) },
      });
    }
    // 失败时静默 — 不打扰用户
  });
}

// 超时后的 fallback: 检查 token 是否已通过其他路径获得
function checkAuthStatus(): Promise<boolean> {
  return new Promise((resolve) => {
    const proc = spawn("lark-cli", ["auth", "status", "--json"]);
    // 解析 tokenStatus !== "expired" && scope 存在
  });
}
```

### 7.3 设计决策

| 决策 | 选型 | 理由 |
|------|------|------|
| OAuth 流程 | Device Flow | 群聊场景无法 redirect，Device Flow 让用户在浏览器完成授权 |
| CLI 集成 | lark-cli spawn | 复用 lark-cli 的 token 管理，Agent 后续可直接用 lark-cli 命令 |
| 通知策略 | 只通知成功 | 失败/超时静默处理，避免打扰用户（可重新 /auth） |
| 超时处理 | 10 分钟 + checkAuthStatus | polling 超时后检查 token 是否已有效（用户可能通过其他路径授权） |

### 7.4 面试深挖 Q&A

**Round 1: 为什么用 Device Flow 而不是 Authorization Code Flow？**

- Authorization Code Flow 需要 redirect_uri — 飞书群聊没有浏览器环境可以 redirect
- Device Flow 专为无浏览器设备设计：展示 URL → 用户在任意设备打开 → 后台 polling 等待
- 飞书 lark-cli 实现了完整的 Device Flow（device_code 发放 + polling + token 交换）
- 这也是 GitHub CLI (`gh auth login`) 和 VS Code 扩展的标准授权模式

**Round 2: fire-and-forget 的 polling 有什么风险？**

- 风险 1：进程崩溃时 polling 子进程变成孤儿 — `pollDeviceCode` spawn 的 lark-cli 会被 init 接管
- 风险 2：用户已授权但通知消息发送失败 — token 已保存在本地，功能不受影响，只是缺少确认
- 风险 3：10 分钟超时后 token 过期 — `checkAuthStatus()` 作为最后检查，如果 token 有效照样报成功
- 设计哲学：授权是低频操作（一次性），不值得为边缘 case 增加复杂度

**Round 3: 为什么用 spawn lark-cli 而不是直接调 OAuth API？**

- lark-cli 封装了完整的 OAuth 流程（device code 发放、polling 间隔、token 交换、token 本地存储）
- 直接调 API 需要 ~200 行代码处理同样的事情
- 核心优势：lark-cli 存储的 token 可以被 Agent 的 lark-cli 命令直接复用
- 如果直接用 API 获取 token，还需要额外的 token 传递机制

**Round 4: `--no-wait` 和 `--device-code` 两步分离的设计？**

- `--no-wait`：立即返回 device_code + verification_url（不阻塞）→ 用于构建卡片
- `--device-code`：阻塞式 polling 直到用户完成授权或超时 → 后台执行
- 分离的好处：卡片可以立即发送（用户体验），polling 在后台运行（不阻塞消息处理）
- 如果合并为一步（阻塞到授权完成），用户要等 polling 结束才能看到卡片 — 无法接受

**Round 5: 13 个 scope 是怎么确定的？安全考虑？**

- scope 覆盖 Agent 的核心能力：日历（读写）、任务（读写）、文档（只读）、通讯录（只读）、消息（读写）
- 最小权限原则：文档和通讯录只需 readonly，不需要写入权限
- `--domain all` 授权所有可用的 scope，用户在授权页面可以看到完整列表
- 安全边界：token 存储在服务器本地，不经过飞书消息传输；`lark-cli auth status` 可审查

**Round 6: 多用户授权怎么处理？**

- 当前 MVP 是单用户设计：lark-cli 存储一个全局 token
- 多用户演进：`lark-cli --as user --user-token xxx` 支持 per-user token
- 或者用 `--profile` 参数为每个用户创建独立配置
- 卡片中的 chatId 可以关联用户身份，但当前不做多用户隔离

---

## 8. Skill 系统

### 8.1 设计概述

**核心洞察：Skill = Prompt 工程，不是代码插件。**

利用 Claude Code 原生 skill 机制（SKILL.md 文件），零代码量、零编译、零部署。

```
data/skills/
├── heartbeat/SKILL.md        # 定时心跳
├── feishu-calendar/SKILL.md  # 飞书日历
├── feishu-doc/SKILL.md       # 飞书文档
├── memory-compress/SKILL.md  # 记忆压缩
└── skill-creator/SKILL.md    # 元技能：自创建 Skill
```

### 8.2 Skill 示例

```markdown
# data/skills/feishu-calendar/SKILL.md
Read user's Feishu calendar and summarize upcoming events.

## Steps
1. Use feishu-cli to fetch today's and tomorrow's events
2. Summarize key meetings: time, attendees, agenda
3. Update USER.md if you learn about recurring meetings

## Commands
feishu-cli calendar list --days 2
```

```markdown
# data/skills/skill-creator/SKILL.md
You are the Skill Creator — a meta-skill that creates new skills.

## Steps
1. Understand what the skill should do
2. Create directory: data/skills/{skill-name}/
3. Write SKILL.md with clear instructions
4. Test the skill by running it once

## Constraints
- Each skill: ONE clear purpose
- SKILL.md under 500 tokens
- Prefer shell commands over code
```

### 8.3 面试深挖 Q&A

**Round 1: Skill vs MCP 的区别？**

- Skill: Prompt-level，组合已有工具（shell, file, CLI），零代码
- MCP: Tool-level，定义全新 API 工具，需要编写 MCP server
- 90% 用 Skill（组合已有能力），10% 用 MCP（需要新原子能力）
- 社区名言："cronjob + skill = 就这么多"

**Round 2: skill-creator 怎么实现自我进化？**

- 机制：Agent 观察到重复模式 → 创建 SKILL.md → 固化为新能力
- 边界：只能创建 Skill（Markdown），不能修改核心代码
- 安全阀：首次执行后标记 trial，成功才变 stable，失败等待人类 review

**Round 3: Claude Code 怎么发现和加载 Skill？**

- 启动时扫描 `data/skills/*/SKILL.md`，注册到可用 skill 列表
- 运行时 LLM 语义匹配（不是 keyword match），选择最合适的 Skill
- 加载优先级：project > user > system

**Round 4: Skill 冲突和循环调用？**

- 冲突：LLM 语义理解选择最匹配的，在 SKILL.md 加 "When triggered" 条件
- 循环：`--max-turns` 限制，设计原则是 Skill 不互相调用
- MVP 控制 <10 个 Skill

**Round 5: Skill 测试和调试？**

- 直接 `claude -p "/feishu-calendar" --verbose` 执行
- 修改 SKILL.md → 重新执行 → 观察输出（改一行字的迭代速度）
- Git 追踪 Skill 演变历史

---

## 8. API 与 Web Dashboard

### 9.1 API 设计 (api.ts)

```typescript
// api.ts (~150 lines)
import { Hono } from "hono";
import { serveStatic } from "hono/bun";

export function registerRoutes(app: Hono) {
  // Sessions
  app.get("/api/sessions", async (c) => { /* list */ });
  app.get("/api/sessions/:id", async (c) => { /* detail */ });
  app.get("/api/sessions/:id/messages", async (c) => { /* JSONL parse */ });
  
  // Tasks
  app.get("/api/tasks", async (c) => { /* list */ });
  app.post("/api/tasks", async (c) => { /* create */ });
  app.patch("/api/tasks/:id", async (c) => { /* update */ });
  app.delete("/api/tasks/:id", async (c) => { /* delete */ });
  
  // Logs
  app.get("/api/logs", async (c) => { /* filtered list */ });
  
  // Memory
  app.get("/api/memory", async (c) => { /* SOUL + USER */ });
  app.get("/api/memory/recall", async (c) => { /* keyword search */ });
  
  // Static files
  app.use("/*", serveStatic({ root: "./web/dist" }));
}
```

### 9.2 数据库 Schema (db.ts)

```typescript
// db.ts (~100 lines)
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";

export const sessions = sqliteTable("sessions", {
  id: text("id").primaryKey(),
  threadId: text("thread_id").notNull(),
  userId: text("user_id").notNull(),
  status: text("status").notNull().default("idle"),
  messageCount: integer("message_count").notNull().default(0),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
});

export const tasks = sqliteTable("tasks", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  cronExpr: text("cron_expr"),
  prompt: text("prompt").notNull(),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  lastRun: integer("last_run", { mode: "timestamp" }),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
});

export const logs = sqliteTable("logs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  level: text("level").notNull(),
  source: text("source").notNull(),
  message: text("message").notNull(),
  metadata: text("metadata"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
});

const sqlite = new Database("./data/openclaw.db");
sqlite.exec("PRAGMA journal_mode = WAL;");
export const db = drizzle(sqlite);
```

### 9.3 Web Dashboard

4 个页面：Sessions / Session Detail / Scheduler / Logs

技术栈：React 19 + Vite + Tailwind CSS v4 + TanStack Router + TanStack Query

### 9.4 面试深挖 Q&A

**Round 1: 为什么不用 WebSocket 推送 Dashboard 更新？**

- Dashboard 低频查看，TanStack Query `refetchInterval: 5000` 足够
- WebSocket 需要额外 ~180 行代码（连接管理、重连、消息解析）
- 未来升级用 SSE（Server-Sent Events），Hono 原生支持，~20 行代码

**Round 2: SQLite 并发读写？**

- WAL 模式：写入先到 WAL 文件，读取不阻塞
- 同时只有一个写入者，写入等待 <1ms
- MVP 每秒最多几次写入，远低于 SQLite 瓶颈（~10000 writes/sec）

**Round 3: 为什么 Hono serveStatic 不用 Nginx？**

- 一个端口同时服务 API + 静态文件，零配置
- Bun 文件服务性能 ~50K RPS，1 个用户远远足够
- 需要 HTTPS 时用 Caddy（auto HTTPS，比 Nginx 配置简单）

**Round 4: TanStack Router vs React Router v7？**

- 类型安全：路由参数、search params 完整 TS 推断
- 与 TanStack Query 同作者，API 风格一致
- React Router v7 framework mode 太重，library mode 类型安全不足

**Round 5: API 安全性？**

- MVP: 只监听 `127.0.0.1`，SSH 隧道访问
- 未来：Bearer Token（10 行）→ Basic Auth（15 行）→ Feishu OAuth2.0（100 行）
- 静态文件无敏感数据，不需认证；API 层控制敏感数据访问
