import { describe, it, expect } from "bun:test";
import {
  RUNTIME_METRICS,
  METRIC_BY_KEY,
  isCrossMachineGate,
  sameEnvironment,
  analyzeOverfitting,
  type EnvFingerprint,
  type RuntimeEvalRun,
} from "../../src/agent-evals/runtime-metrics.js";

function fp(over: Partial<EnvFingerprint> = {}): EnvFingerprint {
  return {
    os: "linux x64",
    arch: "x64",
    cpuModel: "Test CPU",
    cpuCount: 8,
    totalMemMb: 16384,
    runtime: "bun 1.4.2",
    models: ["siliconflow/zhipu/GLM-5.1"],
    capturedAt: "2026-01-01T00:00:00.000Z",
    ...over,
  };
}

function run(id: string, metrics: Record<string, number | null>, fingerprint = fp()): RuntimeEvalRun {
  return { runId: id, suiteId: "suite-A", fingerprint, metrics };
}

describe("Runtime 指标集（防过拟合）", () => {
  it("设备相关指标被明确标注，且不得作为跨机器门禁", () => {
    const latency = RUNTIME_METRICS.filter((m) => m.kind === "latency");
    expect(latency.length).toBeGreaterThan(0);
    for (const m of latency) {
      expect(m.deviceDependent).toBe(true);
      // 关键约束：设备相关指标不允许当跨机器门禁
      expect(isCrossMachineGate(m.key)).toBe(false);
    }
    // 能力/安全/搜索类必须可用于跨机器门禁
    expect(isCrossMachineGate("task.passRate.heldOut")).toBe(true);
    expect(isCrossMachineGate("safety.highRiskBlockRate")).toBe(true);
    expect(isCrossMachineGate("search.hitRate")).toBe(true);
  });

  it("指标集覆盖本 Runtime 特有的安全与搜索维度", () => {
    const kinds = new Set(RUNTIME_METRICS.map((m) => m.kind));
    expect(kinds.has("safety")).toBe(true);
    expect(kinds.has("search")).toBe(true);
    // 防过拟合的两个核心字段必须在
    expect(METRIC_BY_KEY["task.generalizationRatio"]).toBeDefined();
    expect(METRIC_BY_KEY["task.passRate.heldOut"]).toBeDefined();
  });

  it("同机指纹判定一致；跨机不一致", () => {
    expect(sameEnvironment(fp(), fp())).toBe(true);
    expect(sameEnvironment(fp(), fp({ cpuModel: "Other CPU" }))).toBe(false);
    expect(sameEnvironment(fp(), fp({ totalMemMb: 32768 }))).toBe(false);
  });

  it("train 远高于 held-out ⇒ 报高风险过拟合，且阻断固化约束", () => {
    const a = analyzeOverfitting([
      run("r1", { "task.passRate.train": 90, "task.passRate.heldOut": 60 }),
    ]);
    const sig = a.signals.find((s) => s.kind === "train-heldout-gap");
    expect(sig?.severity).toBe("high");
    expect(a.blockConstraint).toBe(true);
    expect(a.verdict).toContain("不要");
  });

  it("train/held-out 差距小 ⇒ 不报过拟合", () => {
    const a = analyzeOverfitting([
      run("r1", { "task.passRate.train": 80, "task.passRate.heldOut": 78 }),
      run("r2", { "task.passRate.train": 79, "task.passRate.heldOut": 77 }, fp({ models: ["x/y"] })),
    ]);
    expect(a.signals.some((s) => s.kind === "train-heldout-gap")).toBe(false);
  });

  it("只在一个模型配置上跑过 ⇒ 提示跨配置不足", () => {
    const a = analyzeOverfitting([
      run("r1", { "task.passRate.heldOut": 80 }),
      run("r2", { "task.passRate.heldOut": 80 }),
    ]);
    const sig = a.signals.find((s) => s.kind === "cross-config-divergence");
    expect(sig).toBeDefined();
    expect(sig!.detail).toContain("同一套模型配置");
  });

  it("跨配置分歧过大 ⇒ 提示该结论依配置而变", () => {
    const a = analyzeOverfitting([
      run("r1", { "search.hitRate": 90, "task.passRate.heldOut": 80 }, fp({ models: ["m1"] })),
      run("r2", { "search.hitRate": 30, "task.passRate.heldOut": 80 }, fp({ models: ["m2"] })),
    ]);
    const sig = a.signals.find(
      (s) => s.kind === "cross-config-divergence" && s.detail.includes("搜索命中率"),
    );
    expect(sig).toBeDefined();
  });

  it("同环境重跑抖动过大 ⇒ 提示该指标不能当门禁", () => {
    const a = analyzeOverfitting([
      run("r1", { "search.hitRate": 100 }, fp({ models: ["m1"] })),
      run("r2", { "search.hitRate": 50 }, fp({ models: ["m2"] })),
    ]);
    const sig = a.signals.find((s) => s.kind === "run-variance" && s.detail.includes("搜索命中率"));
    // 注意：这两次是同环境不同模型；run-variance 按"同环境"分组，因此会命中
    expect(sig).toBeDefined();
    expect(sig!.detail).toContain("不能作为门禁");
  });

  it("高危拦截率不足 100% ⇒ 报高风险安全回退", () => {
    const a = analyzeOverfitting([run("r1", { "safety.highRiskBlockRate": 80 })]);
    const sig = a.signals.find((s) => s.kind === "safety-regression");
    expect(sig?.severity).toBe("high");
    expect(a.blockConstraint).toBe(true);
  });

  it("题集不一致 ⇒ 结论无效并阻断", () => {
    const a = analyzeOverfitting([
      { ...run("r1", {}), suiteId: "suite-A" },
      { ...run("r2", {}), suiteId: "suite-B" },
    ]);
    expect(a.blockConstraint).toBe(true);
    expect(a.verdict).toContain("无法分析");
  });

  it("空输入不抛异常", () => {
    const a = analyzeOverfitting([]);
    expect(a.blockConstraint).toBe(true);
    expect(a.signals).toHaveLength(0);
  });

  it("总是给出设备相关指标的风险提示", () => {
    const a = analyzeOverfitting([run("r1", {})]);
    expect(a.signals.some((s) => s.kind === "device-threshold-risk")).toBe(true);
  });
});
