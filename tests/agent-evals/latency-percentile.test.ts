/**
 * S2 延迟分位（p50/p95/p99）— 测试先行（红）。
 * 覆盖：
 *  1. summarize 分位正确性：nearest-rank（索引 = ceil(p/100 * n) - 1）精确期望值
 *     - 全样本口径（含执行错误）：延迟是 provider 侧真实感知，与能力成败无关，与 avgLatencyMs 一致
 *     - 不要求输入预先排序
 *  2. 小样本回退：n < 3 时 p95/p99 为 null（无统计意义），p50 在 n >= 1 始终有效
 *  3. 空数组三分位全 null（不破坏既有 avgLatencyMs = 0 口径）
 *  4. 兼容红线：既有 sum/rate 聚合不变；report.toMarkdown 延迟行前缀不变且展示分位
 */
import { describe, expect, it } from "bun:test";
import { summarize, type MetricsSummary, type TaskResult } from "../../src/agent-evals/metrics.js";
import { toMarkdown } from "../../src/agent-evals/report.js";

function result(latencyMs: number, overrides: Partial<TaskResult> = {}): TaskResult {
  return { taskId: `t-${latencyMs}`, family: "coding", split: "held-out", passed: true, latencyMs, outputLength: 50, ...overrides };
}

describe("metrics summarize 延迟分位（nearest-rank）", () => {
  it("[100,200,300,400,500] 的 p50/p95/p99 精确取值", () => {
    const s = summarize([result(100), result(200), result(300), result(400), result(500)]);
    expect(s.avgLatencyMs).toBe(300);
    // 索引 = ceil(p/100 * 5) - 1 → p50: idx2 = 300，p95/p99: idx4 = 500
    expect(s.latencyP50).toBe(300);
    expect(s.latencyP95).toBe(500);
    expect(s.latencyP99).toBe(500);
  });

  it("不要求输入预先排序（内部升序处理）", () => {
    const s = summarize([result(500), result(100), result(300), result(200), result(400)]);
    expect(s.latencyP50).toBe(300);
    expect(s.latencyP95).toBe(500);
    expect(s.latencyP99).toBe(500);
  });

  it("n=20 的 p95/p99 区分：p95=190、p99=200", () => {
    const lats = Array.from({ length: 20 }, (_, i) => (i + 1) * 10); // 10..200
    const s = summarize(lats.map((l) => result(l)));
    // idx = ceil(0.5*20)-1 = 9 → 100；ceil(0.95*20)-1 = 18 → 190；ceil(0.99*20)-1 = 19 → 200
    expect(s.latencyP50).toBe(100);
    expect(s.latencyP95).toBe(190);
    expect(s.latencyP99).toBe(200);
  });

  it("分位含执行错误样本（全样本口径，与 avgLatencyMs 一致）", () => {
    const s = summarize([
      result(100),
      result(200),
      result(300, { passed: false, executionError: true, reason: "rate limit" }),
      result(400),
      result(500),
    ]);
    // 执行错误样本的 300ms 是 provider 侧真实耗时，仍参与分位
    expect(s.latencyP50).toBe(300);
    expect(s.latencyP95).toBe(500);
    expect(s.executionErrors).toBe(1);
    // 既有口径不变：能力通过率分母剔除执行错误
    expect(s.passRate).toBe(100);
  });

  it("n=1 时 p50 有效，p95/p99 回退 null", () => {
    const s = summarize([result(100)]);
    expect(s.latencyP50).toBe(100);
    expect(s.latencyP95).toBeNull();
    expect(s.latencyP99).toBeNull();
  });

  it("n=2 时 p50 有效，p95/p99 回退 null", () => {
    const s = summarize([result(100), result(200)]);
    // idx = ceil(0.5*2) - 1 = 0 → 第 1 小值
    expect(s.latencyP50).toBe(100);
    expect(s.latencyP95).toBeNull();
    expect(s.latencyP99).toBeNull();
  });

  it("n=3 开始 p95/p99 有效（分界）", () => {
    const s = summarize([result(100), result(200), result(300)]);
    // idx = ceil(0.5*3) - 1 = 1 → 第 2 小值
    expect(s.latencyP50).toBe(200);
    expect(s.latencyP95).toBe(300);
    expect(s.latencyP99).toBe(300);
  });

  it("空数组三分位全 null，avgLatencyMs 仍为 0（既有口径不变）", () => {
    const s = summarize([]);
    expect(s.avgLatencyMs).toBe(0);
    expect(s.latencyP50).toBeNull();
    expect(s.latencyP95).toBeNull();
    expect(s.latencyP99).toBeNull();
  });

  it("兼容红线：既有 sum/rate 聚合不因新字段改变", () => {
    const s = summarize([
      result(100, { split: "train", passed: true }),
      result(200, { split: "train", passed: false }),
      result(300, { split: "held-out", passed: true }),
    ]);
    expect(s.total).toBe(3);
    expect(s.passed).toBe(2);
    expect(s.passRate).toBe(66.7);
    expect(s.trainRate).toBe(50);
    expect(s.heldOutRate).toBe(100);
    expect(s.generalizationRatio).toBe(2);
    expect(s.avgLatencyMs).toBe(200);
    expect(s.byFamily.coding.passRate).toBe(66.7);
  });
});

describe("report toMarkdown 延迟行（分位展示，前缀不变）", () => {
  const base = {
    total: 5,
    passed: 4,
    passRate: 80,
    byFamily: { coding: { total: 5, passed: 4, passRate: 80, executionErrors: 0 } },
    trainRate: 80,
    heldOutRate: 80,
    generalizationRatio: 1,
    avgOutputLength: 50,
    executionErrors: 0,
    totalCostUsd: null,
    avgCostUsd: null,
    avgPromptTokens: null,
    avgCompletionTokens: null,
    totalCacheHitTokens: null,
    avgCacheHitTokens: null,
  };

  it("有分位时在同一行展示 p50/p95/p99，前缀 `- 平均延迟:` 保持不变", () => {
    const summary = {
      ...base,
      avgLatencyMs: 300,
      latencyP50: 300,
      latencyP95: 500,
      latencyP99: 500,
    };
    const md = toMarkdown(summary, [result(300)]);
    const line = md.split("\n").find((l) => l.startsWith("- 平均延迟:"))!;
    expect(line).toBe(`- 平均延迟: 300ms ｜ p50: 300ms ｜ p95: 500ms ｜ p99: 500ms ｜ 平均输出长度: 50`);
  });

  it("分位为 null 时显示 `-`（不写 ms）", () => {
    const summary = {
      ...base,
      avgLatencyMs: 100,
      latencyP50: 100,
      latencyP95: null,
      latencyP99: null,
    };
    const line = toMarkdown(summary, [result(100)]).split("\n").find((l) => l.startsWith("- 平均延迟:"))!;
    expect(line).toBe(`- 平均延迟: 100ms ｜ p50: 100ms ｜ p95: - ｜ p99: - ｜ 平均输出长度: 50`);
  });

  it("兼容红线：旧 summary（不含 latencyPxx 字段）显示 `-`，未新增行", () => {
    // 模拟旧调用方：直接构造的 summary 对象不含 latencyPxx（类型断言模拟运行时缺字段）
    const legacySummary = { ...base, avgLatencyMs: 300 } as unknown as MetricsSummary;
    const legacy = toMarkdown(legacySummary, [result(300)]);
    const line = legacy.split("\n").find((l) => l.startsWith("- 平均延迟:"))!;
    expect(line).toBe(`- 平均延迟: 300ms ｜ p50: - ｜ p95: - ｜ p99: - ｜ 平均输出长度: 50`);
    const explicitNull = toMarkdown(
      { ...base, avgLatencyMs: 300, latencyP50: null, latencyP95: null, latencyP99: null },
      [result(300)],
    );
    // 缺字段与显式 null 的行数一致（未新增行、未拆行）
    expect(legacy.split("\n")).toHaveLength(explicitNull.split("\n").length);
    expect(legacy).toBe(explicitNull);
  });

  it("概览行结构不变：仅一行延迟行，未新增行/未拆行", () => {
    const summary = { ...base, avgLatencyMs: 300, latencyP50: 300, latencyP95: 500, latencyP99: 500 };
    const lines = toMarkdown(summary, [result(300)]).split("\n");
    expect(lines.filter((l) => l.startsWith("- 平均延迟:"))).toHaveLength(1);
    expect(lines.some((l) => l.startsWith("## 分族结果"))).toBe(true);
  });
});
