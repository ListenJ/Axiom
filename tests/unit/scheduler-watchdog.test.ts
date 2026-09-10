/**
 * Scheduler 运行中任务看门狗回归测试（审计 M2）
 *
 * 行为规格：
 * 1. 运行中（running）任务超过 deadline 必须被看门狗终结为 failed，
 *    释放并发槽位 —— 不得永久占坑（旧实现只巡检排队队列）。
 * 2. 无 deadline / 未到期的运行任务不受影响。
 * 3. 被看门狗终结的任务再调用 complete/fail 为无害 no-op。
 */
import { describe, test, expect, beforeEach } from "bun:test";
import { scheduler } from "../../src/dre/runtime/scheduler.js";

describe("scheduler running-deadline 看门狗（M2 回归）", () => {
  beforeEach(() => scheduler.reset());

  test("超期 running 任务被终结并释放槽位", () => {
    const t1 = scheduler.submit({ name: "keep", priority: "high", payload: {}, maxRetries: 0, dependencies: [] });
    const t2 = scheduler.submit({
      name: "hang",
      priority: "normal",
      payload: {},
      maxRetries: 0,
      dependencies: [],
      deadline: Date.now() + 60_000,
    });

    const r1 = scheduler.getNext();
    const r2 = scheduler.getNext();
    expect(r1?.id).toBe(t1.id);
    expect(r2?.id).toBe(t2.id);
    expect(scheduler.getStatus().running).toBe(2);

    // 模拟时间流逝：hang 任务已超期
    t2.deadline = Date.now() - 1;

    // 任一次调度触发看门狗巡检
    scheduler.getNext();

    const after = scheduler.getTask(t2.id);
    expect(after?.status).toBe("failed");
    expect(after?.error).toContain("deadline");
    expect(scheduler.getStatus().running).toBe(1); // 仅剩 keep
  });

  test("未到期/无 deadline 的 running 任务不受影响；终结后再 complete 为 no-op", () => {
    const alive = scheduler.submit({ name: "alive-nodl", priority: "normal", payload: {}, maxRetries: 0, dependencies: [] });
    const doomed = scheduler.submit({ name: "doomed", priority: "normal", payload: {}, maxRetries: 0, dependencies: [], deadline: Date.now() + 60_000 });
    const future = scheduler.submit({ name: "future", priority: "low", payload: {}, maxRetries: 0, dependencies: [], deadline: Date.now() + 60_000 });

    scheduler.getNext(); // alive
    const rFuture = scheduler.getNext(); // future (low 在 alive 后)
    void doomed; // 仍在排队

    future.deadline = Date.now() - 1;
    scheduler.getNext(); // 触发巡检

    expect(scheduler.getTask(alive.id)?.status).toBe("running");
    expect(scheduler.getTask(future.id)?.status).toBe("failed");

    // 对已终结任务重复终态操作必须无害
    expect(() => scheduler.complete(future.id, {})).not.toThrow();
    expect(() => scheduler.fail(future.id, "again")).not.toThrow();
    expect(scheduler.getTask(future.id)?.status).toBe("failed");
    void rFuture;
  });
});
