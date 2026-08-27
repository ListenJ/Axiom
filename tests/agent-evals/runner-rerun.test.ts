/**
 * runner rerun 口径测试 — 评测统一默认 --rerun-each=2：
 * DEFAULT_RERUN_EACH=2（分数口径稳定可比）；pickBest 取首个通过、全败保留首次。
 */
import { describe, it, expect } from "bun:test";
import { DEFAULT_RERUN_EACH, pickBest } from "../../src/agent-evals/runner.js";
import type { TaskResult } from "../../src/agent-evals/metrics.js";

function result(passed: boolean, taskId = "T-01"): TaskResult {
  return { taskId, family: "coding", split: "held-out", passed, latencyMs: 100, outputLength: 10, model: "m" };
}

describe("评测统一口径 DEFAULT_RERUN_EACH", () => {
  it("默认重跑 2 次（消除单样本波动）", () => {
    expect(DEFAULT_RERUN_EACH).toBe(2);
  });
});

describe("pickBest 取最优", () => {
  it("任一通过取首个通过", () => {
    const fail = result(false);
    const pass = result(true);
    const attempts = [fail, pass, result(true)];
    expect(pickBest(attempts)).toBe(pass);
  });

  it("全失败保留首次（含失败原因）", () => {
    const first = result(false);
    const attempts = [first, result(false)];
    expect(pickBest(attempts)).toBe(first);
  });

  it("空列表返回 undefined（防御）", () => {
    expect(pickBest([])).toBeUndefined();
  });
});
