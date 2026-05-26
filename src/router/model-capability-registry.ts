/**
 * 模型能力注册表 (Model Capability Registry)
 *
 * 将模型与其能力、成本、任务角色进行解耦注册，
 * 支持运行时动态查询最佳模型分配。
 *
 * 任务角色矩阵:
 *   - decision      决策/分解 (Claude Code + DeepSeek Pro)
 *   - research      研究/架构 (Hermes + Qwen + GLM)
 *   - memory        记忆/编排 (DeepSeek Flash)
 *   - coding        编码/项目管理 (Qwen3 + Kimi Code)
 *   - rl            强化学习 (Trinity Large Thinking)
 *   - deep_research 深度研究 (Hermes 405B + SiliconFlow)
 *   - math          数学推理 (DeepSeek V4 Pro)
 *   - review        架构审查 (GLM 5.1)
 *   - main_coding   主力编码 (Kimi K2.6)
 */

import { logger } from "../utils/logger.js";

export type TaskRole =
  | "decision"
  | "research"
  | "memory"
  | "coding"
  | "rl"
  | "deep_research"
  | "math"
  | "review"
  | "main_coding"
  | string;

export type ModelProvider =
  | "openrouter"
  | "deepseek"
  | "siliconflow"
  | "ofexai"
  | "kimi"
  | "opencode"
  | "claude_code"
  | string;

export interface ModelCapability {
  /** 模型唯一标识 */
  id: string;
  /** 提供商 */
  provider: ModelProvider;
  /** 模型名称（API 调用时使用） */
  model: string;
  /** 支持的任务角色（按优先级排序） */
  roles: TaskRole[];
  /** 上下文窗口大小 */
  contextWindow: number;
  /** 输入价格 ($/M tokens) */
  inputPrice: number;
  /** 输出价格 ($/M tokens) */
  outputPrice: number;
  /** RPM 限制 */
  rpmLimit: number;
  /** 并发限制 */
  concurrencyLimit: number;
  /** 是否为免费模型 */
  isFree: boolean;
  /** 是否需要特殊适配器 */
  adapter?: "claude_code" | "kimi_code";
  /** 模型特性标签 */
  tags: string[];
}

export interface AssignmentResult {
  role: TaskRole;
  model: ModelCapability;
  fallbackChain: ModelCapability[];
  estimatedCost: number;
  reason: string;
}

// ========== 模型能力注册表 ==========

const REGISTRY: Map<string, ModelCapability> = new Map();

/**
 * 注册内置模型能力表
 */
function registerBuiltinModels(): void {
  const models: ModelCapability[] = [
    // === 决策层 ===
    {
      id: "claude-code",
      provider: "claude_code",
      model: "claude-sonnet-4-20250514",
      roles: ["decision", "review"],
      contextWindow: 200_000,
      inputPrice: 3.0,
      outputPrice: 15.0,
      rpmLimit: 50,
      concurrencyLimit: 5,
      isFree: false,
      adapter: "claude_code",
      tags: ["reasoning", "long-context", "agentic"],
    },
    {
      id: "deepseek-v4-pro",
      provider: "deepseek",
      model: "deepseek-v4-pro",
      roles: ["decision", "math", "memory"],
      contextWindow: 1_000_000,
      inputPrice: 0.435,
      outputPrice: 1.74,
      rpmLimit: 30,
      concurrencyLimit: 10,
      isFree: false,
      tags: ["reasoning", "chinese", "long-context"],
    },

    // === 研究/架构层 ===
    {
      id: "hermes-3-405b",
      provider: "openrouter",
      model: "nousresearch/hermes-3-llama-3.1-405b:free",
      roles: ["research", "deep_research"],
      contextWindow: 131_072,
      inputPrice: 0,
      outputPrice: 0,
      rpmLimit: 3,
      concurrencyLimit: 1,
      isFree: true,
      tags: ["reasoning", "agentic"],
    },
    {
      id: "qwen3-coder-free",
      provider: "openrouter",
      model: "qwen/qwen3-coder:free",
      roles: ["coding", "research"],
      contextWindow: 262_144,
      inputPrice: 0,
      outputPrice: 0,
      rpmLimit: 20,
      concurrencyLimit: 2,
      isFree: true,
      tags: ["coding", "chinese"],
    },
    {
      id: "glm-5.1",
      provider: "ofexai",
      model: "glm-5.1",
      roles: ["review", "research"],
      contextWindow: 128_000,
      inputPrice: 0.5,
      outputPrice: 1.0,
      rpmLimit: 20,
      concurrencyLimit: 5,
      isFree: false,
      tags: ["chinese", "reasoning"],
    },

    // === 记忆/编排 ===
    {
      id: "deepseek-v4-flash",
      provider: "deepseek",
      model: "deepseek-v4-flash",
      roles: ["memory", "coding"],
      contextWindow: 1_000_000,
      inputPrice: 0.14,
      outputPrice: 0.56,
      rpmLimit: 50,
      concurrencyLimit: 15,
      isFree: false,
      tags: ["fast", "chinese", "long-context"],
    },

    // === 编码层 ===
    {
      id: "kimi-for-coding",
      provider: "kimi",
      model: "kimi-for-coding",
      roles: ["coding", "main_coding"],
      contextWindow: 262_144,
      inputPrice: 0.5,
      outputPrice: 2.0,
      rpmLimit: 30,
      concurrencyLimit: 5,
      isFree: false,
      adapter: "kimi_code",
      tags: ["coding", "chinese", "agentic"],
    },
    {
      id: "kimi-k2.6",
      provider: "openrouter",
      model: "moonshotai/kimi-k2.6",
      roles: ["main_coding", "coding"],
      contextWindow: 256_000,
      inputPrice: 0.5,
      outputPrice: 2.0,
      rpmLimit: 30,
      concurrencyLimit: 5,
      isFree: false,
      tags: ["coding", "chinese", "long-context"],
    },
    {
      id: "kimi-k2.6-free",
      provider: "openrouter",
      model: "moonshotai/kimi-k2.6:free",
      roles: ["coding"],
      contextWindow: 256_000,
      inputPrice: 0,
      outputPrice: 0,
      rpmLimit: 5,
      concurrencyLimit: 1,
      isFree: true,
      tags: ["coding", "chinese"],
    },

    // === RL ===
    {
      id: "trinity-large-thinking",
      provider: "openrouter",
      model: "arcee-ai/trinity-large-thinking:free",
      roles: ["rl"],
      contextWindow: 262_144,
      inputPrice: 0,
      outputPrice: 0,
      rpmLimit: 3,
      concurrencyLimit: 1,
      isFree: true,
      tags: ["rl", "reasoning"],
    },

    // === 深度研究 ===
    {
      id: "qwen3.6-27b-silicon",
      provider: "siliconflow",
      model: "Qwen/Qwen3.6-27B-Instruct",
      roles: ["deep_research", "research"],
      contextWindow: 128_000,
      inputPrice: 0.3,
      outputPrice: 0.6,
      rpmLimit: 20,
      concurrencyLimit: 5,
      isFree: false,
      tags: ["reasoning", "chinese"],
    },

    // === 通用/备用 ===
    {
      id: "glm-4.7-flash-free",
      provider: "ofexai",
      model: "z-ai/glm-4.7-flash:free",
      roles: ["memory", "coding"],
      contextWindow: 128_000,
      inputPrice: 0,
      outputPrice: 0,
      rpmLimit: 20,
      concurrencyLimit: 2,
      isFree: true,
      tags: ["fast", "chinese"],
    },
    {
      id: "deepseek-v4-flash-free",
      provider: "openrouter",
      model: "deepseek/deepseek-v4-flash:free",
      roles: ["memory", "coding"],
      contextWindow: 1_000_000,
      inputPrice: 0,
      outputPrice: 0,
      rpmLimit: 10,
      concurrencyLimit: 1,
      isFree: true,
      tags: ["fast", "chinese", "long-context"],
    },
  ];

  for (const m of models) {
    REGISTRY.set(m.id, m);
  }

  logger.info(`[CapabilityRegistry] Registered ${models.length} built-in models`);
}

// 初始化
registerBuiltinModels();

// ========== 查询接口 ==========

/**
 * 根据任务角色查找最佳模型
 */
export function findModelsForRole(role: TaskRole, opts?: {
  preferFree?: boolean;
  minContextWindow?: number;
  excludeAdapters?: boolean;
}): ModelCapability[] {
  const results: ModelCapability[] = [];

  for (const model of REGISTRY.values()) {
    if (!model.roles.includes(role)) continue;
    if (opts?.minContextWindow && model.contextWindow < opts.minContextWindow) continue;
    if (opts?.excludeAdapters && model.adapter) continue;

    results.push(model);
  }

  // 排序：付费优先（更稳定），然后按角色优先级
  results.sort((a, b) => {
    if (opts?.preferFree) {
      if (a.isFree !== b.isFree) return a.isFree ? -1 : 1;
    } else {
      if (a.isFree !== b.isFree) return a.isFree ? 1 : -1;
    }
    const aIdx = a.roles.indexOf(role);
    const bIdx = b.roles.indexOf(role);
    return aIdx - bIdx;
  });

  return results;
}

/**
 * 获取指定模型的 fallback 链（同角色其他模型）
 */
export function getFallbackChain(modelId: string, role: TaskRole): ModelCapability[] {
  const primary = REGISTRY.get(modelId);
  if (!primary) return [];

  const alternatives = findModelsForRole(role);
  return alternatives.filter((m) => m.id !== modelId);
}

/**
 * 智能任务分配：根据角色、预算、优先级返回最佳模型 + fallback 链
 */
export function assignModel(
  role: TaskRole,
  opts?: {
    budgetLimit?: number;
    preferFree?: boolean;
    requireAdapter?: "claude_code" | "kimi_code";
    estimatedTokens?: number;
  }
): AssignmentResult | null {
  const candidates = findModelsForRole(role, {
    preferFree: opts?.preferFree,
    excludeAdapters: !opts?.requireAdapter,
  });

  if (candidates.length === 0) {
    logger.warn(`[CapabilityRegistry] No model found for role: ${role}`);
    return null;
  }

  // 预算过滤
  let viable = candidates;
  if (opts?.budgetLimit && opts.estimatedTokens) {
    const estimatedCost = (opts.estimatedTokens / 1_000_000) * (candidates[0].inputPrice + candidates[0].outputPrice);
    if (estimatedCost > opts.budgetLimit) {
      // 尝试找更便宜的
      viable = candidates.filter((m) => {
        const cost = (opts.estimatedTokens! / 1_000_000) * (m.inputPrice + m.outputPrice);
        return cost <= opts.budgetLimit!;
      });
      if (viable.length === 0) viable = candidates; // 预算不足时仍返回最便宜的
    }
  }

  const primary = viable[0];
  const fallbacks = getFallbackChain(primary.id, role);

  const estimatedCost = opts?.estimatedTokens
    ? (opts.estimatedTokens / 1_000_000) * (primary.inputPrice + primary.outputPrice)
    : 0;

  const reason = `${primary.id} (${primary.provider}) → ${primary.roles.indexOf(role) === 0 ? "primary" : "secondary"} role match, ${primary.contextWindow.toLocaleString()} ctx, $${primary.inputPrice}/M in`;

  return {
    role,
    model: primary,
    fallbackChain: fallbacks.slice(0, 3),
    estimatedCost,
    reason,
  };
}

/**
 * 批量分配多个任务角色
 */
export function assignBatch(roles: TaskRole[], opts?: {
  budgetLimit?: number;
  preferFree?: boolean;
}): Map<TaskRole, AssignmentResult> {
  const results = new Map<TaskRole, AssignmentResult>();
  let remainingBudget = opts?.budgetLimit ?? Infinity;

  for (const role of roles) {
    const assignment = assignModel(role, {
      ...opts,
      budgetLimit: remainingBudget,
    });

    if (assignment) {
      remainingBudget -= assignment.estimatedCost;
      results.set(role, assignment);
    }
  }

  return results;
}

/**
 * 获取所有已注册模型
 */
export function listAllModels(): ModelCapability[] {
  return Array.from(REGISTRY.values());
}

/**
 * 获取指定模型
 */
export function getModel(id: string): ModelCapability | undefined {
  return REGISTRY.get(id);
}

/**
 * 动态注册模型（支持运行时扩展）
 */
export function registerModel(capability: ModelCapability): void {
  REGISTRY.set(capability.id, capability);
  logger.info(`[CapabilityRegistry] Registered model: ${capability.id} (${capability.provider})`);
}

/**
 * 获取所有支持的任务角色
 */
export function listAllRoles(): TaskRole[] {
  const roles = new Set<TaskRole>();
  for (const model of REGISTRY.values()) {
    for (const role of model.roles) {
      roles.add(role);
    }
  }
  return Array.from(roles);
}
