/**
 * ADR-014 §7-1：自进化"观测 → 缺口"闭环（只报告，不自动注册）。
 *
 * - `no-provider`：某契约被检索过但无 provider（miss 计数）；
 * - `low-success`：有 provider、用量达阈值但成功率低于阈值；
 * - 分析是**只读**的：不注册、不改动 provider。
 */
import { describe, test, expect, beforeEach } from "bun:test";
import { capabilityRegistry, type CapabilityProvider } from "../../src/dre/runtime/capability-registry.js";

const base = (over: Partial<CapabilityProvider>): CapabilityProvider => ({
  id: "gap-1",
  name: "Gap Provider",
  type: "external",
  capabilities: ["analysis.summarization"],
  costPerCall: 0,
  avgLatencyMs: 5,
  reliability: 0.9,
  maxConcurrency: 2,
  metadata: {},
  ...over,
});

describe("ADR-014 §7-1 能力缺口分析（只观测/报告）", () => {
  beforeEach(() => capabilityRegistry.reset());

  test("no-provider 缺口：检索无 provider 的契约被记为缺口，且不自动注册", () => {
    expect(capabilityRegistry.select("code.review")).toBeNull(); // 触发一次 miss
    const gaps = capabilityRegistry.analyzeGaps();
    const g = gaps.find((x) => x.contract === "code.review" && x.kind === "no-provider");
    expect(g).toBeDefined();
    expect(g!.evidence.misses).toBeGreaterThanOrEqual(1);
    // 只报告：仍未注册任何 provider
    expect(capabilityRegistry.listByContract("code.review")).toHaveLength(0);
  });

  test("low-success 缺口：持续失败达到用量阈值后判为低成功率", async () => {
    capabilityRegistry.registerDynamicProvider(
      base({ placement: "periphery", isolation: "in-process", sideEffects: ["internal"], invoke: async () => { throw new Error("boom"); } }),
    );
    for (let i = 0; i < 5; i++) {
      await expect(capabilityRegistry.invokeCapability("analysis.summarization", {})).rejects.toThrow();
    }
    const gaps = capabilityRegistry.analyzeGaps({ minUsageForLowSuccess: 5, minSuccessRate: 0.5 });
    const g = gaps.find((x) => x.contract === "analysis.summarization" && x.kind === "low-success");
    expect(g).toBeDefined();
    expect(g!.evidence.usageCount).toBe(5);
    expect(g!.evidence.successRate).toBe(0);
  });

  test("成功率达标时不产生 low-success 缺口", async () => {
    capabilityRegistry.registerDynamicProvider(
      base({ placement: "periphery", isolation: "in-process", sideEffects: ["internal"], invoke: async () => ({ ok: true }) }),
    );
    for (let i = 0; i < 6; i++) await capabilityRegistry.invokeCapability("analysis.summarization", {});
    const gaps = capabilityRegistry.analyzeGaps({ minUsageForLowSuccess: 5, minSuccessRate: 0.5 });
    expect(gaps.some((x) => x.contract === "analysis.summarization" && x.kind === "low-success")).toBe(false);
  });

  test("reset 清空缺口观测", () => {
    capabilityRegistry.select("code.review");
    expect(capabilityRegistry.analyzeGaps().length).toBeGreaterThan(0);
    capabilityRegistry.reset();
    expect(capabilityRegistry.analyzeGaps()).toHaveLength(0);
  });
});
