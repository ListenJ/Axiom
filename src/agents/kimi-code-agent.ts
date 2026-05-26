/**
 * Kimi Code 集成模块 v1.0
 *
 * Kimi Code 是 Kimi 会员权益中专为开发者提供的智能编程服务。
 * 本模块提供两种使用方式：
 *   1. API 直连: 通过 OpenAI 兼容协议调用 Kimi Code API (推荐)
 *   2. CLI 调用: 若用户已安装 kimi CLI，可启动交互式会话
 *
 * 认证方式:
 *   - OAuth 自动认证: 运行 `kimi /login` (官方 CLI)
 *   - API Key: 在 Kimi Code 控制台创建，配置到 KIMI_CODE_API_KEY
 *
 * 服务地址: https://api.kimi.com/coding/v1 (OpenAI 兼容)
 * 模型 ID:  kimi-for-coding
 */
import { spawn } from "bun";
import { logger } from "../utils/logger.js";

export const KIMI_CODE_MODEL = "kimi-for-coding";
export const KIMI_CODE_BASE_URL = "https://api.kimi.com/coding/v1";

/** 检测 Kimi Code API Key 是否已配置 */
export function checkKimiCodeApiKey(): boolean {
  return !!process.env.KIMI_CODE_API_KEY;
}

/** 检测 kimi CLI 是否已安装 */
export async function checkKimiCli(): Promise<boolean> {
  try {
    const proc = spawn({
      cmd: ["kimi", "--version"],
      stdout: "pipe",
      stderr: "pipe",
    });
    const exitCode = await proc.exited;
    return exitCode === 0;
  } catch {
    return false;
  }
}

/** 调用 Kimi Code API (OpenAI 兼容协议) */
export async function kimiCodeChat(options: {
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
  temperature?: number;
  timeout?: number;
}): Promise<{
  content: string | null;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}> {
  const apiKey = process.env.KIMI_CODE_API_KEY;
  if (!apiKey) {
    throw new Error("KIMI_CODE_API_KEY 未配置。请在 .env 中设置 KIMI_CODE_API_KEY，或运行 kimi /login 完成 OAuth 登录。");
  }

  const baseURL = process.env.KIMI_CODE_BASE_URL || KIMI_CODE_BASE_URL;
  const timeout = options.timeout || 60000;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    const res = await fetch(`${baseURL}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: KIMI_CODE_MODEL,
        messages: options.messages,
        temperature: options.temperature ?? 0.7,
      }),
      signal: controller.signal,
    });

    clearTimeout(timer);

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Kimi Code API HTTP ${res.status}: ${errText}`);
    }

    const data = await res.json();
    return {
      content: data.choices?.[0]?.message?.content ?? null,
      usage: data.usage,
    };
  } catch (e: any) {
    clearTimeout(timer);
    if (e.name === "AbortError") {
      throw new Error("Kimi Code API 请求超时");
    }
    throw e;
  }
}

/** 启动 kimi CLI 交互式编码会话 */
export function startKimiCliSession(options?: {
  cwd?: string;
  prompt?: string;
}): Promise<number> {
  return new Promise((resolve, reject) => {
    const cwd = options?.cwd || process.cwd();
    const args: string[] = [];
    if (options?.prompt) {
      args.push(options.prompt);
    }

    logger.info("[KimiCode] Starting CLI session", { cwd });

    const proc = spawn({
      cmd: ["kimi", ...args],
      stdout: "inherit",
      stderr: "inherit",
      stdin: "inherit",
      cwd,
      env: { ...process.env },
    });

    proc.exited.then(resolve).catch(reject);
  });
}

/** 获取 Kimi Code 安装与登录指南 */
export function getKimiCodeGuide(): string {
  return `
🦅 Kimi Code 安装与配置指南

Kimi Code 是 Kimi 会员权益中的智能编程服务，基于 Kimi 最新旗舰模型。

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
1. 安装 Kimi Code CLI
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

# macOS / Linux:
curl -LsSf https://code.kimi.com/install.sh | bash

# Windows (PowerShell):
Invoke-RestMethod https://code.kimi.com/install.ps1 | Invoke-Expression

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
2. 登录认证
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

方式 A — OAuth 自动登录 (推荐，官方 CLI):
  kimi /login

方式 B — API Key (第三方工具 / 自建应用):
  1. 访问 Kimi Code 控制台创建 API Key
  2. 在 .env 文件中配置:
     KIMI_CODE_API_KEY=your-api-key

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
3. 使用方式
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

直接调用 API (无需安装 CLI):
  bun run src/cli.ts kimi:chat "写一个 TypeScript HTTP 服务器"

启动交互式 CLI 会话 (需安装 CLI):
  bun run src/cli.ts kimi:open

查看状态:
  bun run src/cli.ts kimi:status

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
4. 注意事项
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

• Kimi Code 与 Kimi 会员计划共享额度
• 额度每 7 天自动刷新，未用完不累积
• 每 5 小时有滚动频率窗口限制
• 请勿篡改 User-Agent，可能导致权益暂停
• 模型 ID 固定为 "kimi-for-coding"，后端自动升级
`;
}
