# CCBuddy Architecture

## 消息处理流程

```
飞书用户消息
  ↓
feishu-ws.ts (WebSocket 长连接)
  ↓
index.ts onMessage
  ├─ /auth → feishu-auth.ts (OAuth Device Flow)
  ├─ /model, /cost, /help... → commands.ts (斜杠命令，直接回复卡片)
  └─ 普通消息 → runAgent()
       ↓
     agent.ts
       ├─ getOrCreateMeta() → SessionMeta (model, effort, cost, tokens)
       ├─ getClaudeSessionId() → --resume UUID (会话连续性)
       ├─ spawn CLAUDE_BIN (claude-wrapper.sh → preflight → claude CLI)
       │    --print --output-format stream-json --include-partial-messages
       │    --model opus --effort medium --verbose
       ↓
     stream-json 事件处理
       ├─ thinking_delta → card.setThinking() (懒创建卡片)
       ├─ text_delta → fullText += delta → card.pushContent() (智能 flush)
       ├─ rate_limit_event → meta.rateLimits (5h/7d reset 时间)
       ├─ result → cost, tokens, duration → recordUsage() (SQLite 持久化)
       └─ onEnd → card.complete(finalText, statusline)
```

## 文件职责

| 文件 | 职责 |
|------|------|
| `src/index.ts` | 启动入口，消息路由，连接各模块 |
| `src/agent.ts` | Claude CLI 进程管理，stream 解析，SessionMeta |
| `src/commands.ts` | 斜杠命令处理，statusline 构建，/model 交互卡片 |
| `src/feishu-ws.ts` | 飞书 WebSocket、StreamingCard、card action 回调 |
| `src/feishu-auth.ts` | OAuth Device Flow（lark-cli） |
| `src/usage.ts` | 持久化用量统计（SQLite） |
| `src/session.ts` | 会话管理（JSONL + SQLite） |
| `src/db.ts` | 数据库初始化 |
| `src/cron.ts` | Heartbeat 定时任务 |
| `scripts/claude-wrapper.sh` | 代理 preflight 检查（部署层） |

## 数据存储

| 数据 | 存储方式 | 生命周期 |
|------|---------|---------|
| SessionMeta (model, effort, cost, tokens) | 内存 Map | PM2 进程生命周期 |
| Claude Session UUID 映射 | 内存 Map | PM2 进程生命周期 |
| 会话元数据 | SQLite `sessions` 表 | 永久 |
| 消息历史 | JSONL 文件 | 永久 |
| 历史用量统计 | SQLite `usage_stats` 表 | 永久 |

## 流式卡片架构

```
StreamingCard 状态机:
  idle → (setThinking/pushContent) → creating → streaming → (complete/error) → done

懒创建：卡片在第一个 stream event 到达时才创建
  thinking_delta → 创建卡片 "💭 思考中..."
  text_delta → 创建卡片并带初始内容

智能 Flush (FlushController):
  条件1: 新增 ≥30 字符 且 距上次 ≥300ms → 立即 flush
  条件2: 有新内容但不够多 → 300ms 后保底 flush

三级降级:
  Level 0: CardKit streaming_mode + cardElement.content() — 原生打字机效果
  Level 1: CardKit card.update() — 全量 JSON 替换
  Level 2: im.message.patch — 旧版兼容
```

## 飞书卡片交互

```
/model 按钮点击流程:
  用户点击按钮
    ↓
  card.action.trigger 事件 (WebSocket)
    ↓
  feishu-ws.ts 路由: value.action → "model_select" / "effort_select"
    ↓
  commands.ts handler: setSessionModel/setSessionEffort + buildModelCard
    ↓
  回调返回: { card: { type: "raw", data: cardJson }, toast: { type: "success", content: "已切换" } }
    ↓
  飞书客户端: 卡片原地刷新 + toast 弹窗
```
