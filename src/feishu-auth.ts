/**
 * Feishu OAuth via lark-cli Device Flow
 *
 * Flow:
 *   1. User sends "/auth" or "授权"
 *   2. Bot runs `lark-cli auth login --no-wait --domain all --json`
 *   3. Bot sends card with "点击授权" button → verification_url
 *   4. Background: `lark-cli auth login --device-code xxx` polls until authorized
 *   5. On success, bot notifies user
 */
import { spawn } from "child_process";
import { getLarkClient } from "./feishu-ws";

const ALL_SCOPES = [
  "calendar:calendar.event:read",
  "calendar:calendar.event:write",
  "task:task:read",
  "task:task:write",
  "contact:user.base:readonly",
  "im:message:readonly",
  "im:message",
  "docs:document:readonly",
  "docx:document:readonly",
  "wiki:node:read",
  "wiki:wiki:readonly",
  "drive:drive.metadata:readonly",
  "sheets:spreadsheet:readonly",
].join(" ");

export function isAuthCommand(text: string): boolean {
  const t = text.trim().toLowerCase();
  return t === "/auth" || t === "授权" || t === "auth" || t === "/授权";
}

export async function handleAuth(messageId: string, chatId: string): Promise<void> {
  const client = getLarkClient();
  if (!client) return;

  console.log("[auth] Starting device flow...");

  // Step 1: Get verification URL via --no-wait
  const deviceInfo = await runLarkCliNoWait();
  if (!deviceInfo) {
    await sendTextReply(messageId, "❌ 授权初始化失败，请稍后重试");
    return;
  }

  console.log(`[auth] Verification URL: ${deviceInfo.verificationUrl}`);

  // Step 2: Send card with auth button
  const card = buildAuthCard(deviceInfo.verificationUrl);
  try {
    await client.im.message.reply({
      path: { message_id: messageId },
      data: {
        msg_type: "interactive",
        content: JSON.stringify(card),
      },
    });
  } catch (err) {
    console.error("[auth] Failed to send auth card:", err);
    return;
  }

  // Step 3: Background poll — fire and forget, only notify on SUCCESS
  pollDeviceCode(deviceInfo.deviceCode).then(async (success) => {
    if (success) {
      try {
        const successCard = buildResultCard(true, "✅ 授权成功！CCBuddy 现在可以访问你的日历、任务、文档等飞书数据了。");
        await client.im.v1.message.create({
          params: { receive_id_type: "chat_id" },
          data: {
            receive_id: chatId,
            msg_type: "interactive",
            content: JSON.stringify(successCard),
          },
        });
      } catch (err) {
        console.error("[auth] Failed to send success message:", err);
      }
      console.log("[auth] Authorization completed!");
    } else {
      // Silent — don't bother user with timeout messages
      console.log("[auth] Poll ended without confirmation (silent)");
    }
  }).catch((err) => {
    console.error("[auth] Poll error (silent):", err);
  });
}

// ── lark-cli Device Flow ────────────────────────────

interface DeviceInfo {
  deviceCode: string;
  verificationUrl: string;
  expiresIn: number;
}

function runLarkCliNoWait(): Promise<DeviceInfo | null> {
  return new Promise((resolve) => {
    const proc = spawn("lark-cli", [
      "auth", "login",
      "--no-wait",
      "--domain", "all",
      "--json",
    ], { stdio: ["pipe", "pipe", "pipe"] });

    let stdout = "";
    proc.stdout.on("data", (d) => { stdout += d.toString(); });
    proc.stderr.on("data", (d) => { console.debug("[auth:stderr]", d.toString()); });

    proc.on("close", (code) => {
      if (code !== 0) {
        console.error("[auth] lark-cli --no-wait failed, exit code:", code);
        resolve(null);
        return;
      }
      try {
        const data = JSON.parse(stdout.trim());
        resolve({
          deviceCode: data.device_code,
          verificationUrl: data.verification_url,
          expiresIn: data.expires_in || 600,
        });
      } catch {
        console.error("[auth] Failed to parse lark-cli output:", stdout);
        resolve(null);
      }
    });
  });
}

function pollDeviceCode(deviceCode: string): Promise<boolean> {
  return new Promise((resolve) => {
    const proc = spawn("lark-cli", [
      "auth", "login",
      "--device-code", deviceCode,
    ], { stdio: ["pipe", "pipe", "pipe"] });

    let stderr = "";
    proc.stderr.on("data", (d) => { stderr += d.toString(); });

    // Timeout after 10 minutes
    const timeout = setTimeout(() => {
      proc.kill("SIGTERM");
      // Before reporting failure, check if auth actually succeeded
      checkAuthStatus().then(resolve);
    }, 10 * 60 * 1000);

    proc.on("close", (code) => {
      clearTimeout(timeout);
      if (code === 0) {
        resolve(true);
      } else {
        // Poll exited non-zero — still check if user authorized via another path
        checkAuthStatus().then(resolve);
      }
    });
  });
}

/** Check if lark-cli already has a valid token, regardless of poll result */
function checkAuthStatus(): Promise<boolean> {
  return new Promise((resolve) => {
    const proc = spawn("lark-cli", ["auth", "status", "--json"], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    proc.stdout.on("data", (d) => { stdout += d.toString(); });
    proc.on("close", () => {
      try {
        const data = JSON.parse(stdout);
        const hasToken = data.tokenStatus !== "expired" && data.scope;
        resolve(!!hasToken);
      } catch {
        resolve(false);
      }
    });
  });
}

// ── Card Builders ───────────────────────────────────

function buildAuthCard(verificationUrl: string): object {
  return {
    schema: "2.0",
    config: { wide_screen_mode: true },
    header: {
      title: { tag: "plain_text", content: "🔐 CCBuddy 权限授权" },
      template: "blue",
    },
    body: {
      elements: [
        {
          tag: "markdown",
          content: "CCBuddy 需要访问你的飞书数据来提供以下服务：\n\n" +
            "📅 **日历** — 查看日程、创建会议\n" +
            "✅ **任务** — 管理待办事项\n" +
            "📄 **文档** — 读取飞书文档和Wiki\n" +
            "👥 **通讯录** — 查找同事\n" +
            "💬 **消息** — 搜索聊天记录\n\n" +
            "点击下方按钮完成授权：",
        },
        {
          tag: "button",
          text: { tag: "plain_text", content: "🔑 点击授权" },
          type: "primary",
          multi_url: {
            url: verificationUrl,
            pc_url: verificationUrl,
            android_url: verificationUrl,
            ios_url: verificationUrl,
          },
        },
        {
          tag: "markdown",
          content: "⏳ 授权后 CCBuddy 会自动确认，无需其他操作。",
          text_size: "notation",
        },
      ],
    },
  };
}

function buildResultCard(success: boolean, message: string): object {
  return {
    schema: "2.0",
    config: { wide_screen_mode: true },
    header: {
      title: { tag: "plain_text", content: success ? "✅ 授权完成" : "❌ 授权失败" },
      template: success ? "green" : "red",
    },
    body: {
      elements: [
        { tag: "markdown", content: message },
      ],
    },
  };
}

async function sendTextReply(messageId: string, text: string): Promise<void> {
  const client = getLarkClient();
  if (!client) return;
  try {
    await client.im.message.reply({
      path: { message_id: messageId },
      data: { msg_type: "text", content: JSON.stringify({ text }) },
    });
  } catch (err) {
    console.error("[auth] Reply failed:", err);
  }
}
