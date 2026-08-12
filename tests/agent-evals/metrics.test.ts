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
});
