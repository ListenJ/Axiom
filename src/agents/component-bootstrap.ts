import { getComponentKernel, type ComponentKernel } from "../components/kernel.js";
import {
  registerNativeAgents,
  type NativeAgentOptions,
  type NativeCodeToolchain,
  type NativeExecutor,
  type NativePromptProvider,
} from "../components/native-agents.js";
import { tokenBudget } from "../components/token-budget.js";
import type { AgentTask } from "../components/contracts.js";
import { internalAgent } from "./internal-agent.js";
import { getPromptPool, type AgentRole } from "./prompt-pool.js";
import { piCodeEngine } from "../pi-agent/pi-code-engine.js";
import type { TaskRole } from "../services/index.js";

const PROMPT_ROLES: Record<string, AgentRole> = {
  "general-chat": "general_chat",
  "general-tool": "tool_use",
  planning: "decision",
  decision: "decision",
  "code-generation": "main_coding",
  "code-review": "code_review",
  refactoring: "main_coding",
  testing: "main_coding",
  research: "research",
  "deep-research": "research",
  architecture: "architecture",
};

const promptFor: NativePromptProvider = (task: AgentTask) => {
  const role = PROMPT_ROLES[task.type] ?? "general_chat";
  return getPromptPool().acquire(role, {
    task_description: task.description,
    context: task.context ? JSON.stringify(task.context) : undefined,
  }).systemPrompt;
};

const executor: NativeExecutor = async (role, messages, options) => {
  return internalAgent.executeWithRole(role as TaskRole, messages, {
    temperature: options?.temperature,
    maxTokens: options?.maxTokens,
    excludeModels: options?.excludeModels,
  });
};

const codeToolchain: NativeCodeToolchain = {
  available: async () => true,
  run: async (type, input) => {
    try {
      const asToolData = (data: unknown): Record<string, unknown> =>
        data as unknown as Record<string, unknown>;
      switch (type) {
        case "code-generation":
          return {
            success: true,
            data: asToolData(await piCodeEngine.executeCodeGenerate({
              prompt: String(input.prompt ?? ""),
              language: input.language as string | undefined,
              context: input.context as string | undefined,
              model: input.model as string | undefined,
            })),
          };
        case "code-review":
          return {
            success: true,
            data: asToolData(await piCodeEngine.executeCodeReview({
              code: String(input.code ?? ""),
              language: input.language as string | undefined,
              context: input.context as string | undefined,
            })),
          };
        case "refactoring":
          return {
            success: true,
            data: asToolData(await piCodeEngine.executeCodeRefactor({
              code: String(input.code ?? ""),
              description: String(input.description ?? ""),
              language: input.language as string | undefined,
            })),
          };
        case "testing":
          return {
            success: true,
            data: asToolData(await piCodeEngine.executeCodeTest({
              code: String(input.code ?? ""),
              language: input.language as string | undefined,
              framework: input.framework as string | undefined,
            })),
          };
        default:
          return {
            success: false,
            error: `Unsupported code toolchain type: ${type}`,
          };
      }
    } catch (e) {
      return {
        success: false,
        error: e instanceof Error ? e.message : String(e),
      };
    }
  },
};

export function createNativeAgentOptions(
  opts: { includeCodeToolchain?: boolean } = {},
): NativeAgentOptions {
  const base: NativeAgentOptions = {
    executor,
    promptFor,
    tokenBudget,
  };
  return opts.includeCodeToolchain === false
    ? base
    : { ...base, codeToolchain };
}

export async function initializeComponentKernel(): Promise<ComponentKernel> {
  const kernel = getComponentKernel();
  if (!kernel.get("token-budget")) kernel.register(tokenBudget);
  if (!kernel.get("native-general")) {
    registerNativeAgents(kernel, createNativeAgentOptions());
  }
  await kernel.initAll();
  return kernel;
}
