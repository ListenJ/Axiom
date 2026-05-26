/**
 * Hermes Agent 集成模块 v1.0
 * 通过子进程调用 hermes CLI 执行项目管理、深度研究等任务
 * Hermes 支持 MCP，可连接 OpenClaw 的 MCP Server 共享记忆
 *
 * 所有 API Key 通过环境变量注入，本模块不包含任何密钥
 */
import { spawn } from "bun";
import { statSync } from "fs";
import { logger } from "../utils/logger.js";

export interface HermesTask {
  /** 任务描述 */
  prompt: string;
  /** 工作目录 */
  cwd?: string;
  /** 模型名称 */
  model?: string;
  /** 是否使用 Docker 后端（更安全） */
  docker?: boolean;
  /** 超时时间（毫秒） */
  timeoutMs?: number;
  /** 附加环境变量 */
  env?: Record<string, string>;
}

export interface HermesResult {
  success: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
  model?: string;
}

/** Hermes 可执行文件路径探测 */
function getHermesCommand(): string[] {
  const candidates = [
    "hermes",
    ".venv/Scripts/hermes",
    ".venv/Scripts/hermes.exe",
    ".venv/bin/hermes",
  ];
  for (const c of candidates) {
    try {
      const stat = statSync(c);
      if (stat.isFile()) return [c];
    } catch {}
  }
  return ["hermes"];
}

/** 检测 Hermes 是否已安装 */
export async function checkHermes(): Promise<boolean> {
  try {
    const proc = spawn({
      cmd: [...getHermesCommand(), "--version"],
      stdout: "pipe",
      stderr: "pipe",
    });
    const exitCode = await proc.exited;
    return exitCode === 0;
  } catch {
    return false;
  }
}

/** 获取 Hermes 安装引导信息 */
export function getHermesInstallGuide(): string {
  return `
Hermes Agent 未安装。安装方式（选择一种）：

1. 一键安装（推荐）:
   curl -fsSL https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh | bash

2. Docker 部署:
   docker run -d --name hermes \
     -e OPENROUTER_API_KEY=\${OPENROUTER_API_KEY} \
     -v ~/.hermes:/root/.hermes \
     nousresearch/hermes-agent

3. pip 安装:
   pip install hermes-agent

安装后运行 hermes doctor 检查配置。
`;
}

/** 检测终端环境是否兼容 Hermes */
function checkHermesTerminal(): { ok: boolean; reason?: string } {
  // Git Bash / MSYS / Cygwin 环境下 prompt_toolkit 会报错
  const term = process.env.TERM || "";
  const msys = process.env.MSYSTEM || "";
  if (term.includes("xterm") && msys) {
    return {
      ok: false,
      reason: "Hermes 在当前终端 (Git Bash / MSYS) 中有兼容性问题。请在 Windows PowerShell 或 cmd.exe 中运行：\n\n  hermes chat -q \"你的问题\"\n\n或配置 Hermes MCP 服务器在后台运行。",
    };
  }
  return { ok: true };
}

/** 运行 Hermes 任务 */
export async function runHermesTask(task: HermesTask): Promise<HermesResult> {
  const available = await checkHermes();
  if (!available) {
    return {
      success: false,
      stdout: "",
      stderr: getHermesInstallGuide(),
      exitCode: 127,
    };
  }

  const termCheck = checkHermesTerminal();
  if (!termCheck.ok) {
    return {
      success: false,
      stdout: "",
      stderr: termCheck.reason || "Terminal not compatible with Hermes",
      exitCode: 126,
    };
  }

  const cwd = task.cwd || process.cwd();
  const timeoutMs = task.timeoutMs || 600_000; // 默认 10 分钟（研究任务可能较长）

  const args = ["chat", "-q", task.prompt, "-Q"];
  if (task.model) {
    args.push("--model", task.model);
  }

  logger.info("[Hermes] Starting task", { cwd, promptPreview: task.prompt.slice(0, 100) });

  const hermesCmd = getHermesCommand()[0];
  const proc = spawn({
    cmd: [hermesCmd, ...args],
    stdout: "pipe",
    stderr: "pipe",
    cwd,
    env: {
      ...process.env,
      OPENAI_API_KEY: process.env.OPENAI_API_KEY || process.env.DEEPSEEK_API_KEY,
      ...task.env,
    },
  });

  const timer = setTimeout(() => {
    try { proc.kill(); } catch {}
    logger.warn("[Hermes] Task timed out", { timeoutMs });
  }, timeoutMs);

  let stdout = "";
  let stderr = "";
  const textDecoder = new TextDecoder();

  const reader = proc.stdout.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      stdout += textDecoder.decode(value, { stream: true });
    }
  } catch (e: any) {
    logger.warn("[Hermes] stdout read error", { error: e.message });
  }

  const errReader = proc.stderr.getReader();
  try {
    while (true) {
      const { done, value } = await errReader.read();
      if (done) break;
      stderr += textDecoder.decode(value, { stream: true });
    }
  } catch (e: any) {
    logger.warn("[Hermes] stderr read error", { error: e.message });
  }

  const exitCode = await proc.exited;
  clearTimeout(timer);

  const success = exitCode === 0;
  logger.info("[Hermes] Task finished", { success, exitCode, stdoutLength: stdout.length });

  return {
    success,
    stdout: stdout.slice(0, 50_000),
    stderr: stderr.slice(0, 10_000),
    exitCode,
  };
}

/** 项目管理：创建任务计划 */
export async function planProject(description: string, cwd?: string): Promise<HermesResult> {
  return runHermesTask({
    prompt: `作为项目管理助手，请为以下项目创建详细的任务计划，包括里程碑、依赖关系和风险评估。使用 Markdown 格式输出：\n\n${description}`,
    cwd,
    timeoutMs: 300_000,
  });
}

/** 深度研究 */
export async function deepResearch(topic: string, cwd?: string): Promise<HermesResult> {
  return runHermesTask({
    prompt: `对以下主题进行深度研究，搜索网络资料，整理关键发现、数据来源和结论。将研究结果保存为结构化文档：\n\n${topic}`,
    cwd,
    timeoutMs: 600_000,
  });
}

/** 代码审查（Hermes 模式，侧重架构和安全） */
export async function architectureReview(projectPath?: string, cwd?: string): Promise<HermesResult> {
  const target = projectPath || ".";
  return runHermesTask({
    prompt: `审查 ${target} 项目的整体架构。评估：1) 技术栈选型合理性 2) 模块依赖关系 3) 安全漏洞 4) 可扩展性 5) 是否符合最佳实践。输出详细报告。`,
    cwd,
    timeoutMs: 600_000,
  });
}

/** 生成 MCP 配置以连接 OpenClaw */
export function generateHermesMcpConfig(): string {
  return `
# 在 ~/.hermes/config.yaml 中添加以下内容，使 Hermes 可以访问 OpenClaw 的 MCP 工具

mcp_servers:
  openclaw:
    command: "bun"
    args: ["run", "src/mcp/server.ts", "--stdio"]
    env:
      DATABASE_PATH: "${process.env.DATABASE_PATH || "./data/agent.db"}"
      OBSIDIAN_VAULT_PATH: "${process.env.OBSIDIAN_VAULT_PATH || "./openclaw-memory"}"
`;
}
