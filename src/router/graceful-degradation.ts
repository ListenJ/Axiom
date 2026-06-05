/**
 * 优雅降级路由器 (Graceful Degradation Router)
 *
 * 实现模型降级和并行读取机制:
 *   - 当主模型失败/限流时，自动降级到更便宜的替代模型
 *   - 支持并行读取: 将任务分发给多个廉价模型并行执行
 *   - 结果聚合: 合并多个模型的输出，提高可靠性
 *   - 健康监控: 动态跟踪模型健康状态，调整降级路径
 *
 * 与 ToolModelPool 集成，复用 circuit breaker 和健康检查机制。
 */

import { logger } from "../utils/logger.js";
import { router, type ChatMessage, type SmartAssignmentResponse } from "./model-router.js";
import { toolPool, type ToolRole } from "./tool-pool.js";
import {
  findModelsForRole,
  getFallbackChain,
  listFreeModels,
  type TaskRole,
  type UnifiedModel,
} from "./models.js";
import { TIMEOUTS } from "../constants/timeouts.js";

// ═══════════════════════════════════════════════════════════════
// Type Definitions
// ═══════════════════════════════════════════════════════════════

export interface DegradationPath {
  primary: UnifiedModel;
  fallbacks: UnifiedModel[];
  estimatedCost: number;      // 相对成本估算
  estimatedQuality: number;   // 预期质量 0-1
  parallelEnabled: boolean;
}

export interface ParallelResult {
  results: SmartAssignmentResponse[];
  successCount: number;
  failureCount: number;
  aggregatedContent: string;
  modelUsed: string[];
  latencyMs: number;
}

export type AggregationStrategy =
  | "best"       // 选择最佳结果 (基于模型优先级)
  | "merge"      // 合并所有结果
  | "vote"       // 投票选择 (多数表决)
  | "fastest";   // 选择最快返回的结果

export interface DegradationOptions {
  maxRetries?: number;
  enableParallel?: boolean;
  parallelModels?: number;
  aggregationStrategy?: AggregationStrategy;
  timeoutMs?: number;
  preferFreeModels?: boolean;
}

// ═══════════════════════════════════════════════════════════════
// GracefulDegradationRouter 主类
// ═══════════════════════════════════════════════════════════════

export class GracefulDegradationRouter {
  private healthScores = new Map<string, { success: number; total: number; avgLatency: number }>();

  /**
   * 获取降级路径
   *
   * 基于角色和当前模型健康状态，构建最优的降级链。
   */
  getDegradationPath(role: TaskRole, options?: { preferFree?: boolean }): DegradationPath {
    const models = getFallbackChain(role);

    if (models.length === 0) {
      throw new Error(`No models available for role: ${role}`);
    }

    const primary = models[0];
    const fallbacks = models.slice(1);

    // 如果偏好免费模型，重新排序
    if (options?.preferFree) {
      const freeModels = models.filter((m) => m.isFree);
      const paidModels = models.filter((m) => !m.isFree);
      const sorted = [...freeModels, ...paidModels];
      return {
        primary: sorted[0],
        fallbacks: sorted.slice(1),
        estimatedCost: this.estimateCost(sorted[0]),
        estimatedQuality: this.estimateQuality(sorted[0]),
        parallelEnabled: freeModels.length >= 2,
      };
    }

    return {
      primary,
      fallbacks,
      estimatedCost: this.estimateCost(primary),
      estimatedQuality: this.estimateQuality(primary),
      parallelEnabled: models.length >= 2 && models.some((m) => m.isFree),
    };
  }

  /**
   * 执行带降级的单任务
   *
   * 依次尝试主模型和备用模型，直到成功或全部失败。
   */
  async executeWithFallback(
    role: TaskRole,
    messages: ChatMessage[],
    options: DegradationOptions = {}
  ): Promise<SmartAssignmentResponse> {
    const { maxRetries = 3, timeoutMs = TIMEOUTS.API_DEFAULT } = options;
    const path = this.getDegradationPath(role, { preferFree: options.preferFreeModels });

    const allModels = [path.primary, ...path.fallbacks];
    let lastError: Error | undefined;

    for (const model of allModels) {
      for (let attempt = 0; attempt < maxRetries; attempt++) {
        const startTime = Date.now();

        try {
          // 检查 circuit breaker
          if (this.isCircuitOpen(model.id)) {
            logger.warn("[Degradation] Circuit breaker open, skipping", { model: model.id });
            break; // 跳过此模型，尝试下一个
          }

          const response = await router.executeWithRole(role, messages, {
            temperature: 0.7,
            excludeModels: allModels.slice(0, allModels.indexOf(model)).map((m) => m.id),
          });

          const latencyMs = Date.now() - startTime;
          this.recordSuccess(model.id, latencyMs);

          logger.info("[Degradation] Request succeeded", {
            model: model.id,
            latency: latencyMs,
            attempt: attempt + 1,
          });

          return response;
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          lastError = error instanceof Error ? error : new Error(msg);

          this.recordFailure(model.id);
          logger.warn("[Degradation] Request failed", {
            model: model.id,
            attempt: attempt + 1,
            error: msg,
          });

          // 指数退避
          if (attempt < maxRetries - 1) {
            const delay = Math.min(1000 * Math.pow(2, attempt), 5000);
            await this.delay(delay);
          }
        }
      }
    }

    // 所有模型都失败
    logger.error("[Degradation] All models exhausted", lastError || new Error("All models exhausted"), { role });
    return {
      role,
      model: "degraded",
      provider: "local",
      endpoint: "",
      content: `[System] All models for role "${role}" are unavailable. Error: ${lastError?.message || "Unknown error"}`,
      latency_ms: 0,
      fallback_used: true,
    };
  }

  /**
   * 并行执行：分发任务到多个模型并行处理
   *
   * 适用于需要高可靠性或快速响应的场景。
   */
  async executeParallel(
    role: TaskRole,
    messages: ChatMessage[],
    options: DegradationOptions = {}
  ): Promise<ParallelResult> {
    const {
      parallelModels = 3,
      aggregationStrategy = "best",
      timeoutMs = TIMEOUTS.API_DEFAULT,
      preferFreeModels = true,
    } = options;

    const startTime = Date.now();

    // 选择并行模型
    const candidates = this.selectParallelModels(role, parallelModels, preferFreeModels);

    if (candidates.length === 0) {
      return {
        results: [],
        successCount: 0,
        failureCount: 0,
        aggregatedContent: "",
        modelUsed: [],
        latencyMs: 0,
      };
    }

    logger.info("[Degradation] Parallel execution started", {
      models: candidates.map((m) => m.id),
      strategy: aggregationStrategy,
    });

    // 并行执行
    const promises = candidates.map((model) =>
      router
        .executeWithRole(role, messages, { temperature: 0.7 })
        .then((res) => ({ success: true, result: res, model: model.id }))
        .catch((err) => ({
          success: false,
          result: null,
          model: model.id,
          error: err instanceof Error ? err.message : String(err),
        }))
    );

    const settled = await Promise.allSettled(promises);
    const results: SmartAssignmentResponse[] = [];
    const modelUsed: string[] = [];
    let successCount = 0;
    let failureCount = 0;

    for (const item of settled) {
      if (item.status === "fulfilled") {
        const { success, result, model } = item.value as {
          success: boolean;
          result: SmartAssignmentResponse | null;
          model: string;
          error?: string;
        };

        if (success && result) {
          results.push(result);
          modelUsed.push(model);
          successCount++;
          this.recordSuccess(model, Date.now() - startTime);
        } else {
          failureCount++;
          this.recordFailure(model);
        }
      } else {
        failureCount++;
      }
    }

    const latencyMs = Date.now() - startTime;

    // 聚合结果
    const aggregatedContent = this.aggregateResults(results, aggregationStrategy);

    logger.info("[Degradation] Parallel execution completed", {
      successCount,
      failureCount,
      latency: latencyMs,
      strategy: aggregationStrategy,
    });

    return {
      results,
      successCount,
      failureCount,
      aggregatedContent,
      modelUsed,
      latencyMs,
    };
  }

  /**
   * 聚合多个模型的结果
   */
  aggregateResults(results: SmartAssignmentResponse[], strategy: AggregationStrategy): string {
    if (results.length === 0) return "[No results from any model]";
    if (results.length === 1) return results[0].content || "";

    switch (strategy) {
      case "best":
        return this.selectBestResult(results);
      case "merge":
        return this.mergeResults(results);
      case "vote":
        return this.voteResults(results);
      case "fastest":
        return this.selectFastestResult(results);
      default:
        return this.selectBestResult(results);
    }
  }

  /**
   * 获取健康状态报告
   */
  getHealthReport(): Record<string, { successRate: number; avgLatency: number; health: string }> {
    const report: Record<string, { successRate: number; avgLatency: number; health: string }> = {};

    for (const [modelId, stats] of this.healthScores) {
      const successRate = stats.total > 0 ? stats.success / stats.total : 1;
      const avgLatency = stats.avgLatency;

      let health = "🟢健康";
      if (successRate < 0.5) health = "🔴严重";
      else if (successRate < 0.8) health = "🟡告警";
      else if (avgLatency > 10000) health = "🟡缓慢";

      report[modelId] = { successRate, avgLatency, health };
    }

    return report;
  }

  // ═══════════════════════════════════════════════════════════════
  // 私有辅助方法
  // ═══════════════════════════════════════════════════════════════

  private selectParallelModels(role: TaskRole, count: number, preferFree: boolean): UnifiedModel[] {
    let candidates = getFallbackChain(role);

    if (preferFree) {
      const free = candidates.filter((m) => m.isFree);
      const paid = candidates.filter((m) => !m.isFree);
      candidates = [...free, ...paid];
    }

    // 过滤掉 circuit breaker 打开的模型
    candidates = candidates.filter((m) => !this.isCircuitOpen(m.id));

    return candidates.slice(0, count);
  }

  private isCircuitOpen(modelId: string): boolean {
    // 检查 ToolModelPool 的 circuit breaker 状态
    const stats = toolPool.getStats();
    const modelStats = stats[modelId] as { circuitOpen?: boolean } | undefined;
    return modelStats?.circuitOpen ?? false;
  }

  private selectBestResult(results: SmartAssignmentResponse[]): string {
    // 基于模型优先级选择最佳结果
    const scored = results.map((r) => {
      const model = findModelsForRole(r.role as TaskRole).find((m) => m.id === r.model);
      const priority = model?.priority ?? 99;
      const hasContent = r.content && r.content.length > 0 ? 1 : 0;
      const score = hasContent * 100 - priority; // 优先有内容的，再按优先级
      return { result: r, score };
    });

    scored.sort((a, b) => b.score - a.score);
    return scored[0]?.result.content || "";
  }

  private mergeResults(results: SmartAssignmentResponse[]): string {
    // 简单的结果合并：去重后拼接
    const contents = results
      .map((r) => r.content)
      .filter((c): c is string => !!c && c.length > 0);

    if (contents.length === 0) return "";
    if (contents.length === 1) return contents[0];

    // 使用分隔符合并
    return contents
      .map((c, i) => `--- Result ${i + 1} ---\n${c}`)
      .join("\n\n");
  }

  private voteResults(results: SmartAssignmentResponse[]): string {
    // 简单的投票：选择最常见的答案
    const contents = results
      .map((r) => r.content)
      .filter((c): c is string => !!c);

    if (contents.length === 0) return "";

    // 按内容相似度分组
    const groups: { content: string; count: number }[] = [];

    for (const content of contents) {
      let found = false;
      for (const group of groups) {
        if (this.contentSimilarity(content, group.content) > 0.7) {
          group.count++;
          found = true;
          break;
        }
      }
      if (!found) {
        groups.push({ content, count: 1 });
      }
    }

    groups.sort((a, b) => b.count - a.count);
    return groups[0]?.content || contents[0];
  }

  private selectFastestResult(results: SmartAssignmentResponse[]): string {
    const scored = results
      .filter((r) => r.latency_ms !== undefined)
      .sort((a, b) => (a.latency_ms ?? Infinity) - (b.latency_ms ?? Infinity));

    return scored[0]?.content || results[0]?.content || "";
  }

  private contentSimilarity(a: string, b: string): number {
    // 简单的 Jaccard 相似度
    const setA = new Set(a.toLowerCase().split(/\s+/));
    const setB = new Set(b.toLowerCase().split(/\s+/));
    const intersection = new Set([...setA].filter((x) => setB.has(x)));
    const union = new Set([...setA, ...setB]);
    return union.size > 0 ? intersection.size / union.size : 0;
  }

  private estimateCost(model: UnifiedModel): number {
    // 相对成本估算: 免费=0, 低成本=1, 标准=2, 高成本=3
    if (model.isFree) return 0;
    if (model.tags.includes("fast")) return 1;
    if (model.contextWindow > 100000) return 2;
    return 2;
  }

  private estimateQuality(model: UnifiedModel): number {
    // 质量估算基于优先级和标签
    let quality = 0.7;
    if (model.priority && model.priority <= 2) quality = 0.95;
    else if (model.priority && model.priority <= 3) quality = 0.85;
    if (model.tags.includes("reasoning")) quality += 0.05;
    if (model.tags.includes("coding")) quality += 0.05;
    return Math.min(quality, 1.0);
  }

  private recordSuccess(modelId: string, latencyMs: number): void {
    const stats = this.healthScores.get(modelId) || { success: 0, total: 0, avgLatency: 0 };
    stats.success++;
    stats.total++;
    stats.avgLatency = stats.avgLatency > 0
      ? (stats.avgLatency * (stats.total - 1) + latencyMs) / stats.total
      : latencyMs;
    this.healthScores.set(modelId, stats);
  }

  private recordFailure(modelId: string): void {
    const stats = this.healthScores.get(modelId) || { success: 0, total: 0, avgLatency: 0 };
    stats.total++;
    this.healthScores.set(modelId, stats);
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

export const gracefulDegradationRouter = new GracefulDegradationRouter();
