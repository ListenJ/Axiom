import { describe, expect, it } from "bun:test";
import { summarize, type TaskResult } from "../../src/agent-evals/metrics.js";

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
});
