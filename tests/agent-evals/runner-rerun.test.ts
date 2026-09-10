/**
 * runner rerun 口径测试 — 评测统一默认 --rerun-each=2：
 * DEFAULT_RERUN_EACH=2（分数口径稳定可比）；pickBest 取首个通过、全败保留首次；
 * rerunAdaptive 自适应重跑（首次即通过则停）与跑满 rerunEach 次后 pickBest 结果完全一致。
 */
import { describe, it, expect } from "bun:test";
import { DEFAULT_RERUN_EACH, pickBest, rerunAdaptive } from "../../src/agent-evals/runner.js";
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

  it("全失败且含执行错误时优先保留真实能力失败（而非限流/传输执行错误）", () => {
    const execErr = { ...result(false), executionError: true };
    const realFail = result(false);
    // 真实能力失败在后的场景
    expect(pickBest([execErr, realFail])).toBe(realFail);
    // 真实能力失败在前的场景
    expect(pickBest([realFail, execErr])).toBe(realFail);
    // 全部是执行错误 → 保留首次
    expect(pickBest([execErr, { ...result(false), executionError: true }])).toBe(execErr);
  });

  it("空列表返回 undefined（防御）", () => {
    expect(pickBest([])).toBeUndefined();
  });
});

describe("rerunAdaptive 自适应重跑（省调用且结果与跑满 rerunEach 等价）", () => {
  // 记录 runOnce 被调用次数，验证「首次即通过不再重跑」
  function tracker(results: TaskResult[]) {
    let calls = 0;
    const runOnce = () => {
      const r = results[Math.min(calls, results.length - 1)];
      calls++;
      return Promise.resolve(r);
    };
    return { runOnce, calls: () => calls };
  }

  it("首次尝试即通过 → 只调用一次，结果 = 该通过（等价 pickBest 取首个通过）", async () => {
    const { runOnce, calls } = tracker([result(true)]);
    const best = await rerunAdaptive(runOnce, 2);
    expect(calls()).toBe(1);
    expect(best.passed).toBe(true);
  });

  it("首败后第二次通过（rerunEach=3）→ 在第 2 次通过处停止，结果 = 该通过", async () => {
    const { runOnce, calls } = tracker([result(false), result(true), result(false)]);
    const best = await rerunAdaptive(runOnce, 3);
    expect(calls()).toBe(2); // [fail, pass] → 第 2 次通过即停
    expect(best.passed).toBe(true);
  });

  it("全失败 → 跑满 rerunEach 次，保留首次（与 pickBest 全败语义一致）", async () => {
    const { runOnce, calls } = tracker([result(false), result(false)]);
    const best = await rerunAdaptive(runOnce, 2);
    expect(calls()).toBe(2);
    expect(best.passed).toBe(false);
  });

  it("rerunEach=1 → 只调用一次，即使失败也不重跑", async () => {
    const { runOnce, calls } = tracker([result(false)]);
    const best = await rerunAdaptive(runOnce, 1);
    expect(calls()).toBe(1);
    expect(best.passed).toBe(false);
  });

  it("全执行错误（无通过）→ 跑满 rerunEach 次，保留首次（限流等非能力失败不吞没真实失败）", async () => {
    const execErr = { ...result(false), executionError: true };
    const realFail = result(false);
    // 真实能力失败在后：跑满 3 次，pickBest 优先真实失败
    const a = tracker([execErr, execErr, realFail]);
    const bestA = await rerunAdaptive(a.runOnce, 3);
    expect(a.calls()).toBe(3);
    expect(bestA.executionError).toBeUndefined();
    // 全执行错误：跑满 2 次，保留首次
    const b = tracker([execErr, execErr]);
    const bestB = await rerunAdaptive(b.runOnce, 2);
    expect(b.calls()).toBe(2);
    expect(bestB.executionError).toBe(true);
  });
});
