/**
 * 可观测性监测 — Layer 5
 *
 * 设计目标（对应用户质量保障要求 + 方向三可观测性）：
 *   - 定义清晰的性能指标（响应时间、吞吐量、资源利用率等）
 *   - 建立持续性能监测体系
 *   - 制定严格的质量评估标准（准确率、召回率、F1值）
 *
 * 监测维度（5 项）：
 *   1. 查询级指标：每次查询的延迟/结果数/缓存命中/验证统计
 *   2. 系统健康快照：聚合统计（avg/p50/p99 延迟、吞吐量、缓存命中率、错误率）
 *   3. 质量评估：P/R/F1 指标（基于标注的测试查询集）
 *   4. 性能趋势：时间序列数据点（用于可视化，替代 Project_Golem 的 3D 可视化）
 *   5. 层级分解：各层延迟占比（关键词/图谱/融合/验证）
 *
 * 架构分层位置：
 *   Layer 0-4（检索→融合）→ 本模块（Layer 5 可观测性）
 *   本模块是顶层监测器，不参与检索流程，仅被动收集指标和提供查询接口。
 *
 * 设计原则（遵循 AGENTS.md 规则 8 深模块设计）：
 *   - 小接口：recordQuery / getHealthSnapshot / getQualityReport / getPerformanceTrend
 *   - 零侵入：指标作为参数传入，不修改下层模块
 *   - 接口即测试面：全部可通过公共接口验证
 */

import { logger } from "../../utils/logger.js";

// ─── 公共类型 ────────────────────────────────────────────────────────────

/** 查询级指标记录 — 单次查询的完整指标 */
export interface QueryMetricsRecord {
  /** 查询文本（截断到 100 字符） */
  query: string;
  /** 查询时间戳 */
  timestamp: number;
  /** 总延迟（毫秒） */
  latencyMs: number;
  /** 关键词检索阶段延迟 */
  keywordPhaseMs: number;
  /** 图谱检索阶段延迟 */
  graphPhaseMs: number;
  /** 融合阶段延迟 */
  mergePhaseMs: number;
  /** 是否命中缓存 */
  cacheHit: boolean;
  /** 返回结果数 */
  resultCount: number;
  /** 关键词结果数 */
  keywordResults: number;
  /** 图谱结果数 */
  graphResults: number;
  /** 已验证结果数 */
  verifiedCount: number;
  /** 矛盾结果数 */
  contradictedCount: number;
  /** 是否触发深度检索 */
  triggeredDeepRetrieval: boolean;
}

/** 系统健康快照 — 聚合统计 */
export interface SystemHealthSnapshot {
  /** 统计时间窗口（毫秒） */
  windowMs: number;
  /** 查询总数 */
  totalQueries: number;
  /** 平均延迟（毫秒） */
  avgLatencyMs: number;
  /** 中位数延迟 p50（毫秒） */
  p50LatencyMs: number;
  /** p99 延迟（毫秒） */
  p99LatencyMs: number;
  /** 最大延迟（毫秒） */
  maxLatencyMs: number;
  /** 吞吐量（查询/秒） */
  throughputQps: number;
  /** 缓存命中率 */
  cacheHitRate: number;
  /** 平均结果数 */
  avgResultCount: number;
  /** 验证率（verified / total） */
  verifiedRate: number;
  /** 矛盾率（contradicted / total） */
  contradictedRate: number;
  /** 深度检索触发率 */
  deepRetrievalTriggerRate: number;
  /** 错误数 */
  errorCount: number;
  /** 健康状态 */
  status: "healthy" | "degraded" | "unhealthy";
  /** 健康说明 */
  healthReason: string;
}

/** 质量评估指标 — P/R/F1 */
export interface QualityMetrics {
  /** 测试查询数 */
  totalTestQueries: number;
  /** 平均准确率 */
  avgPrecision: number;
  /** 平均召回率 */
  avgRecall: number;
  /** 平均 F1 */
  avgF1: number;
  /** 每条查询的详细指标 */
  perQuery: Array<{
    query: string;
    precision: number;
    recall: number;
    f1: number;
    resultCount: number;
    relevantCount: number;
  }>;
}

/** 性能趋势数据点 */
export interface TrendPoint {
  timestamp: number;
  latencyMs: number;
  resultCount: number;
  cacheHit: boolean;
}

/** 层级延迟分解 */
export interface LayerBreakdown {
  /** 关键词阶段占比 */
  keywordPhaseRatio: number;
  /** 图谱阶段占比 */
  graphPhaseRatio: number;
  /** 融合阶段占比 */
  mergePhaseRatio: number;
  /** 平均关键词延迟 */
  avgKeywordMs: number;
  /** 平均图谱延迟 */
  avgGraphMs: number;
  /** 平均融合延迟 */
  avgMergeMs: number;
}

// ─── 可观测性监测器 ──────────────────────────────────────────────────────

/**
 * 可观测性监测器 — 被动收集指标，提供聚合查询接口
 *
 * 使用方式：
 *   1. 每次检索后调用 recordQuery() 记录指标
 *   2. 定期调用 getHealthSnapshot() 获取系统健康状态
 *   3. 需要质量评估时调用 evaluateQuality() 运行测试集
 *   4. 需要趋势分析时调用 getPerformanceTrend() 获取时间序列
 */
export class ObservabilityMonitor {
  private readonly records: QueryMetricsRecord[] = [];
  private readonly maxRecords: number;
  private errorCount = 0;
  private readonly startTime: number;

  constructor(maxRecords = 1000) {
    this.maxRecords = maxRecords;
    this.startTime = Date.now();
  }

  /**
   * 记录单次查询的指标
   *
   * @param metrics 查询指标
   */
  recordQuery(metrics: Omit<QueryMetricsRecord, "timestamp">): void {
    const record: QueryMetricsRecord = {
      ...metrics,
      timestamp: Date.now(),
      query: metrics.query.slice(0, 100),
    };

    this.records.push(record);

    // 超出上限时移除最旧记录（环形缓冲）
    if (this.records.length > this.maxRecords) {
      this.records.shift();
    }

    logger.debug("[DRE/Observability] 查询指标已记录", {
      query: record.query.slice(0, 50),
      latencyMs: record.latencyMs,
      resultCount: record.resultCount,
    });
  }

  /** 记录错误 */
  recordError(): void {
    this.errorCount++;
  }

  /**
   * 获取系统健康快照 — 基于最近 N 条记录
   *
   * 健康状态判定：
   *   - healthy: p99 < 100ms, cacheHitRate > 0.3, errorRate < 0.05
   *   - degraded: p99 < 500ms, cacheHitRate > 0.1, errorRate < 0.2
   *   - unhealthy: 超出 degraded 阈值
   */
  getHealthSnapshot(recentCount = 100): SystemHealthSnapshot {
    const recent = this.records.slice(-recentCount);
    const windowMs = recent.length > 0
      ? recent[recent.length - 1].timestamp - recent[0].timestamp
      : 0;

    if (recent.length === 0) {
      return {
        windowMs: 0,
        totalQueries: 0,
        avgLatencyMs: 0,
        p50LatencyMs: 0,
        p99LatencyMs: 0,
        maxLatencyMs: 0,
        throughputQps: 0,
        cacheHitRate: 0,
        avgResultCount: 0,
        verifiedRate: 0,
        contradictedRate: 0,
        deepRetrievalTriggerRate: 0,
        errorCount: this.errorCount,
        status: "healthy",
        healthReason: "无查询记录",
      };
    }

    const latencies = recent.map((r) => r.latencyMs).sort((a, b) => a - b);
    const cacheHits = recent.filter((r) => r.cacheHit).length;
    const verifiedTotal = recent.reduce((sum, r) => sum + r.verifiedCount, 0);
    const contradictedTotal = recent.reduce((sum, r) => sum + r.contradictedCount, 0);
    const totalResults = recent.reduce((sum, r) => sum + r.resultCount, 0);
    const deepTriggers = recent.filter((r) => r.triggeredDeepRetrieval).length;

    const avgLatency = latencies.reduce((s, x) => s + x, 0) / latencies.length;
    const p50 = latencies[Math.floor(latencies.length * 0.5)];
    const p99 = latencies[Math.min(Math.floor(latencies.length * 0.99), latencies.length - 1)];
    const maxLatency = latencies[latencies.length - 1];
    const cacheHitRate = cacheHits / recent.length;
    const throughputQps = windowMs > 0 ? (recent.length / windowMs) * 1000 : 0;
    const errorRate = this.errorCount / (this.records.length + this.errorCount);

    // 健康状态判定
    let status: SystemHealthSnapshot["status"] = "healthy";
    const reasons: string[] = [];
    if (p99 > 100) {
      status = status === "healthy" ? "degraded" : status;
      reasons.push(`p99=${p99}ms > 100ms`);
    }
    if (cacheHitRate < 0.3 && recent.length > 10) {
      status = status === "healthy" ? "degraded" : status;
      reasons.push(`cacheHitRate=${cacheHitRate.toFixed(2)} < 0.3`);
    }
    if (errorRate > 0.05) {
      status = status === "healthy" ? "degraded" : status;
      reasons.push(`errorRate=${errorRate.toFixed(2)} > 0.05`);
    }
    if (p99 > 500 || errorRate > 0.2) {
      status = "unhealthy";
      reasons.push("严重超出阈值");
    }

    return {
      windowMs,
      totalQueries: recent.length,
      avgLatencyMs: Math.round(avgLatency * 100) / 100,
      p50LatencyMs: Math.round(p50 * 100) / 100,
      p99LatencyMs: Math.round(p99 * 100) / 100,
      maxLatencyMs: Math.round(maxLatency * 100) / 100,
      throughputQps: Math.round(throughputQps * 100) / 100,
      cacheHitRate: Math.round(cacheHitRate * 1000) / 1000,
      avgResultCount: Math.round((totalResults / recent.length) * 100) / 100,
      verifiedRate: totalResults > 0 ? Math.round((verifiedTotal / totalResults) * 1000) / 1000 : 0,
      contradictedRate: totalResults > 0 ? Math.round((contradictedTotal / totalResults) * 1000) / 1000 : 0,
      deepRetrievalTriggerRate: Math.round((deepTriggers / recent.length) * 1000) / 1000,
      errorCount: this.errorCount,
      status,
      healthReason: reasons.length > 0 ? reasons.join("；") : "所有指标在阈值内",
    };
  }

  /**
   * 获取性能趋势 — 时间序列数据点
   *
   * @param maxPoints 最大数据点数（默认 100，均匀采样）
   */
  getPerformanceTrend(maxPoints = 100): TrendPoint[] {
    if (this.records.length <= maxPoints) {
      return this.records.map((r) => ({
        timestamp: r.timestamp,
        latencyMs: r.latencyMs,
        resultCount: r.resultCount,
        cacheHit: r.cacheHit,
      }));
    }
    // 均匀采样
    const step = this.records.length / maxPoints;
    const trend: TrendPoint[] = [];
    for (let i = 0; i < maxPoints; i++) {
      const idx = Math.floor(i * step);
      const r = this.records[idx];
      trend.push({
        timestamp: r.timestamp,
        latencyMs: r.latencyMs,
        resultCount: r.resultCount,
        cacheHit: r.cacheHit,
      });
    }
    return trend;
  }

  /**
   * 获取层级延迟分解 — 各阶段延迟占比
   */
  getLayerBreakdown(recentCount = 100): LayerBreakdown {
    const recent = this.records.slice(-recentCount);
    if (recent.length === 0) {
      return {
        keywordPhaseRatio: 0,
        graphPhaseRatio: 0,
        mergePhaseRatio: 0,
        avgKeywordMs: 0,
        avgGraphMs: 0,
        avgMergeMs: 0,
      };
    }

    let totalKeyword = 0;
    let totalGraph = 0;
    let totalMerge = 0;
    let totalLatency = 0;

    for (const r of recent) {
      totalKeyword += r.keywordPhaseMs;
      totalGraph += r.graphPhaseMs;
      totalMerge += r.mergePhaseMs;
      totalLatency += r.latencyMs;
    }

    const avgKeyword = totalKeyword / recent.length;
    const avgGraph = totalGraph / recent.length;
    const avgMerge = totalMerge / recent.length;
    const avgTotal = totalLatency / recent.length;

    return {
      keywordPhaseRatio: avgTotal > 0 ? Math.round((avgKeyword / avgTotal) * 1000) / 1000 : 0,
      graphPhaseRatio: avgTotal > 0 ? Math.round((avgGraph / avgTotal) * 1000) / 1000 : 0,
      mergePhaseRatio: avgTotal > 0 ? Math.round((avgMerge / avgTotal) * 1000) / 1000 : 0,
      avgKeywordMs: Math.round(avgKeyword * 100) / 100,
      avgGraphMs: Math.round(avgGraph * 100) / 100,
      avgMergeMs: Math.round(avgMerge * 100) / 100,
    };
  }

  /**
   * 评估质量 — 基于标注的测试查询集计算 P/R/F1
   *
   * @param testCases 测试用例集（查询 + 相关 ID 集合 + 实际返回的 ID 集合）
   */
  evaluateQuality(
    testCases: Array<{
      query: string;
      relevantIds: Set<string>;
      returnedIds: string[];
    }>,
  ): QualityMetrics {
    const perQuery = testCases.map((tc) => {
      const precision = tc.returnedIds.length > 0
        ? tc.returnedIds.filter((id) => tc.relevantIds.has(id)).length / tc.returnedIds.length
        : 0;
      const recall = tc.relevantIds.size > 0
        ? tc.returnedIds.filter((id) => tc.relevantIds.has(id)).length / tc.relevantIds.size
        : 1;
      const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;
      return {
        query: tc.query.slice(0, 100),
        precision: Math.round(precision * 1000) / 1000,
        recall: Math.round(recall * 1000) / 1000,
        f1: Math.round(f1 * 1000) / 1000,
        resultCount: tc.returnedIds.length,
        relevantCount: tc.relevantIds.size,
      };
    });

    const avgPrecision = perQuery.length > 0 ? perQuery.reduce((s, q) => s + q.precision, 0) / perQuery.length : 0;
    const avgRecall = perQuery.length > 0 ? perQuery.reduce((s, q) => s + q.recall, 0) / perQuery.length : 0;
    const avgF1 = perQuery.length > 0 ? perQuery.reduce((s, q) => s + q.f1, 0) / perQuery.length : 0;

    return {
      totalTestQueries: perQuery.length,
      avgPrecision: Math.round(avgPrecision * 1000) / 1000,
      avgRecall: Math.round(avgRecall * 1000) / 1000,
      avgF1: Math.round(avgF1 * 1000) / 1000,
      perQuery,
    };
  }

  /** 获取总查询数 */
  getTotalQueries(): number {
    return this.records.length;
  }

  /** 重置所有指标 */
  reset(): void {
    this.records.length = 0;
    this.errorCount = 0;
  }
}

// ─── 单例 ───────────────────────────────────────────────────────────────

let _instance: ObservabilityMonitor | null = null;

/** 获取监测器单例 */
export function getObservabilityMonitor(): ObservabilityMonitor {
  if (!_instance) _instance = new ObservabilityMonitor();
  return _instance;
}

/** 测试用：重置单例 */
export function _resetObservabilityMonitorForTest(): void {
  _instance = null;
}

/** 测试用：设置自定义实例 */
export function _setObservabilityMonitorForTest(monitor: ObservabilityMonitor | null): void {
  _instance = monitor;
}
