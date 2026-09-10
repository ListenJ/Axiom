/**
 * S-A7 soak harness 冒烟测试（切片 1：预算断言）
 *
 * 计划口径（docs/superpowers/plans/2026-09-07-semantic-meaning-runtime-optimization-plan.md
 * 「M4 补」+ 执行修订记录第 3 条）：5 项崩坏断言先行针对现有组件
 * （context-manager compress/retrieve、sqlite-memory、KG 幂等）落地。
 *
 * 确定性保证：soak-core 在断言执行前清除 *_API_KEY env —— api-key-store
 * getEffectiveApiKey 每次动态读 process.env（无缓存），清空后 ContextManager
 * 的摘要/embedding 链全部走确定性 fallback（字符频率向量 + 规则摘要），零网络。
 */
import { describe, expect, it } from "bun:test";
import {
  applyDeterministicEnv,
  runSoakSession,
  assertBudgetPerRound,
  assertRecallConsistency,
  assertNoDuplicateWrites,
  runSoakInterruptRecovery,
  assertInterruptRecovery,
} from "../../scripts/soak/soak-core.js";

applyDeterministicEnv();

describe("S-A7 soak harness", () => {
  it("切片1：N 轮会话逐轮上下文 ≤ 预算（零违例）", async () => {
    const result = await runSoakSession({
      rounds: 30,
      seed: 42,
      budgetTokens: 3000,
    });

    // 预算断言：逐轮活跃上下文 token 不得超过预算
    const violations = assertBudgetPerRound(result);
    expect(violations).toEqual([]);

    // 会话确实发生了压缩（断言有意义的前提：压缩路径被触发过）
    expect(result.compressEvents).toBeGreaterThan(0);
    expect(result.rounds).toBe(30);
  });

  it("切片2：植入记忆存续率 ≥ 阈值", async () => {
    const result = await runSoakSession({
      rounds: 36,
      seed: 42,
      budgetTokens: 3000,
      recallThreshold: 0.9,
    });

    // 植入与检索确实发生了（断言有意义的前提）
    expect(result.recall.planted).toBeGreaterThanOrEqual(4);

    const violations = assertRecallConsistency(result);
    expect(violations).toEqual([]);
    expect(result.recall.rate).toBeGreaterThanOrEqual(0.9);
  });

  it("切片3：重复注入零重复 KG/Vault 写入", async () => {
    const result = await runSoakSession({
      rounds: 32,
      seed: 42,
      budgetTokens: 3000,
    });

    // 重复注入确实发生了（断言有意义的前提：≥3 个重复注入批次）
    expect(result.duplicateWrites.injections).toBeGreaterThanOrEqual(3);

    const violations = assertNoDuplicateWrites(result);
    expect(violations).toEqual([]);
  });

  it("切片4：中断-恢复可续（持久记忆存活 + 会话继续零异常）", async () => {
    const result = await runSoakInterruptRecovery({
      roundsBeforeInterrupt: 12,
      roundsAfterResume: 12,
      seed: 42,
      budgetTokens: 3000,
    });

    // 恢复确实发生了（断言有意义的前提：中断前植入过锚词、恢复后跑满了轮数）
    expect(result.interruptedAtRound).toBe(12);
    expect(result.anchorsPlantedBefore).toBeGreaterThanOrEqual(2);
    expect(result.perRoundTokensAfterResume.length).toBe(12);

    const violations = assertInterruptRecovery(result);
    expect(violations).toEqual([]);
  });
});
