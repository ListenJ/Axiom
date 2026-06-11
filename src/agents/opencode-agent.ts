/**
 * OpenCode Agent 集成模块 v2.0
 * 
 * 重要变更：代码编写功能已迁移至 Pi Agent 引擎
 * - Pi Agent 使用本地工具（read/grep/find/ls）检索代码上下文，零 token 消耗
 * - LLM 只接收精简上下文，节省 60-80% tokens
 * - 本模块保留 OpenCode CLI 交互和状态查询功能
 */
import { spawn } from "bun";
import { logger } from "../utils/logger.js";
import { retrieveCodeMemory } from "../memory/codegraph-index.js";
import { getGlobalVault } from "../memory/vault-manager.js";
import { getMemoryGate, type SignificanceContext } from "../memory/memory-gate.js";
import {
  piCodeEngine,
  type CodeGenerateResult,
  type CodeRefactorResult,
  type CodeReviewResult,
  type CodeTestResult,
} from "../pi-agent/pi-code-engine.js";

/** 检测任务是否涉及代码 */
function isCodeTask(prompt: string): boolean {
  const codeKeywords = /\b(function|class|const|let|var|import|export|async|await|=>|\.ts|\.js|\.tsx|\.jsx|\.py|\.go|\.rs|bug|fix|refactor|implement|code|编码|函数|类|修复|重构|实现)\b/i;
  return codeKeywords.test(prompt);
}

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

/**
 * 运行 OpenCode 编码任务，自动注入 CodeGraph 代码上下文
 * @deprecated 建议使用 runWithPiAgent 替代，可节省 60-80% tokens
 */
export async function runWithCodeContext(options: {
  prompt: string;
  cwd?: string;
  model?: string;
  codeContext?: boolean;
}): Promise<{ command: string[]; enhancedPrompt: string; injectedContext: string }> {
  const prompt = options.prompt;
  let enhancedPrompt = prompt;
  let injectedContext = "";

  // 自动检测是否需要代码上下文
  const needsCode = options.codeContext !== false && isCodeTask(prompt);

  if (needsCode) {
    logger.info("[OpenCode] CodeGraph context injection triggered", { prompt: prompt.slice(0, 80) });
    const memory = await retrieveCodeMemory(prompt, { limit: 8, includeContext: true });
    if (memory && memory.source === "codegraph" && memory.results) {
      injectedContext = memory.results;
      enhancedPrompt = `## 项目代码上下文 (来自 CodeGraph 索引)\n\n${injectedContext}\n\n---\n\n## 任务\n\n${prompt}`;
      logger.info("[OpenCode] CodeGraph context injected", {
        symbols: memory.symbols.length,
        contextLength: injectedContext.length,
      });
    } else {
      logger.warn("[OpenCode] CodeGraph not available, running without context");
    }
  }

  const model = options.model || DEFAULT_CODE_MODEL;
  const cwd = options.cwd || process.cwd();

  return {
    command: ["opencode", "run", "--model", model, enhancedPrompt],
    enhancedPrompt,
    injectedContext,
  };
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

// ========== Pi Agent 代码编写引擎代理 ==========

/**
 * 使用 Pi Agent 引擎执行代码生成
 * 
 * 相比传统方式：
 * - 使用 Pi Agent 本地工具检索代码上下文（零 token）
 * - LLM 只接收精简上下文
 * - 节省 60-80% tokens
 */
export async function executeCodeGenerate(options: {
  prompt: string;
  language?: string;
  context?: string;
  model?: string;
}): Promise<CodeGenerateResult> {
  logger.info("[OpenCodeAgent] Delegating code generation to Pi Agent engine");
  return piCodeEngine.executeCodeGenerate(options);
}

/**
 * 使用 Pi Agent 引擎执行代码重构
 */
export async function executeCodeRefactor(options: {
  code: string;
  description: string;
  language?: string;
}): Promise<CodeRefactorResult> {
  logger.info("[OpenCodeAgent] Delegating code refactor to Pi Agent engine");
  return piCodeEngine.executeCodeRefactor(options);
}

/**
 * 使用 Pi Agent 引擎执行代码审查
 */
export async function executeCodeReview(options: {
  code: string;
  language?: string;
  context?: string;
}): Promise<CodeReviewResult> {
  logger.info("[OpenCodeAgent] Delegating code review to Pi Agent engine");
  return piCodeEngine.executeCodeReview(options);
}

/**
 * 使用 Pi Agent 引擎执行测试生成
 */
export async function executeCodeTest(options: {
  code: string;
  language?: string;
  framework?: string;
}): Promise<CodeTestResult> {
  logger.info("[OpenCodeAgent] Delegating test generation to Pi Agent engine");
  return piCodeEngine.executeCodeTest(options);
}

// ═══════════════════════════════════════════════════════════════
// OpenCode 工具 Agent v3.0 兼容层
// ═══════════════════════════════════════════════════════════════

/**
 * 使用 OpenCode 工具 Agent 执行轻量任务（叠加所有优化）
 *
 * 自动：
 *   - 评估任务复杂度
 *   - Pi Agent 本地工具预处理（零 token）
 *   - CodeGraph 上下文注入
 *   - 免费模型轮询 + circuit breaker
 *   - 优雅降级（失败回退 OpenClaw）
 *   - Token 节省追踪
 *   - 黑板优先 (Blackboard-First)
 *   - 读取优化管道 (ReadOptimizerFacade)
 *   - 字段投影 (列裁剪)
 */
export {
  OpenCodeToolAgent,
  getOpenCodeToolAgent,
  quickExecute,
  checkOpenCodeCli,
  getAvailableFreeModels,
  OPENCODE_FREE_MODELS as TOOL_AGENT_FREE_MODELS,
  type TaskType,
  type ExecutionStrategy,
  type OpenCodeToolResult,
} from "./opencode-tool-agent.js";

// 重新导出黑板和读取优化（供上层使用）
export {
  getGlobalBlackboard,
  writeFact,
  readFact,
  readOrCompute,
  type BlackboardEntry,
  type ReadOptions,
  type ReadResult,
  type WriteOptions,
} from "../memory/blackboard.js";

export {
  getReadOptimizer,
  type ReadRequest,
  type ReadResponse,
  type Interceptor,
} from "../utils/read-optimizer.js";

export {
  initializeReadOptimizers,
  isReadOptimizerInitialized,
} from "../utils/read-optimizer-init.js";

// 重新导出类型，保持向后兼容
export type { CodeGenerateResult, CodeRefactorResult, CodeReviewResult, CodeTestResult };
