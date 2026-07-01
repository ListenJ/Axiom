/**
 * 免费工具模型池 (Tool Model Pool)
 * 管理免费模型的限流、配额、健康状态和负载均衡
 *
 * 免费模型限制（来自 OpenRouter 文档）:
 *   - 速率限制: 通常 1-10 RPM (requests per minute)
 *   - 并发限制: 通常 1-2 并发请求
 *   - 每日配额: 有限制，超过后返回 429
 *
 * 策略:
 *   1. 每模型独立 RateLimitedSemaphore (concurrency + RPM 双闸门, O(1))
 *   2. 健康检查（连续失败自动降级）
 *   3. 评分选择（成功率 × 空闲率 × RPM余量）
 *   4. 熔断器（连续失败 N 次后暂停使用）
 *
 * Phase B.2b migration notes:
 *   - Replaced manual `activeRequests` counter + `lastMinuteRequests[]`
 *     sliding window with a per-model `RateLimitedSemaphore` (one per
 *     model in TOOL_MODEL_REGISTRY). All O(1) admission checks, no
 *     filter() scanning on every query.
 *   - `markRequestStart/Success/Failure` use the semaphore's sync
 *     `tryAcquire/tryRelease` so the public API stays synchronous —
 *     callers in this codebase fire-and-forget these calls without
 *     awaiting. `tryAcquire` returning false (model at capacity) now
 *     surfaces as `droppedStarts` in getStats(), which the old code
 *     silently ignored by blindly incrementing.
 *   - Circuit breaker, latency history, totals — all unchanged.
 */
import { logger } from "../utils/logger.js";
import { listFreeModels, type TaskRole } from "./models.js";
import { RateLimitedSemaphore } from "../utils/concurrency/rate-limited-semaphore.js";

export interface ToolModel {
  id: string;                 // 模型完整 ID，如 "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free"
  provider: string;           // 提供商，通常是 "openrouter"
  role: ToolRole;             // 角色分类
  rpmLimit: number;           // 每分钟请求限制
  concurrentLimit: number;    // 并发请求限制
  description: string;
}

export type ToolRole =
  | "coding"        // 编码任务
  | "english"       // 英文处理
  | "rl"            // 强化学习 / 推理
  | "general-tool"  // 通用工具
  | "evaluation";   // 评估（付费但有额度限制）

const TOOL_ROLES: ToolRole[] = ["coding", "english", "rl", "general-tool", "evaluation"];

/** Build tool registry from unified model registry */
function buildToolRegistry(): ToolModel[] {
  const freeModels = listFreeModels();
  const tools: ToolModel[] = [];
  for (const um of freeModels) {
    for (const role of um.roles) {
      if (TOOL_ROLES.includes(role as ToolRole)) {
        tools.push({
          id: um.model,
          provider: um.provider,
          role: role as ToolRole,
          rpmLimit: um.rpmLimit ?? 60,
          concurrentLimit: um.concurrentLimit ?? 2,
          description: um.description ?? "",
        });
      }
    }
  }
  return tools;
}

/** 免费工具模型注册表 — 从统一注册表生成 */
const TOOL_MODEL_REGISTRY: ToolModel[] = buildToolRegistry();

/** Per-model runtime state — everything except concurrency/RPM, which now lives in the semaphore. */
interface ModelRuntimeState {
  /** Rolling-window RPM semaphore. Owns active concurrency + rate limit state. */
  sem: RateLimitedSemaphore;
  consecutiveFailures: number;
  circuitOpen: boolean;
  circuitOpenUntil: number;
  totalCalls: number;
  totalFailures: number;
  /** Number of markRequestStart calls that were dropped because the semaphore was full. */
  droppedStarts: number;
  latencyHistory: number[];
  lastSuccessAt: number;
}

export class ToolModelPool {
  private states = new Map<string, ModelRuntimeState>();

  constructor() {
    for (const m of TOOL_MODEL_REGISTRY) {
      this.states.set(m.id, {
        sem: new RateLimitedSemaphore({
          permits: m.concurrentLimit,
          rpm: m.rpmLimit,
          windowMs: 60_000,
        }),
        consecutiveFailures: 0,
        circuitOpen: false,
        circuitOpenUntil: 0,
        totalCalls: 0,
        totalFailures: 0,
        droppedStarts: 0,
        latencyHistory: [],
        lastSuccessAt: 0,
      });
    }
  }

  /** 获取某角色的可用模型列表（已过滤掉熔断和超限的） */
  getAvailableModels(role: ToolRole): ToolModel[] {
    const now = Date.now();
    return TOOL_MODEL_REGISTRY.filter((m) => {
      if (m.role !== role) return false;
      const state = this.states.get(m.id)!;

      // 检查熔断器
      if (state.circuitOpen) {
        if (now < state.circuitOpenUntil) return false;
        // 熔断器恢复
        state.circuitOpen = false;
        state.consecutiveFailures = 0;
      }

      // Concurrency check (O(1) via semaphore)
      if (state.sem.active >= state.sem.permits) return false;
      // RPM check (O(1) via ring buffer)
      if (state.sem.availableRpm <= 0) return false;

      return true;
    });
  }

  /** 智能评分选择最佳可用模型（替代 round-robin） */
  selectNext(role: ToolRole, options?: { allowBorrow?: boolean }): ToolModel | null {
    const available = this.getAvailableModels(role);
    if (available.length > 0) {
      return this.selectBest(available);
    }

    // 跨角色借用：本角色无可用时，从其他角色借
    if (options?.allowBorrow !== false) {
      const borrowed = this.borrowModel(role);
      if (borrowed) {
        logger.info(`[ToolPool] Borrowed model ${borrowed.id} from ${borrowed.role} for ${role}`);
        return borrowed;
      }
    }

    return null;
  }

  /** 评分算法：成功率 × 空闲率 × RPM余量
   *  核心原则：优先选成功率高、负载低、RPM余量充足的模型
   */
  private selectBest(models: ToolModel[]): ToolModel {
    let best = models[0];
    let bestScore = -1;

    for (const m of models) {
      const state = this.states.get(m.id)!;

      // 成功率：历史调用越成功越好（无历史记录默认为1）
      const successRate = state.totalCalls > 0
        ? 1 - state.totalFailures / state.totalCalls
        : 1;

      // 空闲率：当前并发越少越好
      const idleRatio = 1 - state.sem.active / state.sem.permits;

      // RPM余量：剩余速率限制越多越好
      const rpmRatio = state.sem.availableRpm / state.sem.rpm;

      // 简单延迟惩罚：平均延迟>5秒则扣分
      const avgLatency = state.latencyHistory.length > 0
        ? state.latencyHistory.reduce((a, b) => a + b, 0) / state.latencyHistory.length
        : 0;
      const latencyFactor = avgLatency > 5000 ? 0.8 : 1;

      const score = successRate * idleRatio * rpmRatio * latencyFactor;
      if (score > bestScore) {
        bestScore = score;
        best = m;
      }
    }
    return best;
  }

  /** 跨角色借用：从 general-tool / coding 等角色借可用模型 */
  private borrowModel(targetRole: ToolRole): ToolModel | null {
    // 借用优先级：general-tool → coding → english → rl → evaluation
    const borrowOrder: ToolRole[] = [
      "general-tool", "coding", "english", "rl", "evaluation"
    ];
    for (const srcRole of borrowOrder) {
      if (srcRole === targetRole) continue;
      const available = this.getAvailableModels(srcRole);
      if (available.length > 0) {
        return this.selectBest(available);
      }
    }
    return null;
  }

  /**
   * 标记请求开始. 如果模型当前已满（concurrency 或 RPM 都满），
   * tryAcquire 返回 false，droppedStarts++ 让运维可以监控。
   */
  markRequestStart(modelId: string): void {
    const state = this.states.get(modelId);
    if (!state) return;
    if (!state.sem.tryAcquire()) {
      state.droppedStarts++;
      return;
    }
    state.totalCalls++;
  }

  /** 标记请求成功（可传入延迟） */
  markRequestSuccess(modelId: string, latencyMs?: number): void {
    const state = this.states.get(modelId);
    if (!state) return;
    state.sem.tryRelease();
    state.consecutiveFailures = 0;
    state.lastSuccessAt = Date.now();
    if (latencyMs !== undefined && latencyMs > 0) {
      state.latencyHistory.push(latencyMs);
      if (state.latencyHistory.length > 10) state.latencyHistory.shift();
    }
  }

  /** 记录请求延迟（用于异步追踪） */
  recordLatency(modelId: string, latencyMs: number): void {
    const state = this.states.get(modelId);
    if (!state) return;
    if (latencyMs > 0) {
      state.latencyHistory.push(latencyMs);
      if (state.latencyHistory.length > 10) state.latencyHistory.shift();
    }
  }

  /** 标记请求失败 */
  markRequestFailure(modelId: string, error?: string): void {
    const state = this.states.get(modelId);
    if (!state) return;
    state.sem.tryRelease();
    state.consecutiveFailures++;
    state.totalFailures++;

    // 熔断逻辑：连续 3 次失败，熔断 60 秒
    if (state.consecutiveFailures >= 3) {
      state.circuitOpen = true;
      state.circuitOpenUntil = Date.now() + 60000;
      logger.warn(`[ToolPool] Circuit breaker OPEN for ${modelId} (3 consecutive failures)`, {
        error,
        resumeAt: new Date(state.circuitOpenUntil).toISOString(),
      });
    }
  }

  /** 获取池状态报告 */
  getStats(): Record<string, unknown> {
    const stats: Record<string, unknown> = {};
    for (const m of TOOL_MODEL_REGISTRY) {
      const state = this.states.get(m.id)!;
      const avgLatency = state.latencyHistory.length > 0
        ? Math.round(state.latencyHistory.reduce((a, b) => a + b, 0) / state.latencyHistory.length)
        : 0;
      stats[m.id] = {
        role: m.role,
        activeRequests: state.sem.active,
        rpmThisMinute: state.sem.currentRpm,
        rpmLimit: m.rpmLimit,
        droppedStarts: state.droppedStarts,
        consecutiveFailures: state.consecutiveFailures,
        circuitOpen: state.circuitOpen,
        totalCalls: state.totalCalls,
        totalFailures: state.totalFailures,
        avgLatencyMs: avgLatency,
        lastSuccessAt: state.lastSuccessAt > 0 ? new Date(state.lastSuccessAt).toISOString() : null,
        health: state.circuitOpen ? "🔴熔断" : state.consecutiveFailures > 0 ? "🟡告警" : "🟢健康",
      };
    }
    return stats;
  }

  /** 全局健康状态传播 — 成功率 / 延迟 / RPM 余量 */
  getGlobalHealth(): {
    overallSuccessRate: number;
    overallAvgLatency: number;
    totalActiveRequests: number;
    totalRpmHeadroom: number;
    roleHealth: Record<ToolRole, { available: number; total: number; successRate: number; avgLatency: number }>;
  } {
    const roleHealth: Record<string, { available: number; total: number; successRate: number; avgLatency: number }> = {};
    let totalSuccess = 0;
    let totalCalls = 0;
    let totalLatency = 0;
    let latencyCount = 0;
    let totalActive = 0;
    let totalRpmHeadroom = 0;

    for (const m of TOOL_MODEL_REGISTRY) {
      const state = this.states.get(m.id)!;
      totalSuccess += state.totalCalls - state.totalFailures;
      totalCalls += state.totalCalls;
      totalActive += state.sem.active;
      totalRpmHeadroom += state.sem.availableRpm;

      if (state.latencyHistory.length > 0) {
        totalLatency += state.latencyHistory.reduce((a, b) => a + b, 0);
        latencyCount += state.latencyHistory.length;
      }

      if (!roleHealth[m.role]) {
        roleHealth[m.role] = { available: 0, total: 0, successRate: 0, avgLatency: 0 };
      }
      roleHealth[m.role].total++;
      if (!state.circuitOpen && state.sem.active < state.sem.permits && state.sem.availableRpm > 0) {
        roleHealth[m.role].available++;
      }
    }

    // 计算每个角色的成功率与平均延迟
    for (const role of Object.keys(roleHealth)) {
      const models = TOOL_MODEL_REGISTRY.filter((m) => m.role === role);
      let roleCalls = 0;
      let roleSuccess = 0;
      let roleLatency = 0;
      let roleLatencyCount = 0;
      for (const m of models) {
        const state = this.states.get(m.id)!;
        roleCalls += state.totalCalls;
        roleSuccess += state.totalCalls - state.totalFailures;
        if (state.latencyHistory.length > 0) {
          roleLatency += state.latencyHistory.reduce((a, b) => a + b, 0);
          roleLatencyCount += state.latencyHistory.length;
        }
      }
      roleHealth[role].successRate = roleCalls > 0 ? roleSuccess / roleCalls : 1;
      roleHealth[role].avgLatency = roleLatencyCount > 0 ? Math.round(roleLatency / roleLatencyCount) : 0;
    }

    return {
      overallSuccessRate: totalCalls > 0 ? totalSuccess / totalCalls : 1,
      overallAvgLatency: totalCalls > 0 ? Math.round(totalLatency / latencyCount) : 0,
      totalActiveRequests: totalActive,
      totalRpmHeadroom: totalRpmHeadroom,
      roleHealth: roleHealth as Record<ToolRole, { available: number; total: number; successRate: number; avgLatency: number }>,
    };
  }

  /** 列出所有注册模型 */
  listModels(): ToolModel[] {
    return [...TOOL_MODEL_REGISTRY];
  }
}

export const toolPool = new ToolModelPool();