/**
 * 可观测性监测 — Layer 5 测试套件
 *
 * 覆盖维度：
 *   1. 功能测试：记录/快照/趋势/层级分解/质量评估
 *   2. 健康状态判定：healthy/degraded/unhealthy
 *   3. 边界条件：空记录/单条/溢出/重置
 *   4. 质量评估：P/R/F1 计算
 *   5. 性能基准：1000 记录快照延迟
 *
 * 测试策略：全部通过公共接口验证，手工构造指标记录。
 */
import { describe, beforeEach, afterEach, test, expect } from "bun:test";
import {
  ObservabilityMonitor,
  _resetObservabilityMonitorForTest,
} from "../src/dre/retrieval/observability.js";

// ─── 测试辅助 ────────────────────────────────────────────────────────────

function makeMetrics(opts: Partial<{
  query: string;
  latencyMs: number;
  keywordPhaseMs: number;
  graphPhaseMs: number;
  mergePhaseMs: number;
  cacheHit: boolean;
  resultCount: number;
  keywordResults: number;
  graphResults: number;
  verifiedCount: number;
  contradictedCount: number;
  triggeredDeepRetrieval: boolean;
}> = {}): Parameters<ObservabilityMonitor["recordQuery"]>[0] {
  return {
    query: opts.query ?? "test query",
    latencyMs: opts.latencyMs ?? 10,
    keywordPhaseMs: opts.keywordPhaseMs ?? 3,
    graphPhaseMs: opts.graphPhaseMs ?? 5,
    mergePhaseMs: opts.mergePhaseMs ?? 2,
    cacheHit: opts.cacheHit ?? false,
    resultCount: opts.resultCount ?? 5,
    keywordResults: opts.keywordResults ?? 2,
    graphResults: opts.graphResults ?? 3,
    verifiedCount: opts.verifiedCount ?? 3,
    contradictedCount: opts.contradictedCount ?? 0,
    triggeredDeepRetrieval: opts.triggeredDeepRetrieval ?? false,
  };
}

// ─── 功能测试 ──────────────────────────────────────────────────────────

describe("ObservabilityMonitor — 功能测试", () => {
  let monitor: ObservabilityMonitor;

  beforeEach(() => {
    monitor = new ObservabilityMonitor();
  });

  afterEach(() => {
    _resetObservabilityMonitorForTest();
  });

  test("recordQuery 记录查询指标", () => {
    monitor.recordQuery(makeMetrics({ query: "hello", latencyMs: 15 }));
    expect(monitor.getTotalQueries()).toBe(1);
  });

  test("getHealthSnapshot 返回完整健康快照", () => {
    monitor.recordQuery(makeMetrics({ latencyMs: 10, cacheHit: false }));
    monitor.recordQuery(makeMetrics({ latencyMs: 20, cacheHit: true }));
    const snapshot = monitor.getHealthSnapshot();
    expect(snapshot.totalQueries).toBe(2);
    expect(snapshot.avgLatencyMs).toBe(15);
    expect(snapshot.cacheHitRate).toBe(0.5);
    expect(snapshot.status).toBeDefined();
    expect(snapshot.healthReason.length).toBeGreaterThan(0);
  });

  test("getPerformanceTrend 返回趋势数据", () => {
    for (let i = 0; i < 10; i++) {
      monitor.recordQuery(makeMetrics({ latencyMs: 10 + i }));
    }
    const trend = monitor.getPerformanceTrend();
    expect(trend.length).toBe(10);
    expect(trend[0].latencyMs).toBe(10);
    expect(trend[9].latencyMs).toBe(19);
  });

  test("getPerformanceTrend 均匀采样", () => {
    for (let i = 0; i < 100; i++) {
      monitor.recordQuery(makeMetrics({ latencyMs: i }));
    }
    const trend = monitor.getPerformanceTrend(10);
    expect(trend.length).toBe(10);
  });

  test("getLayerBreakdown 返回层级延迟分解", () => {
    monitor.recordQuery(makeMetrics({ latencyMs: 30, keywordPhaseMs: 10, graphPhaseMs: 15, mergePhaseMs: 5 }));
    const breakdown = monitor.getLayerBreakdown();
    expect(breakdown.avgKeywordMs).toBe(10);
    expect(breakdown.avgGraphMs).toBe(15);
    expect(breakdown.avgMergeMs).toBe(5);
    expect(breakdown.keywordPhaseRatio).toBeCloseTo(10 / 30, 1);
    expect(breakdown.graphPhaseRatio).toBeCloseTo(15 / 30, 1);
    expect(breakdown.mergePhaseRatio).toBeCloseTo(5 / 30, 1);
  });

  test("evaluateQuality 计算 P/R/F1", () => {
    const report = monitor.evaluateQuality([
      {
        query: "test",
        relevantIds: new Set(["a", "b", "c"]),
        returnedIds: ["a", "b", "d"],
      },
    ]);
    expect(report.totalTestQueries).toBe(1);
    // precision = 2/3 (a, b are relevant out of a, b, d)
    expect(report.avgPrecision).toBeCloseTo(2 / 3, 1);
    // recall = 2/3 (a, b found out of a, b, c)
    expect(report.avgRecall).toBeCloseTo(2 / 3, 1);
    // F1 = 2*(P*R)/(P+R)
    expect(report.avgF1).toBeCloseTo(2 / 3, 1);
    expect(report.perQuery.length).toBe(1);
  });
});

// ─── 健康状态判定 ──────────────────────────────────────────────────────

describe("ObservabilityMonitor — 健康状态判定", () => {
  let monitor: ObservabilityMonitor;

  beforeEach(() => {
    monitor = new ObservabilityMonitor();
  });

  afterEach(() => {
    _resetObservabilityMonitorForTest();
  });

  test("healthy: 低延迟 + 高缓存命中", () => {
    for (let i = 0; i < 20; i++) {
      monitor.recordQuery(makeMetrics({ latencyMs: 10, cacheHit: true }));
    }
    const snapshot = monitor.getHealthSnapshot();
    expect(snapshot.status).toBe("healthy");
    expect(snapshot.p99LatencyMs).toBeLessThanOrEqual(100);
  });

  test("degraded: 高延迟触发降级", () => {
    for (let i = 0; i < 20; i++) {
      monitor.recordQuery(makeMetrics({ latencyMs: 150, cacheHit: true }));
    }
    const snapshot = monitor.getHealthSnapshot();
    expect(snapshot.status).toBe("degraded");
    expect(snapshot.p99LatencyMs).toBeGreaterThan(100);
  });

  test("unhealthy: 极高延迟触发不健康", () => {
    for (let i = 0; i < 20; i++) {
      monitor.recordQuery(makeMetrics({ latencyMs: 600, cacheHit: false }));
    }
    const snapshot = monitor.getHealthSnapshot();
    expect(snapshot.status).toBe("unhealthy");
    expect(snapshot.p99LatencyMs).toBeGreaterThan(500);
  });

  test("错误率影响健康状态", () => {
    for (let i = 0; i < 20; i++) {
      monitor.recordQuery(makeMetrics({ latencyMs: 10 }));
    }
    // 记录大量错误
    for (let i = 0; i < 10; i++) {
      monitor.recordError();
    }
    const snapshot = monitor.getHealthSnapshot();
    expect(snapshot.errorCount).toBe(10);
    expect(snapshot.status).not.toBe("healthy");
  });
});

// ─── 边界条件 ──────────────────────────────────────────────────────────

describe("ObservabilityMonitor — 边界条件", () => {
  let monitor: ObservabilityMonitor;

  beforeEach(() => {
    monitor = new ObservabilityMonitor(50); // 小上限便于测试溢出
  });

  afterEach(() => {
    _resetObservabilityMonitorForTest();
  });

  test("空记录：返回默认健康快照", () => {
    const snapshot = monitor.getHealthSnapshot();
    expect(snapshot.totalQueries).toBe(0);
    expect(snapshot.avgLatencyMs).toBe(0);
    expect(snapshot.status).toBe("healthy");
  });

  test("单条记录：正常统计", () => {
    monitor.recordQuery(makeMetrics({ latencyMs: 42 }));
    const snapshot = monitor.getHealthSnapshot();
    expect(snapshot.totalQueries).toBe(1);
    expect(snapshot.avgLatencyMs).toBe(42);
    expect(snapshot.p50LatencyMs).toBe(42);
    expect(snapshot.p99LatencyMs).toBe(42);
  });

  test("maxRecords 溢出：移除最旧记录", () => {
    for (let i = 0; i < 60; i++) {
      monitor.recordQuery(makeMetrics({ latencyMs: i }));
    }
    expect(monitor.getTotalQueries()).toBe(50); // 上限 50
    // 最旧记录（latency=10）应被移除
    const trend = monitor.getPerformanceTrend();
    expect(trend[0].latencyMs).toBeGreaterThanOrEqual(10); // 60-50=10 起始
  });

  test("reset 清空所有记录", () => {
    monitor.recordQuery(makeMetrics({ latencyMs: 10 }));
    monitor.recordError();
    expect(monitor.getTotalQueries()).toBe(1);
    monitor.reset();
    expect(monitor.getTotalQueries()).toBe(0);
    const snapshot = monitor.getHealthSnapshot();
    expect(snapshot.errorCount).toBe(0);
  });

  test("evaluateQuality 空测试集不崩溃", () => {
    const report = monitor.evaluateQuality([]);
    expect(report.totalTestQueries).toBe(0);
    expect(report.avgPrecision).toBe(0);
  });

  test("evaluateQuality 完美匹配", () => {
    const report = monitor.evaluateQuality([
      {
        query: "perfect",
        relevantIds: new Set(["a", "b"]),
        returnedIds: ["a", "b"],
      },
    ]);
    expect(report.avgPrecision).toBe(1);
    expect(report.avgRecall).toBe(1);
    expect(report.avgF1).toBe(1);
  });

  test("evaluateQuality 零召回", () => {
    const report = monitor.evaluateQuality([
      {
        query: "miss",
        relevantIds: new Set(["a", "b"]),
        returnedIds: ["c", "d"],
      },
    ]);
    expect(report.avgPrecision).toBe(0);
    expect(report.avgRecall).toBe(0);
    expect(report.avgF1).toBe(0);
  });
});

// ─── 性能基准 ──────────────────────────────────────────────────────────

describe("ObservabilityMonitor — 性能基准", () => {
  let monitor: ObservabilityMonitor;

  beforeEach(() => {
    monitor = new ObservabilityMonitor();
  });

  afterEach(() => {
    _resetObservabilityMonitorForTest();
  });

  test("1000 记录健康快照延迟 < 10ms", () => {
    for (let i = 0; i < 1000; i++) {
      monitor.recordQuery(makeMetrics({ latencyMs: 10 + (i % 50), cacheHit: i % 3 === 0 }));
    }
    const start = performance.now();
    const snapshot = monitor.getHealthSnapshot(1000);
    const elapsed = performance.now() - start;
    expect(snapshot.totalQueries).toBe(1000);
    expect(elapsed).toBeLessThan(10);
  });

  test("1000 记录趋势采样延迟 < 10ms", () => {
    for (let i = 0; i < 1000; i++) {
      monitor.recordQuery(makeMetrics({ latencyMs: i }));
    }
    const start = performance.now();
    const trend = monitor.getPerformanceTrend(100);
    const elapsed = performance.now() - start;
    expect(trend.length).toBe(100);
    expect(elapsed).toBeLessThan(10);
  });
});

// ─── 单例 ──────────────────────────────────────────────────────────────

describe("ObservabilityMonitor — 单例", () => {
  afterEach(() => {
    _resetObservabilityMonitorForTest();
  });

  test("getObservabilityMonitor 返回同一实例", async () => {
    const { getObservabilityMonitor } = await import("../src/dre/retrieval/observability.js");
    const a = getObservabilityMonitor();
    const b = getObservabilityMonitor();
    expect(a).toBe(b);
  });

  test("_resetObservabilityMonitorForTest 重置单例", async () => {
    const { getObservabilityMonitor } = await import("../src/dre/retrieval/observability.js");
    const a = getObservabilityMonitor();
    _resetObservabilityMonitorForTest();
    const b = getObservabilityMonitor();
    expect(a).not.toBe(b);
  });
});
