/**
 * OpenCode 工具 Agent v3.0 — 免费模型驱动的轻量任务执行器
 *
 * 入口文件，从子模块转发所有导出。子模块位于 opencode-tools/。
 */

import { spawn } from "bun";
import {
  OpenCodeToolAgent,
  OPENCODE_FREE_MODELS,
  type ExecutionStrategy,
  type OpenCodeToolResult,
} from "./opencode-tools/index.js";

export {
  OPENCODE_FREE_MODELS,
  DEFAULT_OPEN_CODE_MODEL,
  OpenCodeToolAgent,
  type TaskType,
  type ExecutionStrategy,
  type OpenCodeToolResult,
} from "./opencode-tools/index.js";

let globalAgent: OpenCodeToolAgent | null = null;

export function getOpenCodeToolAgent(cwd?: string): OpenCodeToolAgent {
  if (!globalAgent) {
    globalAgent = new OpenCodeToolAgent(cwd);
  }
  return globalAgent;
}

export async function checkOpenCodeCli(): Promise<boolean> {
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

export async function getAvailableFreeModels(): Promise<string[]> {
  const available: string[] = [];
  for (const m of OPENCODE_FREE_MODELS) {
    available.push(m.id);
  }
  return available;
}

export async function quickExecute(
  prompt: string,
  options?: {
    strategy?: ExecutionStrategy;
    injectContext?: boolean;
    cwd?: string;
  }
): Promise<OpenCodeToolResult> {
  const agent = getOpenCodeToolAgent(options?.cwd);
  return agent.execute(prompt, options);
}
