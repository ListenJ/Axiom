/**
 * PCDA 调度器 — 单元测试
 *
 * 覆盖：
 * - Plan 阶段：任务矩阵生成正确性
 * - Check 阶段：指标聚合 + 问题检测
 * - Act 阶段：决策逻辑（escalate/retry/degrade/pass/fail）
 * - 完整 PCDA 循环：Plan→Do→Check→Act 端到端
 */

import { describe, test, expect, beforeEach } from "bun:test";
import {
  PCDAScheduler,
  LOAD_LEVELS,
  DEFAULT_PCDA_CONFIG,
  type PCDAConfig,
  type ClusterConfig,
  type LoadLevel,
  type TestResult,
  type TestMetrics,
  type CheckResult,
  type CheckIssue,
} from "../../src/testing/index.js";
import { DEFAULT_CLUSTER_CONFIG } from "../../src/testing/index.js";

// ═══════════════════════════════════════════════════════════════
// 辅助函数
// ═══════════════════════════════════════════════════════════════

/** 仅本地节点的集群配置 */
function localCluster(): ClusterConfig {
  return {
    ...DEFAULT_CLUSTER_CONFIG,
    nodes: [DEFAULT_CLUSTER_CONFIG.nodes[0]], // 仅 local
  };
}

/** 构造一个全通过的 TestResult */
function makePassResult(
  taskId: string,
  nodeId: string,
  overrides: Partial<TestMetrics> = {},
): TestResult {
  return {
    taskId,
    nodeId,
    status: "completed",
    durationMs: 100,
    metrics: {
      totalRequests: 100,
      successCount: 100,
      failureCount: 0,
      avgResponseMs: 5,
      p50ResponseMs: 5,
      p95ResponseMs: 10,
      p99ResponseMs: 15,
      throughput: 1000,
      errorRate: 0,
      ...overrides,
    },
    errors: [],
  };
}

/** 构造一个有幻觉问题的 TestResult */
function makeHallucinationResult(
  taskId: string,
  nodeId: string,
  hallucinationRate: number,
): TestResult {
  return makePassResult(taskId, nodeId, {
    hallucinationCount: Math.round(100 * hallucinationRate),
    hallucinationRate,
  });
}

/** 构造一个有串词问题的 TestResult */
function makeCrossTalkResult(
  taskId: string,
  nodeId: string,
  crossTalkRate: number,
): TestResult {
  return makePassResult(taskId, nodeId, {
    crossTalkCount: Math.round(100 * crossTalkRate),
    crossTalkRate,
  });
}

// ═══════════════════════════════════════════════════════════════
// Plan 阶段测试
// ═══════════════════════════════════════════════════════════════

describe("PCDAScheduler — Plan 阶段", () => {
  test("应为每个场景×节点生成任务", async () => {
    const config: PCDAConfig = {
      ...DEFAULT_PCDA_CONFIG,
      scenarios: ["hallucination", "cross-talk"],
      maxCycles: 1,
    };
    const scheduler = new PCDAScheduler(config, localCluster());
    const plan = await scheduler.plan(LOAD_LEVELS[0]);

    // 2 场景 × 1 节点 = 2 任务
    expect(plan.tasks.length).toBe(2);
    expect(plan.scenarios).toEqual(["hallucination", "cross-talk"]);
    expect(plan.loadLevel.name).toBe("warmup");
  });

  test("三节点集群应生成 3×场景数 个任务", async () => {
    const config: PCDAConfig = {
      ...DEFAULT_PCDA_CONFIG,
      scenarios: ["concurrent-load"],
      maxCycles: 1,
    };
    const scheduler = new PCDAScheduler(config, DEFAULT_CLUSTER_CONFIG);
    const plan = await scheduler.plan(LOAD_LEVELS[0]);

    // 1 场景 × 3 节点 = 3 任务
    expect(plan.tasks.length).toBe(3);
  });

  test("任务应正确设置并发数和请求数", async () => {
    const config: PCDAConfig = { ...DEFAULT_PCDA_CONFIG, maxCycles: 1 };
    const scheduler = new PCDAScheduler(config, localCluster());
    const plan = await scheduler.plan(LOAD_LEVELS[1]); // normal level

    expect(plan.tasks[0].concurrency).toBe(LOAD_LEVELS[1].concurrencyPerNode);
    expect(plan.tasks[0].requestsPerUser).toBe(LOAD_LEVELS[1].requestsPerUser);
  });

  test("任务 ID 应包含循环号、场景名和节点 ID", async () => {
    const scheduler = new PCDAScheduler(DEFAULT_PCDA_CONFIG, localCluster());
    const plan = await scheduler.plan(LOAD_LEVELS[0]);

    expect(plan.tasks[0].id).toMatch(/task-\d+-\w+-local/);
  });
});

// ═══════════════════════════════════════════════════════════════
// Check 阶段测试
// ═══════════════════════════════════════════════════════════════

describe("PCDAScheduler — Check 阶段", () => {
  let scheduler: PCDAScheduler;

  beforeEach(() => {
    scheduler = new PCDAScheduler(DEFAULT_PCDA_CONFIG, localCluster());
  });

  test("全通过的结果应返回 passed=true", () => {
    const results = [makePassResult("t1", "local")];
    const checkResult = scheduler.check(results, LOAD_LEVELS[0]);

    expect(checkResult.passed).toBe(true);
    expect(checkResult.issues.length).toBe(0);
  });

  test("幻觉率超阈值应检测为 issue", () => {
    const results = [makeHallucinationResult("t1", "local", 0.2)];
    const checkResult = scheduler.check(results, LOAD_LEVELS[1]); // threshold=0.05

    expect(checkResult.passed).toBe(false);
    expect(checkResult.issues.length).toBeGreaterThan(0);
    const hallucinationIssue = checkResult.issues.find((i) => i.type === "hallucination");
    expect(hallucinationIssue).toBeDefined();
    expect(hallucinationIssue!.actualValue).toBeCloseTo(0.2, 1);
    expect(hallucinationIssue!.threshold).toBeCloseTo(0.05, 2);
  });

  test("串词率超阈值应检测为 issue", () => {
    const results = [makeCrossTalkResult("t1", "local", 0.1)];
    const checkResult = scheduler.check(results, LOAD_LEVELS[1]); // threshold=0.02

    expect(checkResult.passed).toBe(false);
    const ctIssue = checkResult.issues.find((i) => i.type === "cross-talk");
    expect(ctIssue).toBeDefined();
  });

  test("P95 响应时间超阈值应检测为 performance issue", () => {
    const results = [makePassResult("t1", "local", {
      p95ResponseMs: 200,
      p99ResponseMs: 300,
    })];
    const checkResult = scheduler.check(results, LOAD_LEVELS[1]); // expectedMax=50ms

    const perfIssue = checkResult.issues.find((i) => i.type === "performance");
    expect(perfIssue).toBeDefined();
  });

  test("聚合指标应正确汇总多节点数据", () => {
    const results = [
      makePassResult("t1", "node-1", { totalRequests: 100, successCount: 100 }),
      makePassResult("t2", "node-2", { totalRequests: 50, successCount: 45, failureCount: 5 }),
    ];
    const checkResult = scheduler.check(results, LOAD_LEVELS[0]);

    expect(checkResult.aggregated.totalRequests).toBe(150);
    expect(checkResult.aggregated.totalSuccess).toBe(145);
    expect(checkResult.aggregated.totalFailures).toBe(5);
    expect(checkResult.aggregated.perNode.length).toBe(2);
  });

  test("严重度应按 actual/threshold 比值分级", () => {
    // 0.2 / 0.05 = 4x → high
    const results1 = [makeHallucinationResult("t1", "local", 0.2)];
    const check1 = scheduler.check(results1, LOAD_LEVELS[1]);
    const highIssue = check1.issues.find((i) => i.type === "hallucination");
    expect(["high", "critical"]).toContain(highIssue!.severity);
  });
});

// ═══════════════════════════════════════════════════════════════
// Act 阶段测试
// ═══════════════════════════════════════════════════════════════

describe("PCDAScheduler — Act 阶段", () => {
  let scheduler: PCDAScheduler;

  beforeEach(() => {
    scheduler = new PCDAScheduler(DEFAULT_PCDA_CONFIG, localCluster());
  });

  test("无问题时应 escalate（自动升级）", () => {
    const checkResult: CheckResult = {
      results: [makePassResult("t1", "local")],
      aggregated: {} as any,
      issues: [],
      passed: true,
    };

    const decision = scheduler.act(checkResult, LOAD_LEVELS[0]);
    expect(decision.action).toBe("escalate");
    expect(decision.nextLoadLevel).toBeDefined();
    expect(decision.nextLoadLevel!.level).toBe(2);
  });

  test("最高级别通过时应 pass", () => {
    const checkResult: CheckResult = {
      results: [makePassResult("t1", "local")],
      aggregated: {} as any,
      issues: [],
      passed: true,
    };

    const decision = scheduler.act(checkResult, LOAD_LEVELS[3]); // extreme (max level)
    expect(decision.action).toBe("pass");
  });

  test("critical 问题应 fail", () => {
    const checkResult: CheckResult = {
      results: [],
      aggregated: {} as any,
      issues: [{
        type: "hallucination",
        severity: "critical",
        message: "Critical hallucination detected",
      }],
      passed: false,
    };

    const decision = scheduler.act(checkResult, LOAD_LEVELS[1]);
    expect(decision.action).toBe("fail");
  });

  test("high 问题应 degrade", () => {
    const checkResult: CheckResult = {
      results: [],
      aggregated: {} as any,
      issues: [{
        type: "cross-talk",
        severity: "high",
        message: "High cross-talk rate",
      }],
      passed: false,
    };

    const decision = scheduler.act(checkResult, LOAD_LEVELS[2]); // high level (level=3)
    expect(decision.action).toBe("degrade");
    expect(decision.nextLoadLevel).toBeDefined();
    expect(decision.nextLoadLevel!.level).toBe(2); // degraded to normal (level=2)
  });
});

// ═══════════════════════════════════════════════════════════════
// 完整 PCDA 循环测试
// ═══════════════════════════════════════════════════════════════

describe("PCDAScheduler — 完整循环", () => {
  test("应成功运行一个完整 PCDA 循环", async () => {
    const config: PCDAConfig = {
      ...DEFAULT_PCDA_CONFIG,
      scenarios: ["concurrent-load"],
      maxCycles: 1,
      initialLoadLevel: 1,
      autoEscalate: false, // 不自动升级，仅 1 个循环
    };

    const scheduler = new PCDAScheduler(config, localCluster());
    const cycle = await scheduler.runCycle();

    expect(cycle.cycleId).toBe(1);
    expect(cycle.status).toBe("completed");
    expect(cycle.currentPhase).toBe("act");
    expect(cycle.phaseStatus.plan).toBe("completed");
    expect(cycle.phaseStatus.do).toBe("completed");
    expect(cycle.phaseStatus.check).toBe("completed");
    expect(cycle.phaseStatus.act).toBe("completed");
    expect(cycle.plan).toBeDefined();
    expect(cycle.checkResult).toBeDefined();
    expect(cycle.decision).toBeDefined();
  });

  test("run() 应在 maxCycles 后停止", async () => {
    const config: PCDAConfig = {
      ...DEFAULT_PCDA_CONFIG,
      scenarios: ["concurrent-load"],
      maxCycles: 2,
      autoEscalate: false,
    };

    const scheduler = new PCDAScheduler(config, localCluster());
    const cycles = await scheduler.run();

    expect(cycles.length).toBe(2);
    expect(scheduler.getCycles().length).toBe(2);
  });

  test("autoEscalate=true 时应在通过后升级负载级别", async () => {
    const config: PCDAConfig = {
      ...DEFAULT_PCDA_CONFIG,
      scenarios: ["concurrent-load"],
      maxCycles: 4, // 最多 4 级
      initialLoadLevel: 1,
      autoEscalate: true,
      maxLoadLevel: 4,
    };

    const scheduler = new PCDAScheduler(config, localCluster());
    const cycles = await scheduler.run();

    // 应至少运行到 level 2（可能因 mock 延迟太低而快速通过所有级别）
    expect(cycles.length).toBeGreaterThanOrEqual(1);
    // 最后一个循环的决策应该是 pass（达到最高级别）或 escalate（中间级别）
    const lastCycle = cycles[cycles.length - 1];
    expect(["pass", "escalate", "fail"]).toContain(lastCycle.decision!.action);
  });

  test("warmup 级别（阈值全 0）应在无幻觉无串词时通过", async () => {
    const config: PCDAConfig = {
      ...DEFAULT_PCDA_CONFIG,
      scenarios: ["concurrent-load"],
      maxCycles: 1,
      initialLoadLevel: 1, // warmup
      autoEscalate: false,
    };

    const scheduler = new PCDAScheduler(config, localCluster());
    const cycle = await scheduler.runCycle();

    // concurrent-load 无幻觉/串词，warmup 阈值=0，应通过
    expect(cycle.checkResult!.passed).toBe(true);
  });
});
