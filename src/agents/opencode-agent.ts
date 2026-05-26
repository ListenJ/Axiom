/**
 * OpenCode Agent 集成模块 v1.1
 * OpenCode 是交互式 TUI 编码 Agent，本模块提供快捷启动和状态查询
 * 支持免费模型: opencode/deepseek-v4-flash-free, opencode/big-pickle, opencode/nemotron-3-super-free
 *
 * 所有 API Key 通过环境变量注入，本模块不包含任何密钥
 */
import { spawn } from "bun";
import { logger } from "../utils/logger.js";

/** 免费模型列表（按推荐度排序） */
export const OPENCODE_FREE_MODELS = [
  "opencode/deepseek-v4-flash-free",
  "opencode/big-pickle",
  "opencode/nemotron-3-super-free",
];

/** 默认编码模型（免费） */
export const DEFAULT_CODE_MODEL = process.env.OPENCODE_DEFAULT_MODEL || OPENCODE_FREE_MODELS[0];

/** 检测 opencode 是否可用 */
export async function checkOpenCode(): Promise<boolean> {
  try {
    const proc = spawn({
      cmd: ["opencode", "--version"],
      stdout: "pipe",
      stderr: "pipe",
    });
    const exitCode = await proc.exited;
    return exitCode === 0;
  } catch {
    return false;
  }
}

/** 启动 OpenCode 交互式编码会话（直接连接用户终端） */
export function openCodeSession(options?: {
  cwd?: string;
  model?: string;
  prompt?: string;
}): Promise<number> {
  return new Promise((resolve, reject) => {
    const model = options?.model || DEFAULT_CODE_MODEL;
    const cwd = options?.cwd || process.cwd();

    const args = ["run", "--model", model];
    if (options?.prompt) {
      args.push(options.prompt);
    }

    logger.info("[OpenCode] Starting interactive session", { model, cwd });

    const proc = spawn({
      cmd: ["opencode", ...args],
      stdout: "inherit",
      stderr: "inherit",
      stdin: "inherit",
      cwd,
      env: { ...process.env },
    });

    proc.exited.then(resolve).catch(reject);
  });
}

/** 启动 OpenCode 后台服务 */
export function startOpenCodeServer(options?: {
  cwd?: string;
  port?: number;
}): { stop: () => void; port: number } {
  const cwd = options?.cwd || process.cwd();
  const port = options?.port || 0; // 0 = random port

  logger.info("[OpenCode] Starting headless server", { cwd, port });

  const proc = spawn({
    cmd: ["opencode", "serve", "--port", String(port)],
    stdout: "inherit",
    stderr: "inherit",
    cwd,
    env: { ...process.env },
  });

  return {
    stop: () => {
      try { proc.kill(); } catch {}
    },
    port,
  };
}

/** 列出 OpenCode 可用模型 */
export async function listOpenCodeModels(): Promise<string[]> {
  try {
    const proc = spawn({
      cmd: ["opencode", "models"],
      stdout: "pipe",
      stderr: "pipe",
    });
    const textDecoder = new TextDecoder();
    let output = "";
    const reader = proc.stdout.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      output += textDecoder.decode(value, { stream: true });
    }
    await proc.exited;
    return output.split("\n").map((l) => l.trim()).filter((l) => l.length > 0 && !l.startsWith("["));
  } catch {
    return OPENCODE_FREE_MODELS;
  }
}

/** 获取 OpenCode 安装引导 */
export function getOpenCodeInstallGuide(): string {
  return `
OpenCode CLI 未安装。安装方式（选择一种）：

1. 官方脚本（推荐）:
   curl -fsSL https://opencode.ai/install.sh | bash

2. npm 安装:
   npm install -g opencode

3. 直接下载:
   https://github.com/opencode-ai/opencode/releases

安装后运行 opencode --version 验证。
`;
}
