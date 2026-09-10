/**
 * S3 报告扩展（report-extras）— 测试先行（红）。
 * 覆盖：
 *  1. clusterFailures：分桶优先级（执行错误 → 限流 → 超时 → 内容缺失 → JSON 缺失 → 其他）、
 *     通过任务不计入、samples 去重 + 截断 + 上限 3 条、按计数降序
 *  2. trendMarkdown：空数组占位、表格行 run_tag / 通过率 / 延迟 / 成本（有成本与无成本）、limit 兜底、长 run_tag 截断
 *  3. compareMarkdown：summary diff（含 pp/ms 单位、null 泛化率）、分族表（a/b 缺失显示 -）、回落 ≥10pp 提示
 * 纯函数断言，不连网络、不落库。
 */
import { describe, expect, it } from "bun:test";
import {
  clusterFailures,
  compareMarkdown,
  trendMarkdown,
  type FailureCluster,
} from "../../src/agent-evals/report-extras.js";
import type { TaskResult } from "../../src/agent-evals/metrics.js";
import type { FamilySnapshot, RunComparison, RunRow } from "../../src/agent-evals/metrics-types.js";

// ===== 类型构造工具（参照 cost-token-dimension.test.ts 的 makeSummary/makeTask 风格）=====
function makeTask(overrides: Partial<TaskResult> = {}): TaskResult {
  return { taskId: "T-01", family: "coding", split: "held-out", passed: true, latencyMs: 100, outputLength: 64, ...overrides };
}

function family(total = 2, passed = 2): FamilySnapshot {
  return { total, passed, passRate: total > 0 ? Math.round((passed / total) * 10000) / 100 : 0 };
}

function makeRun(overrides: Partial<RunRow> = {}): RunRow {
  return {
    id: 1,
    runTag: "run-1",
    startedAt: "2026-09-03T10:00:00.000Z",
    finishedAt: "2026-09-03T10:05:00.000Z",
    model: "m",
    provider: "p",
    familyFilter: null,
    splitFilter: null,
    rerunEach: 0,
    evolvePhase: null,
    gitCommit: null,
    srcArgv: null,
    srcDoc: null,
    summaryTotal: 10,
    summaryPassed: 8,
    summaryPassRate: 80,
    summaryTrainRate: 80,
    summaryHeldOutRate: 80,
    summaryGeneralization: 0.8,
    summaryAvgLatencyMs: 1200,
    summaryAvgOutputLen: 512,
    summaryByFamily: { coding: family(5, 4), planning: family(5, 4) },
    summaryExecutionErrors: 0,
    summaryAvgCostUsd: null,
    summaryTotalCostUsd: null,
    summaryAvgCacheHitTokens: null,
    summaryTotalCacheHitTokens: null,
    summaryLatencyP50: null,
    summaryLatencyP95: null,
    summaryLatencyP99: null,
    exitCode: 0,
    ...overrides,
  };
}

function makeCompare(overrides: Partial<RunComparison> = {}): RunComparison {
  const a = makeRun({ id: 1, runTag: "base", summaryPassRate: 80 });
  const b = makeRun({ id: 2, runTag: "cand", summaryPassRate: 84 });
  return {
    a,
    b,
    summaryDiff: { passRate: 4, totalDiff: 0, generalizationDiff: 0.1, avgLatencyDiff: -50 },
    familyDiffs: [
      { family: "coding", a: family(5, 4), b: family(5, 5), passRateDiff: 20 },
      { family: "planning", a: family(5, 4), b: family(5, 3), passRateDiff: -20 },
    ],
    ...overrides,
  };
}

const byBucket = (clusters: FailureCluster[]) => Object.fromEntries(clusters.map((c) => [c.bucket, c.count]));
const samplesOf = (clusters: FailureCluster[], bucket: string): string[] =>
  clusters.find((c) => c.bucket === bucket)?.samples ?? [];

// ===== clusterFailures =====
describe("clusterFailures 分桶", () => {
  it("按优先级把各形态失败归入正确桶（执行错误优先于限流关键词）", () => {
    const clusters = clusterFailures([
      makeTask({ taskId: "E-01", passed: false, executionError: true, reason: "[ERROR] rate limited by provider 429" }),
      makeTask({ taskId: "R-01", passed: false, reason: "HTTP 429 rate limit exceeded" }),
      makeTask({ taskId: "R-02", passed: false, reason: "429 Too Many Requests" }),
      makeTask({ taskId: "T-01", passed: false, reason: "context deadline exceeded: timed out after 30s" }),
      makeTask({ taskId: "C-01", passed: false, reason: "empty content returned by provider" }),
      makeTask({ taskId: "C-02", passed: false, reason: "输出为空白，无有效内容" }),
      makeTask({ taskId: "J-01", passed: false, reason: "JSON 解析失败：响应非合法 JSON" }),
      makeTask({ taskId: "O-01", passed: false, reason: "关键词断言不匹配" }),
      makeTask({ taskId: "P-01", passed: true, reason: "n/a" }),
    ]);

    expect(byBucket(clusters)).toEqual({ 执行错误: 1, 限流: 2, 超时: 1, 内容缺失: 2, JSON缺失: 1, 其他: 1 });
    // 通过任务不计入
    expect(clusters.reduce((n, c) => n + c.count, 0)).toBe(8);
  });

  it("通过任务不计入，且全部通过时返回空数组", () => {
    expect(clusterFailures([makeTask(), makeTask({ taskId: "T-02", passed: true })])).toEqual([]);
    // 无 reason 的能力失败仍归入「其他」
    const clusters = clusterFailures([makeTask({ taskId: "X", passed: false })]);
    expect(clusters).toEqual([{ bucket: "其他", count: 1, samples: [] }]);
  });

  it("samples 去重、截断 ~120 字符且最多 3 条", () => {
    const clusters = clusterFailures([
      makeTask({ taskId: "A", passed: false, reason: "关键词「alpha」未命中输出" }),
      makeTask({ taskId: "B", passed: false, reason: "关键词「alpha」未命中输出" }), // 重复 reason 去重
      makeTask({ taskId: "C", passed: false, reason: "关键词「beta」未命中输出" }),
      makeTask({ taskId: "D", passed: false, reason: "关键词「gamma」未命中输出" }), // 第 4 条被丢弃
      makeTask({ taskId: "E", passed: false, reason: "关键词「超长」未命中 " + "x".repeat(200) }),
    ]);
    const samples = samplesOf(clusters, "其他");
    expect(clusters[0]?.count).toBe(5);
    expect(samples).toHaveLength(3);
    for (const s of samples) expect(s.length).toBeLessThanOrEqual(122);
    expect(samples).toContain("关键词「alpha」未命中输出");
    expect(samples.filter((s) => s.includes("alpha")).length).toBe(1);
  });

  it("返回按桶计数降序", () => {
    const clusters = clusterFailures([
      makeTask({ taskId: "1", passed: false, reason: "boom" }),
      makeTask({ taskId: "2", passed: false, reason: "boom" }),
      makeTask({ taskId: "3", passed: false, reason: "boom" }),
      makeTask({ taskId: "4", passed: false, reason: "JSON 格式错误" }),
      makeTask({ taskId: "5", passed: false, reason: "JSON 格式错误" }),
    ]);
    expect(clusters.map((c) => c.count)).toEqual([3, 2]);
    expect(clusters[0]?.bucket).toBe("其他");
    expect(clusters[1]?.bucket).toBe("JSON缺失");
  });
});

// ===== trendMarkdown =====
describe("trendMarkdown 趋势", () => {
  it("空数组输出占位", () => {
    expect(trendMarkdown([])).toBe("## 趋势\n\n（无历史记录）");
  });

  it("表格行含 run_tag / 通过率 / 延迟 / 成本（有成本与无成本两种形态）", () => {
    const md = trendMarkdown([
      makeRun({ id: 1, runTag: "run-a", summaryPassRate: 75, summaryAvgLatencyMs: 950, summaryTotalCostUsd: 0.006 }),
      makeRun({ id: 2, runTag: "run-b", summaryPassRate: 80, summaryAvgLatencyMs: 1200, summaryTotalCostUsd: null }),
    ]);
    expect(md).toContain("## 最近 2 轮趋势");
    expect(md).toContain("| run_tag | 时间 | 通过率 | 延迟 | 成本 |");
    expect(md).toContain("| run-a | 2026-09-03T10:00:00.000Z | 75% | 950ms | $0.006 |");
    expect(md).toContain("| run-b | 2026-09-03T10:00:00.000Z | 80% | 1200ms | - |");
  });

  it("limit 兜底截断为末 N 轮，标题随 limit 变化", () => {
    const md = trendMarkdown([
      makeRun({ id: 1, runTag: "r1" }),
      makeRun({ id: 2, runTag: "r2" }),
      makeRun({ id: 3, runTag: "r3" }),
    ]);
    expect(md).toContain("| r1 |");
    expect(md).toContain("## 最近 3 轮趋势");
    const trimmed = trendMarkdown([
      makeRun({ id: 1, runTag: "r1" }),
      makeRun({ id: 2, runTag: "r2" }),
      makeRun({ id: 3, runTag: "r3" }),
    ], { limit: 2 });
    expect(trimmed).toContain("## 最近 2 轮趋势");
    expect(trimmed).not.toContain("| r1 |");
    expect(trimmed).toContain("| r2 |");
    expect(trimmed).toContain("| r3 |");
  });

  it("长 run_tag 截断到 ~28 字符 + …", () => {
    const longTag = `long-run-tag-${"x".repeat(40)}`;
    const md = trendMarkdown([makeRun({ runTag: longTag })]);
    expect(md).not.toContain(longTag);
    expect(md).toContain(`${longTag.slice(0, 28)}…`);
  });
});

// ===== compareMarkdown =====
describe("compareMarkdown 对比", () => {
  it("输出标题、summary diff（pp/ms 单位）与分族表", () => {
    const md = compareMarkdown(makeCompare());
    expect(md).toContain("## 对比: base → cand");
    expect(md).toContain("+4.0 pp");
    expect(md).toContain("-50ms");
    expect(md).toContain("| 族 | 基准通过率 | 候选通过率 | 差(pp) |");
    expect(md).toContain("| coding | 80% | 100% | +20 |");
    expect(md).toContain("| planning | 80% | 60% | -20 |");
  });

  it("总量 diff 与正延迟 diff 带符号", () => {
    const md = compareMarkdown(makeCompare({ summaryDiff: { passRate: 0, totalDiff: 3, generalizationDiff: 0, avgLatencyDiff: 120.5 } }));
    expect(md).toContain("+3");
    expect(md).toContain("+120.5ms");
  });

  it("泛化率 diff 为 null 时显示 N/A", () => {
    const md = compareMarkdown(makeCompare({ a: makeRun({ summaryGeneralization: null }), summaryDiff: { passRate: 0, totalDiff: 0, generalizationDiff: null, avgLatencyDiff: 0 } }));
    expect(md).toContain("N/A");
  });

  it("一侧分族缺失时该侧显示 - 且差为 -", () => {
    const md = compareMarkdown(makeCompare({ familyDiffs: [{ family: "memory", a: null, b: family(3, 2), passRateDiff: null }] }));
    expect(md).toContain("| memory | - | 66.67% | - |");
  });

  it("通过率回落 ≥10pp 时追加回归提示行", () => {
    const md = compareMarkdown(
      makeCompare({
        a: makeRun({ id: 1, runTag: "base", summaryPassRate: 90 }),
        b: makeRun({ id: 2, runTag: "cand", summaryPassRate: 78 }),
        summaryDiff: { passRate: -12, totalDiff: 0, generalizationDiff: 0, avgLatencyDiff: 0 },
      }),
    );
    expect(md).toContain("⚠️ 通过率回落超 10pp");
  });

  it("回落不足 10pp 或持平/上升时不追加提示行", () => {
    const mild = compareMarkdown(
      makeCompare({
        a: makeRun({ id: 1, runTag: "base", summaryPassRate: 90 }),
        b: makeRun({ id: 2, runTag: "cand", summaryPassRate: 83 }),
        summaryDiff: { passRate: -7, totalDiff: 0, generalizationDiff: 0, avgLatencyDiff: 0 },
      }),
    );
    expect(mild).not.toContain("⚠️");
    const up = compareMarkdown(makeCompare());
    expect(up).not.toContain("⚠️");
  });
});
