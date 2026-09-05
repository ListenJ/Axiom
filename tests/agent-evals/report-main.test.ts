/**
 * S5 报告落地补全 — 主报告（report.ts）失败聚类段。
 * 定位：对比 latency-percentile.test.ts（延迟行专属）、report-extras.test.ts（聚合视图函数）。
 * 此处为报告渲染层的「失败聚类」集成点：toMarkdown 追加聚类段、toJSON 带 failures 结构化字段、
 * 无失败轮次省略聚类段（输出逐字节不变的兼容红线）。
 */
import { describe, expect, it } from "bun:test";
import { toJSON, toMarkdown } from "../../src/agent-evals/report.js";
import type { MetricsSummary, TaskResult } from "../../src/agent-evals/metrics.js";

function makeTask(overrides: Partial<TaskResult> = {}): TaskResult {
  return {
    taskId: "T-01",
    family: "coding",
    split: "held-out",
    passed: true,
    latencyMs: 100,
    outputLength: 64,
    model: "test-model",
    ...overrides,
  };
}

function makeSummary(overrides: Partial<MetricsSummary> = {}): MetricsSummary {
  return {
    total: 2,
    passed: 1,
    passRate: 50,
    byFamily: { coding: { total: 2, passed: 1, passRate: 50, executionErrors: 0 } },
    trainRate: 0,
    heldOutRate: 50,
    generalizationRatio: null,
    avgLatencyMs: 100,
    latencyP50: null,
    latencyP95: null,
    latencyP99: null,
    avgOutputLength: 64,
    executionErrors: 0,
    totalCostUsd: null,
    avgCostUsd: null,
    avgPromptTokens: null,
    avgCompletionTokens: null,
    ...overrides,
  };
}

describe("toMarkdown 失败聚类段（S5 报告落地）", () => {
  it("有失败时追加 ## 失败聚类 段，含桶/数量/代表样例", () => {
    const results = [
      makeTask({ taskId: "T-01", passed: true }),
      makeTask({ taskId: "T-02", passed: false, reason: "empty response: 模型未返回任何内容", latencyMs: 200 }),
      makeTask({ taskId: "T-03", passed: false, reason: "HTTP 429 rate limit exceeded", latencyMs: 300 }),
    ];
    const md = toMarkdown(makeSummary({ total: 3, byFamily: { coding: { total: 3, passed: 1, passRate: 33, executionErrors: 0 } } }), results);
    expect(md).toContain("## 失败聚类");
    expect(md).toContain("| 桶 | 数量 | 代表样例 |");
    expect(md).toContain("内容缺失");
    expect(md).toContain("| 1");
    expect(md).toContain("empty response");
    expect(md).toContain("限流");
    expect(md).toContain("HTTP 429 rate limit exceeded");
  });

  it("无失败时省略聚类段（全绿轮次输出逐字节不变）", () => {
    const results = [makeTask({ passed: true }), makeTask({ taskId: "T-02", passed: true })];
    const md = toMarkdown(makeSummary({ passed: 2, passRate: 100, byFamily: { coding: { total: 2, passed: 2, passRate: 100, executionErrors: 0 } } }), results);
    expect(md).not.toContain("## 失败聚类");
    // 兼容红线：明细表与延迟行仍在
    expect(md).toContain("| ID | 族 | split | 通过 | 延迟(ms) | 模型 | 备注 |");
    expect(md).toContain("- 平均延迟:");
  });

  it("聚类段位于明细表之后（报告尾部，不打乱既有小节顺序）", () => {
    const results = [
      makeTask({ passed: true }),
      makeTask({ taskId: "T-02", passed: false, reason: "缺少关键内容: x" }),
    ];
    const md = toMarkdown(makeSummary({ byFamily: { coding: { total: 2, passed: 1, passRate: 50, executionErrors: 0 } } }), results);
    const clusteringIdx = md.indexOf("## 失败聚类");
    const detailIdx = md.indexOf("## 明细");
    const familyIdx = md.indexOf("## 分族结果");
    expect(clusteringIdx).toBeGreaterThan(detailIdx);
    expect(clusteringIdx).toBeGreaterThan(familyIdx);
  });
});

describe("toJSON failures 字段（S5 报告落地）", () => {
  it("输出带 failures 结构化字段（有失败时含聚类内容）", () => {
    const results = [
      makeTask({ passed: false, reason: "[ERROR] CONNECTION_RESET timeout" }),
      makeTask({ taskId: "T-02", passed: true }),
    ];
    const parsed = JSON.parse(toJSON(makeSummary({ byFamily: { coding: { total: 2, passed: 1, passRate: 50, executionErrors: 1 } } }), results)) as {
      summary: Record<string, unknown>;
      failures: Array<{ bucket: string; count: number; samples: string[] }>;
    };
    expect(parsed.summary).toBeTruthy();
    expect(Array.isArray(parsed.failures)).toBe(true);
    expect(parsed.failures.length).toBeGreaterThan(0);
    const execBucket = parsed.failures.find((f) => f.bucket === "执行错误");
    expect(execBucket).toBeTruthy();
    expect(execBucket!.count).toBe(1);
    expect(execBucket!.samples[0]).toContain("CONNECTION_RESET");
  });

  it("无失败时 failures 为空数组（结构化恒在）", () => {
    const parsed = JSON.parse(toJSON(makeSummary({ passed: 2, passRate: 100, byFamily: { coding: { total: 2, passed: 2, passRate: 100, executionErrors: 0 } } }), [makeTask({ passed: true }), makeTask({ taskId: "T-02", passed: true })])) as {
      failures: unknown;
    };
    expect(parsed.failures).toEqual([]);
  });
});