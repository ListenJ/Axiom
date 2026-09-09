/**
 * S-A8 切片 9：soak top-K 排序一致性断言增强（S-A7 报告遗留）
 *
 * 计划口径（docs/superpowers/plans/2026-09-08-sa8-validation-pipeline-test-plan.md 第三节切片 9）：
 * - 真实 embedding 可用（环境有 key）时：runSoakSession 叠加 top-K 排序一致性断言
 *   （top-1 命中植入锚词）——经 SoakSessionConfig.topKProbe 注入；
 * - 无 key 环境：断言 SKIP 且理由落报告（沿用 dual-probe SKIP 有因惯例）；
 * - 本轮不因增强而破坏 m3-7 的 4/4 全绿。
 *
 * 确定性：测试注入确定性探针假件（恒命中/恒不命中/不可用三件套），
 * 探针接线逻辑本身即被测行为；真实 embedding 探针由生产环境注入，零网络。
 */
import { describe, expect, it } from "bun:test";
import {
  applyDeterministicEnv,
  runSoakSession,
  assertTopKConsistency,
} from "../../scripts/soak/soak-core.js";

applyDeterministicEnv();

describe("S-A8 切片 9：soak top-K 排序一致性断言（S-A7 遗留）", () => {
  it("无探针（默认无 key 环境）→ SKIP 有因，断言零违例", async () => {
    const result = await runSoakSession({ rounds: 12, seed: 42, budgetTokens: 3000 });
    expect(result.topK.status).toBe("skipped");
    expect(result.topK.skipReason).toBeTruthy();
    expect(result.topK.rate).toBeNull();
    expect(result.topK.planted).toBe(0);
    expect(assertTopKConsistency(result)).toEqual([]);
  });

  it("探针可用（注入确定性假件恒命中）→ evaluated + top-1 命中率 1，零违例", async () => {
    const result = await runSoakSession({
      rounds: 12,
      seed: 42,
      budgetTokens: 3000,
      topKProbe: {
        isAvailable: () => true,
        top1: (anchor) => anchor.startsWith("soak-anchor-"),
      },
    });
    expect(result.topK.status).toBe("evaluated");
    expect(result.topK.planted).toBeGreaterThanOrEqual(1);
    expect(result.topK.top1Hits).toBe(result.topK.planted);
    expect(result.topK.rate).toBe(1);
    expect(result.topK.skipReason).toBeNull();
    expect(assertTopKConsistency(result)).toEqual([]);
  });

  it("探针可用但 top-1 恒不命中 → 违例 top1-rate-below-threshold", async () => {
    const result = await runSoakSession({
      rounds: 12,
      seed: 42,
      budgetTokens: 3000,
      topKProbe: { isAvailable: () => true, top1: () => false },
    });
    expect(result.topK.status).toBe("evaluated");
    expect(result.topK.rate).toBe(0);
    const violations = assertTopKConsistency(result);
    expect(violations.length).toBe(1);
    expect(violations[0]!.kind).toBe("top1-rate-below-threshold");
    expect(violations[0]!.misses).toBe(result.topK.planted - result.topK.top1Hits);
  });

  it("探针不可用（isAvailable=false）→ SKIP 有因（embedding 不可用），零违例", async () => {
    const result = await runSoakSession({
      rounds: 12,
      seed: 42,
      budgetTokens: 3000,
      topKProbe: { isAvailable: () => false, top1: () => true },
    });
    expect(result.topK.status).toBe("skipped");
    expect(result.topK.skipReason).toContain("不可用");
    expect(assertTopKConsistency(result)).toEqual([]);
  });
});
