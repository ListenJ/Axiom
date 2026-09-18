/**
 * Task 6: scheduler memory throttling H-M2-05（2026-09-18 改造）
 *
 * 内存准入数据源由 ResourceBudgetManager（已随 VRAM 管理子系统移除）改为
 * 进程堆占用；此处用 setBudget({ maxMemoryMB }) 直接驱动准入边界。
 * 修复前症状：hasResources 恒 true / currentMemoryMB 恒 0 → 限流形同虚设。
 */
import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { scheduler } from "../../src/dre/runtime/scheduler";
import { logger } from "../../src/utils/logger";

describe("scheduler memory throttling H-M2-05", () => {
  beforeEach(() => {
    scheduler.reset();
  });

  afterEach(() => {
    scheduler.reset();
  });

  test("maxMemoryMB 低于当前堆占用时应阻塞 getNext", () => {
    scheduler.setBudget({ maxMemoryMB: 1 });
    scheduler.submit({
      name: "mem-block",
      priority: "normal",
      payload: {},
      dependencies: [],
      maxRetries: 0,
    } as any);
    expect(scheduler.getNext()).toBeNull();
  });

  test("memory 充足时应放行 getNext", () => {
    scheduler.setBudget({ maxMemoryMB: 8192 });
    scheduler.submit({
      name: "mem-ok",
      priority: "normal",
      payload: {},
      dependencies: [],
      maxRetries: 0,
    } as any);
    const next = scheduler.getNext();
    expect(next).not.toBeNull();
    expect(next?.name).toBe("mem-ok");
  });

  test("currentMemoryMB 应反映真实堆占用而非恒0", () => {
    scheduler.setBudget({ maxMemoryMB: 8192 });
    scheduler.submit({
      name: "sync-check",
      priority: "normal",
      payload: {},
      dependencies: [],
      maxRetries: 0,
    } as any);
    scheduler.getNext();
    const status = scheduler.getStatus();
    expect(status.budget.currentMemoryMB).toBeGreaterThan(0);
  });

  test("maxMemoryMB 默认为 4096 且经 setBudget 可配置", () => {
    scheduler.reset();
    expect(scheduler.getStatus().budget.maxMemoryMB).toBe(4096);
    scheduler.setBudget({ maxMemoryMB: 8192 });
    expect(scheduler.getStatus().budget.maxMemoryMB).toBe(8192);
  });
});

describe("scheduler 代数守卫（审计整改 O4）", () => {
  test("抢占后 gen 自增；旧 gen 的 complete 被忽略不入队副作用", () => {
    scheduler.reset();
    scheduler.setBudget({ maxMemoryMB: 8192 });

    const low = scheduler.submit({ name: "low-o4", priority: "low", payload: {}, dependencies: [], maxRetries: 0 });
    const running = scheduler.getNext();
    expect(running?.id).toBe(low.id);

    const crit = scheduler.submit({ name: "crit-o4", priority: "critical", payload: {}, dependencies: [], maxRetries: 0 });
    // 内存预算收紧 + critical 等待 → 抢占 low 腾出槽位
    scheduler.setBudget({ maxMemoryMB: 1 });
    const next = scheduler.getNext();

    expect(next?.id).toBe(crit.id);
    expect(scheduler.getTask(low.id)?.status).toBe("pending"); // 重排队而非丢弃
    expect(scheduler.getTask(low.id)?.gen).toBe(1); // preemptOne 时 gen++

    // 陈旧完成（gen=0 快照）→ warn 且忽略，任务仍 pending
    const warnSpy = spyOn(logger, "warn");
    scheduler.complete(low.id, "stale-result", 0);
    expect(scheduler.getTask(low.id)?.status).toBe("pending");
    expect(warnSpy.mock.calls.some((c) => String(c[0]).includes("[Scheduler] stale complete ignored"))).toBe(true);
    warnSpy.mockRestore();

    // 正确代数的 complete 正常落账
    scheduler.complete(crit.id, "ok", 0);
    expect(scheduler.getTask(crit.id)?.status).toBe("completed");
  });

  test("running 无此 id 的 complete → warn 且不抛错", () => {
    scheduler.reset();
    const warnSpy = spyOn(logger, "warn");
    expect(() => scheduler.complete("ghost-id-o4", null)).not.toThrow();
    expect(warnSpy.mock.calls.some((c) => String(c[0]).includes("[Scheduler] stale complete ignored"))).toBe(true);
    warnSpy.mockRestore();
  });

  test("未传 gen 的 complete 保持向后兼容（直接按 id 完成）", () => {
    scheduler.reset();
    scheduler.setBudget({ maxMemoryMB: 8192 });
    const t = scheduler.submit({ name: "compat-o4", priority: "normal", payload: {}, dependencies: [], maxRetries: 0 });
    expect(scheduler.getNext()?.id).toBe(t.id);
    scheduler.complete(t.id, null); // 不带 gen —— 兼容既有调用方
    expect(scheduler.getTask(t.id)?.status).toBe("completed");
  });
});
