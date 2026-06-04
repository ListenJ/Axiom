/**
 * Dynamic Model Assigner — 基于评估结果的动态模型分配
 *
 * 功能:
 *   1. 消费 ModelEvalService 的评估结果
 *   2. 根据评分自动调整 UNIFIED_REGISTRY 中模型的优先级
 *   3. 自动将模型分配到最适合的角色
 *   4. 支持定时刷新，保持分配策略与最新基准同步
 *   5. 通过 model-capability-registry 的 EXTENSIONS 机制注入动态模型
 *
 * 架构: "三省六部制" — 隶属尚书省(ModelRouter)的智能分配子系统
 */

import { logger } from "../utils/logger.js";
import {
  UNIFIED_REGISTRY,
  type UnifiedModel,
  type TaskRole,
  type ModelProvider,
  PROVIDER_CONFIG,
} from "./models.js";
import {
  registerModel,
  type ModelCapability,
} from "./model-capability-registry.js";
import {
  getModelEvalService,
  type ModelEvalResult,
} from "../eval/model-eval-service.js";

// ========== 类型定义 ==========

export interface DynamicAssignment {
  modelId: string;
  provider: ModelProvider;
  model: string;
  assignedRoles: TaskRole[];
  evalScore: number;
  priority: number;
  reason: string;
  evaluatedAt: string;
}

export interface AssignmentConfig {
  /** 自动刷新间隔（毫秒），默认 6 小时 */
  refreshIntervalMs?: number;
  /** 最低总体评分阈值，低于此分数的模型不会被分配 */
  minScoreThreshold?: number;
  /** 是否为免费模型加分（优先使用免费模型） */
  preferFreeModels?: boolean;
  /** 是否启用自动分配（false 则只生成建议不实际执行） */
  autoApply?: boolean;
  /** 最大动态分配的模型数量 */
  maxDynamicModels?: number;
}

export interface AssignmentReport {
  timestamp: string;
  evaluatedModels: number;
  assignedModels: number;
  newAssignments: DynamicAssignment[];
  updatedPriorities: { modelId: string; oldPriority: number; newPriority: number }[];
  unassignedModels: { modelId: string; reason: string }[];
  recommendations: string[];
}

// ========== 常量 ==========

const DEFAULT_CONFIG: Required<AssignmentConfig> = {
  refreshIntervalMs: 6 * 3600 * 1000, // 6 hours
  minScoreThreshold: 40,
  preferFreeModels: true,
  autoApply: true,
  maxDynamicModels: 20,
};

// 角色匹配规则：基于模型评分维度推断最佳角色
const ROLE_SCORING: { role: TaskRole; weight: (s: ModelEvalResult["scores"], m: ModelEvalResult["metadata"]) => number }[] = [
  {
    role: "decision",
    weight: (s) => s.speed * 0.5 + s.cost * 0.3 + s.capability * 0.2,
  },
  {
    role: "architecture",
    weight: (s) => s.capability * 0.6 + s.safety * 0.2 + s.cost * 0.2,
  },
  {
    role: "code-generation",
    weight: (s, m) => {
      const codingBench = m.contextWindow >= 32000 ? 5 : 0;
      return s.capability * 0.7 + codingBench + s.cost * 0.2;
    },
  },
  {
    role: "code-review",
    weight: (s, m) => {
      const ctxBonus = m.contextWindow >= 128000 ? 10 : m.contextWindow >= 64000 ? 5 : 0;
      return s.capability * 0.5 + ctxBonus + s.safety * 0.3;
    },
  },
  {
    role: "research",
    weight: (s, m) => {
      const ctxBonus = m.contextWindow >= 128000 ? 10 : 0;
      return s.capability * 0.5 + ctxBonus + s.cost * 0.3;
    },
  },
  {
    role: "deep_research",
    weight: (s, m) => {
      const ctxBonus = m.contextWindow >= 128000 ? 15 : m.contextWindow >= 64000 ? 5 : 0;
      return s.capability * 0.6 + ctxBonus + s.safety * 0.2;
    },
  },
  {
    role: "general-chat",
    weight: (s) => s.speed * 0.4 + s.cost * 0.3 + s.capability * 0.3,
  },
  {
    role: "general-tool",
    weight: (s) => s.cost * 0.4 + s.speed * 0.3 + s.capability * 0.3,
  },
  {
    role: "evaluation",
    weight: (s) => s.capability * 0.5 + s.safety * 0.3 + s.cost * 0.2,
  },
  {
    role: "english",
    weight: (s) => s.capability * 0.4 + s.speed * 0.3 + s.cost * 0.3,
  },
  {
    role: "rl",
    weight: (s) => s.capability * 0.7 + s.safety * 0.2 + s.cost * 0.1,
  },
  {
    role: "coding",
    weight: (s) => s.capability * 0.6 + s.speed * 0.2 + s.cost * 0.2,
  },
  {
    role: "review",
    weight: (s, m) => {
      const ctxBonus = m.contextWindow >= 128000 ? 8 : 0;
      return s.capability * 0.5 + s.safety * 0.3 + ctxBonus;
    },
  },
  {
    role: "memory",
    weight: (s) => s.speed * 0.5 + s.cost * 0.3 + s.capability * 0.2,
  },
  {
    role: "math",
    weight: (s) => s.capability * 0.8 + s.safety * 0.1 + s.cost * 0.1,
  },
];

// ========== Provider 推断 ==========

function inferProvider(modelId: string, evalProvider: string): ModelProvider {
  // Map eval service provider names to our ModelProvider type
  const providerMap: Record<string, ModelProvider> = {
    deepseek: "deepseek",
    anthropic: "ofoxai-anthropic",
    openai: "ofoxai",
    google: "ofoxai-gemini",
    zhipu: "siliconflow",
    kimi: "kimi",
    minimax: "minimax",
    nousresearch: "openrouter",
    meta: "openrouter",
    qwen: "openrouter",
    mistral: "openrouter",
    other: "openrouter",
  };

  const lower = modelId.toLowerCase();
  if (lower.includes("deepseek")) return "deepseek";
  if (lower.includes("glm") || lower.includes("z-ai")) return "siliconflow";
  if (lower.includes("kimi") || lower.includes("moonshot")) return "kimi";
  if (lower.includes("minimax")) return "minimax";
  if (lower.includes("gpt-4o") || lower.includes("ofoxai")) return "ofoxai";
  if (lower.includes("gemini")) return "ofoxai-gemini";
  if (lower.includes("claude")) return "ofoxai-anthropic";

  return providerMap[evalProvider] || "openrouter";
}

// ========== 优先级计算 ==========

/**
 * 基于评估分数计算模型优先级
 * 分数越高 → 优先级数值越低（priority 1 最高）
 */
function computePriority(
  evalResult: ModelEvalResult,
  config: Required<AssignmentConfig>
): number {
  let priority: number;

  // Map overall score (0-100) to priority (1-10)
  // 90-100 → priority 1, 80-89 → 2, 70-79 → 3, etc.
  const score = evalResult.scores.overall;
  if (score >= 90) priority = 1;
  else if (score >= 80) priority = 2;
  else if (score >= 70) priority = 3;
  else if (score >= 60) priority = 4;
  else if (score >= 50) priority = 5;
  else if (score >= 40) priority = 6;
  else priority = 8;

  // Free model bonus: lower priority number for free models
  if (config.preferFreeModels && evalResult.metadata.isFree) {
    priority = Math.max(1, priority - 1);
  }

  return priority;
}

// ========== 角色分配逻辑 ==========

/**
 * 基于评估分数和角色匹配规则，为模型分配最佳角色
 */
function assignRoles(
  evalResult: ModelEvalResult,
  config: Required<AssignmentConfig>
): TaskRole[] {
  const roles: TaskRole[] = [];

  // Score each role
  const roleScores = ROLE_SCORING.map(({ role, weight }) => ({
    role,
    score: weight(evalResult.scores, evalResult.metadata),
  }));

  // Sort by score descending
  roleScores.sort((a, b) => b.score - a.score);

  // Assign top roles (threshold: score > 50)
  const THRESHOLD = 50;
  for (const { role, score } of roleScores) {
    if (score >= THRESHOLD && roles.length < 4) {
      roles.push(role);
    }
  }

  // Always add roles from eval recommendation if present
  if (evalResult.recommendation?.bestRoles) {
    for (const rec of evalResult.recommendation.bestRoles) {
      if (!roles.includes(rec as TaskRole) && roles.length < 6) {
        roles.push(rec as TaskRole);
      }
    }
  }

  // Ensure at least one role
  if (roles.length === 0) {
    roles.push("general-tool");
  }

  return roles;
}

// ========== 主服务类 ==========

export class DynamicModelAssigner {
  private config: Required<AssignmentConfig>;
  private lastAssignment: AssignmentReport | null = null;
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private dynamicModels = new Map<string, DynamicAssignment>();

  constructor(config?: AssignmentConfig) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * 执行一次完整的模型评估与分配
   */
  async runAssignment(opts?: {
    forceRefresh?: boolean;
    includeBenchmarks?: boolean;
  }): Promise<AssignmentReport> {
    const startTime = performance.now();
    const evalService = getModelEvalService();

    // Step 1: Get latest evaluation results
    let evalResults = evalService.getLatestResults({ sinceDays: 1 });

    // If no recent results or force refresh, run evaluation
    if (evalResults.length === 0 || opts?.forceRefresh) {
      logger.info("[DynamicAssigner] Running evaluation...");
      evalResults = await evalService.runFullEvaluation({
        includeBenchmarks: opts?.includeBenchmarks,
      });
    }

    logger.info("[DynamicAssigner] Processing evaluations", { count: evalResults.length });

    // Step 2: Filter and score
    const newAssignments: DynamicAssignment[] = [];
    const updatedPriorities: AssignmentReport["updatedPriorities"] = [];
    const unassignedModels: AssignmentReport["unassignedModels"] = [];
    const recommendations: string[] = [];

    let assignedCount = 0;

    for (const evalResult of evalResults) {
      // Skip below threshold
      if (evalResult.scores.overall < this.config.minScoreThreshold) {
        unassignedModels.push({
          modelId: evalResult.modelId,
          reason: `Score ${evalResult.scores.overall} below threshold ${this.config.minScoreThreshold}`,
        });
        continue;
      }

      // Limit dynamic models
      if (assignedCount >= this.config.maxDynamicModels) {
        unassignedModels.push({
          modelId: evalResult.modelId,
          reason: "Max dynamic models reached",
        });
        continue;
      }

      // Compute priority and roles
      const priority = computePriority(evalResult, this.config);
      const roles = assignRoles(evalResult, this.config);
      const provider = inferProvider(evalResult.modelId, evalResult.provider);

      // Check if model already exists in UNIFIED_REGISTRY
      const existingModel = UNIFIED_REGISTRY.find(m =>
        m.model === evalResult.modelId ||
        m.id === evalResult.modelId.split("/").pop() ||
        m.model.includes(evalResult.modelId.split("/").pop() || "")
      );

      if (existingModel) {
        // Update priority if changed significantly
        const oldPriority = existingModel.priority ?? 99;
        if (Math.abs(oldPriority - priority) >= 2) {
          // Don't mutate the static registry directly
          // Instead, register as a dynamic extension
          updatedPriorities.push({
            modelId: evalResult.modelId,
            oldPriority,
            newPriority: priority,
          });
        }
      }

      // Build dynamic assignment
      const assignment: DynamicAssignment = {
        modelId: evalResult.modelId,
        provider,
        model: evalResult.modelId, // OpenRouter model ID is the API name
        assignedRoles: roles,
        evalScore: evalResult.scores.overall,
        priority,
        reason: this.buildReason(evalResult, roles, priority),
        evaluatedAt: evalResult.evaluatedAt,
      };

      newAssignments.push(assignment);
      this.dynamicModels.set(evalResult.modelId, assignment);

      // Step 3: Register in capability registry if autoApply
      if (this.config.autoApply) {
        this.registerDynamicModel(assignment, evalResult);
        assignedCount++;
      }
    }

    // Generate recommendations
    recommendations.push(...this.generateRecommendations(evalResults, newAssignments));

    const report: AssignmentReport = {
      timestamp: new Date().toISOString(),
      evaluatedModels: evalResults.length,
      assignedModels: assignedCount,
      newAssignments,
      updatedPriorities,
      unassignedModels,
      recommendations,
    };

    this.lastAssignment = report;

    const elapsed = Math.round(performance.now() - startTime);
    logger.info("[DynamicAssigner] Assignment complete", {
      evaluated: evalResults.length,
      assigned: assignedCount,
      elapsedMs: elapsed,
    });

    return report;
  }

  /**
   * 将动态模型注册到 model-capability-registry 的 EXTENSIONS
   */
  private registerDynamicModel(
    assignment: DynamicAssignment,
    evalResult: ModelEvalResult
  ): void {
    const capability: ModelCapability = {
      id: `dynamic_${assignment.modelId.replace(/[^a-zA-Z0-9_-]/g, "_")}`,
      provider: assignment.provider,
      model: assignment.model,
      roles: assignment.assignedRoles,
      contextWindow: evalResult.metadata.contextWindow,
      tags: [
        "dynamic",
        evalResult.metadata.isFree ? "free" : "paid",
        `score:${evalResult.scores.overall}`,
      ],
      priority: assignment.priority,
      timeout: 60000,
    };

    try {
      registerModel(capability);
    } catch (err) {
      logger.warn("[DynamicAssigner] Failed to register dynamic model", {
        model: assignment.modelId,
        error: (err as Error).message,
      });
    }
  }

  /**
   * 获取特定角色的最佳动态模型
   */
  getBestForRole(role: TaskRole): DynamicAssignment | null {
    const candidates = Array.from(this.dynamicModels.values())
      .filter(a => a.assignedRoles.includes(role))
      .sort((a, b) => a.priority - b.priority);

    return candidates[0] || null;
  }

  /**
   * 获取所有动态分配的模型
   */
  getAllAssignments(): DynamicAssignment[] {
    return Array.from(this.dynamicModels.values());
  }

  /**
   * 获取上次分配报告
   */
  getLastReport(): AssignmentReport | null {
    return this.lastAssignment;
  }

  /**
   * 启动定时自动刷新
   */
  startAutoRefresh(): void {
    if (this.refreshTimer) return;

    this.refreshTimer = setInterval(async () => {
      try {
        logger.info("[DynamicAssigner] Auto-refresh triggered");
        await this.runAssignment({ forceRefresh: true, includeBenchmarks: true });
      } catch (err) {
        logger.error("[DynamicAssigner] Auto-refresh failed", err as Error);
      }
    }, this.config.refreshIntervalMs);

    logger.info("[DynamicAssigner] Auto-refresh started", {
      intervalMs: this.config.refreshIntervalMs,
    });
  }

  /**
   * 停止定时刷新
   */
  stopAutoRefresh(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
      logger.info("[DynamicAssigner] Auto-refresh stopped");
    }
  }

  // ========== 内部辅助 ==========

  private buildReason(
    evalResult: ModelEvalResult,
    roles: TaskRole[],
    priority: number
  ): string {
    const parts: string[] = [];
    parts.push(`Overall: ${evalResult.scores.overall}/100`);
    parts.push(`Cap: ${evalResult.scores.capability}`);
    parts.push(`Speed: ${evalResult.scores.speed}`);
    parts.push(`Cost: ${evalResult.scores.cost}`);
    parts.push(`Roles: ${roles.join(", ")}`);
    parts.push(`Priority: ${priority}`);
    if (evalResult.metadata.isFree) parts.push("[FREE]");
    return parts.join(" | ");
  }

  private generateRecommendations(
    evalResults: ModelEvalResult[],
    assignments: DynamicAssignment[]
  ): string[] {
    const recs: string[] = [];

    // Find best model per role
    const roleBest = new Map<TaskRole, { modelId: string; score: number }>();
    for (const a of assignments) {
      for (const role of a.assignedRoles) {
        const current = roleBest.get(role);
        if (!current || a.evalScore > current.score) {
          roleBest.set(role, { modelId: a.modelId, score: a.evalScore });
        }
      }
    }

    for (const [role, best] of roleBest) {
      recs.push(`Best for ${role}: ${best.modelId} (score: ${best.score})`);
    }

    // Find best value models (high score + low cost)
    const valueModels = evalResults
      .filter(r => r.scores.overall >= 70 && r.metadata.isFree)
      .sort((a, b) => b.scores.overall - a.scores.overall)
      .slice(0, 3);

    if (valueModels.length > 0) {
      recs.push(`Best free models: ${valueModels.map(m => m.modelId).join(", ")}`);
    }

    // Warn about models that performed poorly
    const poor = evalResults.filter(r => r.scores.overall < 40).slice(0, 3);
    for (const m of poor) {
      recs.push(`Warning: ${m.modelId} scored poorly (${m.scores.overall}/100) — consider removing`);
    }

    return recs;
  }
}

// ========== 全局单例 ==========

let _instance: DynamicModelAssigner | null = null;

export function getDynamicModelAssigner(config?: AssignmentConfig): DynamicModelAssigner {
  if (!_instance) {
    _instance = new DynamicModelAssigner(config);
  }
  return _instance;
}
