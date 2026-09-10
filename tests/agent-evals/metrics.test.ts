import { describe, expect, it } from "bun:test";
import { summarize, hasCapabilityFailure, type TaskResult } from "../../src/agent-evals/metrics.js";

const result = (
  taskId: string,
  family: TaskResult["family"],
  split: TaskResult["split"],
  passed: boolean,
): TaskResult => ({ taskId, family, split, passed, latencyMs: 100, outputLength: 50 });

describe("metrics summarize", () => {
  it("computes global and per-family pass rates", () => {
    const s = summarize([
      result("a", "coding", "train", true),
      result("b", "coding", "train", false),
      result("c", "knowledge", "held-out", true),
    ]);
    expect(s.total).toBe(3);
    expect(s.passed).toBe(2);
    expect(s.passRate).toBe(66.7);
    expect(s.byFamily.coding.passRate).toBe(50);
    expect(s.byFamily.knowledge.passRate).toBe(100);
  });

  it("computes held-out generalization ratio", () => {
    const s = summarize([
      result("a", "coding", "train", true),
      result("b", "coding", "train", true),
      result("c", "coding", "held-out", true),
      result("d", "coding", "held-out", false),
    ]);
    expect(s.trainRate).toBe(100);
    expect(s.heldOutRate).toBe(50);
    expect(s.generalizationRatio).toBe(0.5);
  });

  it("handles empty results", () => {
    const s = summarize([]);
    expect(s.total).toBe(0);
    expect(s.passRate).toBe(0);
    expect(s.generalizationRatio).toBeNull();
  });

  it("execution errors are counted separately and excluded from capability pass rate", () => {
    const mk = (
      taskId: string,
      family: TaskResult["family"],
      passed: boolean,
      executionError?: boolean,
    ): TaskResult => ({ taskId, family, split: "held-out", passed, executionError, latencyMs: 100, outputLength: 41 });
    const s = summarize([
      mk("a", "coding", true),
      mk("b", "coding", false),
      mk("c", "coding", false, true),
      mk("d", "coding", false, true),
    ]);
    // 总任务数含执行错误；执行错误单独统计
    expect(s.total).toBe(4);
    expect(s.executionErrors).toBe(2);
    // 能力通过率分母排除执行错误：1 / (4-2) = 50%
    expect(s.passRate).toBe(50);
    // 分族同口径
    expect(s.byFamily.coding.total).toBe(4);
    expect(s.byFamily.coding.executionErrors).toBe(2);
    expect(s.byFamily.coding.passRate).toBe(50);
  });

  it("all-execution-error run yields passRate 0 (no division by zero)", () => {
    const s = summarize([
      { taskId: "x", family: "coding", split: "held-out", passed: false, executionError: true, latencyMs: 100, outputLength: 41 },
    ]);
    expect(s.total).toBe(1);
    expect(s.executionErrors).toBe(1);
    expect(s.passRate).toBe(0);
  });

  it("passed=true + executionError=true 异常组合不计入全局 passed（与分族口径一致）", () => {
    const s = summarize([
      { taskId: "a", family: "coding", split: "held-out", passed: true, executionError: true, latencyMs: 100, outputLength: 41 },
      { taskId: "b", family: "coding", split: "held-out", passed: false, latencyMs: 100, outputLength: 41 },
    ]);
    // 唯一「通过」的样本其实是执行错误：能力通过数应为 0，分母剔除后 passRate 0%
    expect(s.executionErrors).toBe(1);
    expect(s.passed).toBe(0);
    expect(s.passRate).toBe(0);
    expect(s.byFamily.coding.passed).toBe(0);
    expect(s.byFamily.coding.passRate).toBe(0);
  });
});

describe("metrics hasCapabilityFailure（run.ts 退出码口径，执行错误不计失败）", () => {
  it("纯执行错误的任务不构成能力失败", () => {
    expect(
      hasCapabilityFailure([
        { taskId: "a", family: "coding", split: "held-out", passed: false, executionError: true, latencyMs: 100, outputLength: 41 },
        { taskId: "b", family: "coding", split: "held-out", passed: true, latencyMs: 100, outputLength: 41 },
      ]),
    ).toBe(false);
  });

  it("存在真实能力失败（非执行错误）时为 true", () => {
    expect(
      hasCapabilityFailure([
        { taskId: "a", family: "coding", split: "held-out", passed: false, latencyMs: 100, outputLength: 41 },
        { taskId: "b", family: "coding", split: "held-out", passed: true, latencyMs: 100, outputLength: 41 },
      ]),
    ).toBe(true);
  });

  it("空结果不为失败", () => {
    expect(hasCapabilityFailure([])).toBe(false);
  });
});
