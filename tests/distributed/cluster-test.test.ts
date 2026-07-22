/**
 * 分布式测试集群 — 单元测试
 *
 * 覆盖：
 * - 并发负载场景：指标计算正确性
 * - 幻觉检测场景：幻觉识别 + 误报控制
 * - 串词检测场景：会话隔离 + 串词检测
 * - 集群协调器：本地节点任务分发 + 结果收集
 * - 指标收集器：聚合统计正确性
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  runConcurrentLoad,
  calculatePercentiles,
  runHallucinationTest,
  runCrossTalkTest,
  MetricsCollector,
  ClusterCoordinator,
  DEFAULT_CLUSTER_CONFIG,
  type TestTask,
  type ClusterConfig,
} from "../../src/testing/index.js";

// ═══════════════════════════════════════════════════════════════
// 辅助函数
// ═══════════════════════════════════════════════════════════════

function makeTask(overrides: Partial<TestTask> = {}): TestTask {
  return {
    id: overrides.id ?? "test-task-1",
    scenario: overrides.scenario ?? "concurrent-load",
    name: overrides.name ?? "Test Task",
    concurrency: overrides.concurrency ?? 5,
    requestsPerUser: overrides.requestsPerUser ?? 10,
    timeout: overrides.timeout ?? 30000,
    params: overrides.params ?? {},
    priority: overrides.priority ?? 0,
    assignedNodeId: overrides.assignedNodeId ?? "local",
    dependencies: overrides.dependencies,
  };
}

/** 仅包含本地节点的集群配置（用于单元测试） */
function localOnlyCluster(): ClusterConfig {
  return {
    ...DEFAULT_CLUSTER_CONFIG,
    nodes: [
      {
        id: "local",
        name: "Local Test Node",
        type: "local" as const,
        maxConcurrency: 8,
        tags: ["local", "test"],
      },
    ],
  };
}

// ═══════════════════════════════════════════════════════════════
// calculatePercentiles 测试
// ═══════════════════════════════════════════════════════════════

describe("calculatePercentiles", () => {
  test("空数组应返回零值", () => {
    const p = calculatePercentiles([]);
    expect(p.p50).toBe(0);
    expect(p.p95).toBe(0);
    expect(p.p99).toBe(0);
    expect(p.avg).toBe(0);
  });

  test("单个值应全部等于该值", () => {
    const p = calculatePercentiles([42]);
    expect(p.p50).toBe(42);
    expect(p.p95).toBe(42);
    expect(p.p99).toBe(42);
    expect(p.avg).toBe(42);
  });

  test("应正确计算 P50/P95/P99", () => {
    // 1-100 的 100 个值
    const values = Array.from({ length: 100 }, (_, i) => i + 1);
    const p = calculatePercentiles(values);
    expect(p.avg).toBeCloseTo(50.5, 0);
    expect(p.p50).toBeGreaterThanOrEqual(50);
    expect(p.p50).toBeLessThanOrEqual(51);
    expect(p.p95).toBeGreaterThanOrEqual(95);
    expect(p.p99).toBeGreaterThanOrEqual(99);
  });
});

// ═══════════════════════════════════════════════════════════════
// 并发负载场景测试
// ═══════════════════════════════════════════════════════════════

describe("runConcurrentLoad", () => {
  test("应成功执行并返回有效指标", async () => {
    const task = makeTask({
      concurrency: 5,
      requestsPerUser: 10,
      params: { mockDelayMs: 1, failureRate: 0 },
    });

    const result = await runConcurrentLoad(task);

    expect(result.status).toBe("completed");
    expect(result.metrics.totalRequests).toBe(50);
    expect(result.metrics.successCount).toBe(50);
    expect(result.metrics.failureCount).toBe(0);
    expect(result.metrics.errorRate).toBe(0);
    expect(result.metrics.avgResponseMs).toBeGreaterThanOrEqual(0);
    expect(result.metrics.p50ResponseMs).toBeGreaterThanOrEqual(0);
    expect(result.metrics.p95ResponseMs).toBeGreaterThanOrEqual(0);
    expect(result.metrics.p99ResponseMs).toBeGreaterThanOrEqual(0);
    expect(result.metrics.throughput).toBeGreaterThan(0);
  });

  test("应正确处理模拟失败", async () => {
    const task = makeTask({
      concurrency: 3,
      requestsPerUser: 10,
      params: { mockDelayMs: 0, failureRate: 0.5 },
    });

    const result = await runConcurrentLoad(task);

    expect(result.metrics.totalRequests).toBe(30);
    expect(result.metrics.failureCount).toBeGreaterThan(0);
    expect(result.metrics.successCount + result.metrics.failureCount).toBe(30);
    expect(result.metrics.errorRate).toBeGreaterThan(0);
  });

  test("吞吐量应与并发数正相关", async () => {
    const task1 = makeTask({
      concurrency: 1,
      requestsPerUser: 20,
      params: { mockDelayMs: 2 },
    });
    const task2 = makeTask({
      concurrency: 5,
      requestsPerUser: 20,
      params: { mockDelayMs: 2 },
    });

    const r1 = await runConcurrentLoad(task1);
    const r2 = await runConcurrentLoad(task2);

    // 5 并发应比 1 并发吞吐量更高
    expect(r2.metrics.throughput).toBeGreaterThan(r1.metrics.throughput);
  });
});

// ═══════════════════════════════════════════════════════════════
// 幻觉检测场景测试
// ═══════════════════════════════════════════════════════════════

describe("runHallucinationTest", () => {
  test("hallucinationRate=0 时应无幻觉", async () => {
    const task = makeTask({
      scenario: "hallucination",
      concurrency: 3,
      requestsPerUser: 5,
      params: { hallucinationRate: 0, mockDelayMs: 0 },
    });

    const result = await runHallucinationTest(task);

    expect(result.status).toBe("completed");
    expect(result.metrics.totalRequests).toBe(15);
    expect(result.metrics.hallucinationCount).toBe(0);
    expect(result.metrics.hallucinationRate).toBe(0);
    expect(result.errors.length).toBe(0);
  });

  test("hallucinationRate=1.0 时应全部检测为幻觉", async () => {
    const task = makeTask({
      scenario: "hallucination",
      concurrency: 3,
      requestsPerUser: 5,
      params: { hallucinationRate: 1.0, mockDelayMs: 0 },
    });

    const result = await runHallucinationTest(task);

    expect(result.metrics.totalRequests).toBe(15);
    expect(result.metrics.hallucinationCount).toBe(15);
    expect(result.metrics.hallucinationRate).toBeCloseTo(1.0, 1);
    expect(result.errors.length).toBe(15);
    // 每个错误都应标记为 hallucination 类型
    expect(result.errors.every((e) => e.type === "hallucination")).toBe(true);
  });

  test("hallucinationRate=0.3 时幻觉率应接近 0.3", async () => {
    const task = makeTask({
      scenario: "hallucination",
      concurrency: 5,
      requestsPerUser: 20,
      params: { hallucinationRate: 0.3, mockDelayMs: 0 },
    });

    const result = await runHallucinationTest(task);

    expect(result.metrics.totalRequests).toBe(100);
    // 统计上应接近 30%，允许 ±15% 误差
    expect(result.metrics.hallucinationRate).toBeGreaterThan(0.15);
    expect(result.metrics.hallucinationRate).toBeLessThan(0.45);
  });
});

// ═══════════════════════════════════════════════════════════════
// 串词检测场景测试
// ═══════════════════════════════════════════════════════════════

describe("runCrossTalkTest", () => {
  test("crossTalkRate=0 时应无串词", async () => {
    const task = makeTask({
      scenario: "cross-talk",
      concurrency: 5,
      requestsPerUser: 5,
      params: { crossTalkRate: 0, mockDelayMs: 0 },
    });

    const result = await runCrossTalkTest(task);

    expect(result.status).toBe("completed");
    expect(result.metrics.totalRequests).toBe(25);
    expect(result.metrics.crossTalkCount).toBe(0);
    expect(result.metrics.crossTalkRate).toBe(0);
    expect(result.errors.length).toBe(0);
  });

  test("crossTalkRate=1.0 时应全部检测为串词", async () => {
    const task = makeTask({
      scenario: "cross-talk",
      concurrency: 3,
      requestsPerUser: 3,
      params: { crossTalkRate: 1.0, mockDelayMs: 0 },
    });

    const result = await runCrossTalkTest(task);

    expect(result.metrics.totalRequests).toBe(9);
    expect(result.metrics.crossTalkCount).toBe(9);
    expect(result.metrics.crossTalkRate).toBeCloseTo(1.0, 1);
    expect(result.errors.length).toBe(9);
    expect(result.errors.every((e) => e.type === "cross-talk")).toBe(true);
  });

  test("每个会话应有唯一的 secret token", async () => {
    // 通过设置 concurrency > 1 并验证不串词来间接验证 secret 唯一性
    const task = makeTask({
      scenario: "cross-talk",
      concurrency: 10,
      requestsPerUser: 1,
      params: { crossTalkRate: 0, mockDelayMs: 0 },
    });

    const result = await runCrossTalkTest(task);

    // 10 个会话 × 1 请求 = 10 个请求，0 串词说明 secret 唯一
    expect(result.metrics.totalRequests).toBe(10);
    expect(result.metrics.crossTalkCount).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════
// MetricsCollector 测试
// ═══════════════════════════════════════════════════════════════

describe("MetricsCollector", () => {
  let collector: MetricsCollector;

  beforeEach(() => {
    collector = new MetricsCollector();
  });

  test("应正确记录请求数和响应时间", () => {
    collector.recordRequest("node-1", 10, true);
    collector.recordRequest("node-1", 20, true);
    collector.recordRequest("node-1", 30, false);

    const metrics = collector.getMetrics();
    expect(metrics.totalRequests).toBe(3);
    expect(metrics.successCount).toBe(2);
    expect(metrics.failureCount).toBe(1);
    expect(metrics.avgResponseMs).toBeCloseTo(20, 0);
  });

  test("应正确记录幻觉", () => {
    collector.recordHallucination("node-1", "fake fact 1", true);
    collector.recordHallucination("node-1", "real fact 1", false);
    collector.recordHallucination("node-1", "fake fact 2", true);

    const metrics = collector.getMetrics();
    expect(metrics.hallucinationCount).toBe(2);
  });

  test("应正确记录串词", () => {
    collector.recordCrossTalk("node-1", "session-1", "SECRET-session-2-abc");
    collector.recordCrossTalk("node-1", "session-3", "SECRET-session-1-xyz");

    const metrics = collector.getMetrics();
    expect(metrics.crossTalkCount).toBe(2);
  });

  test("reset 应清空所有数据", () => {
    collector.recordRequest("node-1", 10, true);
    collector.recordHallucination("node-1", "test", true);
    collector.reset();

    const metrics = collector.getMetrics();
    expect(metrics.totalRequests).toBe(0);
    expect(metrics.hallucinationCount).toBe(0);
  });

  test("getPerNodeMetrics 应返回按节点分组的指标", () => {
    collector.recordRequest("node-1", 10, true);
    collector.recordRequest("node-2", 20, true);
    collector.recordRequest("node-1", 15, true);

    const perNode = collector.getPerNodeMetrics();
    expect(perNode.size).toBe(2);
    expect(perNode.get("node-1")!.totalRequests).toBe(2);
    expect(perNode.get("node-2")!.totalRequests).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════
// ClusterCoordinator 测试（仅本地节点）
// ═══════════════════════════════════════════════════════════════

describe("ClusterCoordinator (local only)", () => {
  let coordinator: ClusterCoordinator;

  beforeEach(() => {
    coordinator = new ClusterCoordinator(localOnlyCluster());
  });

  afterEach(async () => {
    await coordinator.shutdown();
  });

  test("应成功分发单个任务到本地节点", async () => {
    const task = makeTask({
      scenario: "concurrent-load",
      concurrency: 3,
      requestsPerUser: 5,
      params: { mockDelayMs: 0 },
    });

    const result = await coordinator.dispatchSingle(task);

    expect(result.taskId).toBe(task.id);
    expect(result.nodeId).toBe("local");
    expect(result.status).toBe("completed");
    expect(result.metrics.totalRequests).toBe(15);
    expect(result.metrics.successCount).toBe(15);
  });

  test("应成功批量分发多个任务", async () => {
    const tasks = [
      makeTask({
        id: "batch-1",
        scenario: "concurrent-load",
        concurrency: 2,
        requestsPerUser: 5,
        params: { mockDelayMs: 0 },
      }),
      makeTask({
        id: "batch-2",
        scenario: "hallucination",
        concurrency: 2,
        requestsPerUser: 5,
        params: { hallucinationRate: 0, mockDelayMs: 0 },
      }),
    ];

    const results = await coordinator.dispatch(tasks);

    expect(results.length).toBe(2);
    expect(results[0].taskId).toBe("batch-1");
    expect(results[0].status).toBe("completed");
    expect(results[1].taskId).toBe("batch-2");
    expect(results[1].status).toBe("completed");
  });

  test("getNodeStatuses 应返回节点状态", async () => {
    const statuses = coordinator.getNodeStatuses();
    expect(statuses.length).toBe(1);
    expect(statuses[0].nodeId).toBe("local");
  });

  test("幻觉检测任务应通过协调器正确执行", async () => {
    const task = makeTask({
      id: "hall-test",
      scenario: "hallucination",
      concurrency: 2,
      requestsPerUser: 5,
      params: { hallucinationRate: 0.5, mockDelayMs: 0 },
    });

    const result = await coordinator.dispatchSingle(task);

    expect(result.status).toBe("completed");
    expect(result.metrics.totalRequests).toBe(10);
    expect(result.metrics.hallucinationCount).toBeGreaterThan(0);
  });

  test("串词检测任务应通过协调器正确执行", async () => {
    const task = makeTask({
      id: "ct-test",
      scenario: "cross-talk",
      concurrency: 3,
      requestsPerUser: 3,
      params: { crossTalkRate: 0.3, mockDelayMs: 0 },
    });

    const result = await coordinator.dispatchSingle(task);

    expect(result.status).toBe("completed");
    expect(result.metrics.totalRequests).toBe(9);
    expect(result.metrics.crossTalkCount).toBeGreaterThan(0);
  });
});
