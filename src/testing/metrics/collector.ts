/**
 * 性能指标收集器
 *
 * 按节点记录请求、幻觉、串词、错误等指标，
 * 按需聚合为 TestMetrics（支持全局与分节点视图）。
 * 单线程 JS，通过同步计数器支持并发异步调用。
 */

import { logger } from "../../utils/logger.js";
import type { TestMetrics, TestError } from "../cluster/types.js";

/** 单节点累计数据 */
interface NodeData {
  responseTimes: number[];
  successCount: number;
  failureCount: number;
  /** 被检测的陈述数 */
  hallucinationTotal: number;
  hallucinationCount: number;
  crossTalkCount: number;
  errors: TestError[];
  /** 首末请求时间戳（用于吞吐量计算） */
  firstTs: number;
  lastTs: number;
}

export class MetricsCollector {
  private perNode = new Map<string, NodeData>();

  /** 获取或创建节点数据 */
  private getNode(nodeId: string): NodeData {
    let data = this.perNode.get(nodeId);
    if (!data) {
      data = {
        responseTimes: [],
        successCount: 0,
        failureCount: 0,
        hallucinationTotal: 0,
        hallucinationCount: 0,
        crossTalkCount: 0,
        errors: [],
        firstTs: 0,
        lastTs: 0,
      };
      this.perNode.set(nodeId, data);
    }
    return data;
  }

  /** 记录一次请求 */
  recordRequest(
    nodeId: string,
    responseTimeMs: number,
    success: boolean
  ): void {
    const data = this.getNode(nodeId);
    const now = Date.now();
    data.responseTimes.push(responseTimeMs);
    if (success) {
      data.successCount++;
    } else {
      data.failureCount++;
    }
    if (data.firstTs === 0) data.firstTs = now;
    data.lastTs = now;
  }

  /** 记录一次幻觉检测结果（verdict=true 表示判定为幻觉） */
  recordHallucination(
    nodeId: string,
    statement: string,
    verdict: boolean
  ): void {
    const data = this.getNode(nodeId);
    data.hallucinationTotal++;
    if (verdict) {
      data.hallucinationCount++;
    }
    logger.debug(
      `[collector] hallucination node=${nodeId} verdict=${verdict} ` +
        `statement="${statement.slice(0, 50)}"`
    );
  }

  /** 记录一次串词违规 */
  recordCrossTalk(
    nodeId: string,
    sessionId: string,
    leakedSecret: string
  ): void {
    const data = this.getNode(nodeId);
    data.crossTalkCount++;
    logger.debug(
      `[collector] cross-talk node=${nodeId} session=${sessionId} ` +
        `leaked="${leakedSecret}"`
    );
  }

  /** 记录一条错误 */
  recordError(nodeId: string, error: TestError): void {
    const data = this.getNode(nodeId);
    data.errors.push(error);
  }

  /** 计算百分位（线性插值） */
  private percentile(sorted: number[], p: number): number {
    if (sorted.length === 0) return 0;
    const idx = (p / 100) * (sorted.length - 1);
    const lower = Math.floor(idx);
    const upper = Math.ceil(idx);
    if (lower === upper) return sorted[lower];
    const weight = idx - lower;
    return sorted[lower] * (1 - weight) + sorted[upper] * weight;
  }

  /** 由节点数据构建 TestMetrics */
  private buildMetrics(data: NodeData): TestMetrics {
    const totalRequests = data.successCount + data.failureCount;
    const sorted = [...data.responseTimes].sort((a, b) => a - b);
    const avg =
      data.responseTimes.length > 0
        ? data.responseTimes.reduce((s, v) => s + v, 0) /
          data.responseTimes.length
        : 0;
    const elapsedSec =
      data.firstTs > 0 && data.lastTs > data.firstTs
        ? (data.lastTs - data.firstTs) / 1000
        : 0;
    const throughput = elapsedSec > 0 ? totalRequests / elapsedSec : 0;

    return {
      totalRequests,
      successCount: data.successCount,
      failureCount: data.failureCount,
      avgResponseMs: avg,
      p50ResponseMs: this.percentile(sorted, 50),
      p95ResponseMs: this.percentile(sorted, 95),
      p99ResponseMs: this.percentile(sorted, 99),
      throughput,
      hallucinationCount: data.hallucinationCount,
      hallucinationRate:
        data.hallucinationTotal > 0
          ? data.hallucinationCount / data.hallucinationTotal
          : undefined,
      crossTalkCount: data.crossTalkCount,
      crossTalkRate:
        totalRequests > 0 ? data.crossTalkCount / totalRequests : undefined,
      errorRate: totalRequests > 0 ? data.failureCount / totalRequests : 0,
    };
  }

  /** 聚合所有节点数据为全局 TestMetrics */
  getMetrics(): TestMetrics {
    let totalRequests = 0;
    let successCount = 0;
    let failureCount = 0;
    let hallucinationTotal = 0;
    let hallucinationCount = 0;
    let crossTalkCount = 0;
    let firstTs = 0;
    let lastTs = 0;
    const allResponseTimes: number[] = [];

    for (const data of this.perNode.values()) {
      totalRequests += data.successCount + data.failureCount;
      successCount += data.successCount;
      failureCount += data.failureCount;
      hallucinationTotal += data.hallucinationTotal;
      hallucinationCount += data.hallucinationCount;
      crossTalkCount += data.crossTalkCount;
      allResponseTimes.push(...data.responseTimes);
      if (firstTs === 0 || (data.firstTs > 0 && data.firstTs < firstTs)) {
        firstTs = data.firstTs;
      }
      if (data.lastTs > lastTs) lastTs = data.lastTs;
    }

    const sorted = allResponseTimes.sort((a, b) => a - b);
    const avg =
      allResponseTimes.length > 0
        ? allResponseTimes.reduce((s, v) => s + v, 0) / allResponseTimes.length
        : 0;
    const elapsedSec =
      firstTs > 0 && lastTs > firstTs ? (lastTs - firstTs) / 1000 : 0;
    const throughput = elapsedSec > 0 ? totalRequests / elapsedSec : 0;

    return {
      totalRequests,
      successCount,
      failureCount,
      avgResponseMs: avg,
      p50ResponseMs: this.percentile(sorted, 50),
      p95ResponseMs: this.percentile(sorted, 95),
      p99ResponseMs: this.percentile(sorted, 99),
      throughput,
      hallucinationCount,
      hallucinationRate:
        hallucinationTotal > 0
          ? hallucinationCount / hallucinationTotal
          : undefined,
      crossTalkCount,
      crossTalkRate:
        totalRequests > 0 ? crossTalkCount / totalRequests : undefined,
      errorRate: totalRequests > 0 ? failureCount / totalRequests : 0,
    };
  }

  /** 重置所有收集数据 */
  reset(): void {
    this.perNode.clear();
    logger.info("[collector] reset: all node data cleared");
  }

  /** 获取分节点指标视图 */
  getPerNodeMetrics(): Map<string, TestMetrics> {
    const result = new Map<string, TestMetrics>();
    for (const [nodeId, data] of this.perNode) {
      result.set(nodeId, this.buildMetrics(data));
    }
    return result;
  }
}
