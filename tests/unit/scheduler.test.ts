/**
 * Task 6: scheduler memory throttling H-M2-05
 * memoryMB 永远为0 导致限流形同虚设 — TDD Red-Green
 * 修复前应 FAIL（hasResources 恒 true，currentMemoryMB 恒0），修复后 PASS
 */
import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { scheduler } from "../../src/dre/runtime/scheduler";
import { getResourceBudgetManager } from "../../src/dre/system-resource";
import { logger } from "../../src/utils/logger";

describe("scheduler memory throttling H-M2-05", () => {
  let originalResource: ReturnType<typeof getResourceBudgetManager.prototype.getResource> | any;

  beforeEach(() => {
    scheduler.reset();
    const mgr = getResourceBudgetManager();
    originalResource = mgr.getResource();
  });

  afterEach(() => {
    scheduler.reset();
    const mgr = getResourceBudgetManager();
    try {
      mgr.updateResource({
        maxMemory: originalResource.maxMemory,
        availableMemory: originalResource.availableMemory,
        maxCompute: originalResource.maxCompute,
        availableCompute: originalResource.availableCompute,
        source: originalResource.source,
      });
    } catch {}
    // ensure budget reset to default
    scheduler.reset();
  });

  test("memoryMB 超限应阻塞 getNext (availableMemory 100)", () => {
    const mgr = getResourceBudgetManager();
    mgr.updateResource({ availableMemory: 100, maxMemory: 4000, source: "test" });
    scheduler.submit({
      name: "mem-block",
      priority: "normal",
      payload: {},
      dependencies: [],
      maxRetries: 0,
    } as any);
    const next = scheduler.getNext();
    // 修复前：hasResources 仅看 currentMemoryMB(0)<4096 恒 true → next !== null → FAIL
    // 修复后：系统可视内存不足 (canRun false) 或已用≈3900 → 应阻塞 → next === null → PASS
    expect(next).toBeNull();
  });

  test("memory 充足时应放行 getNext", () => {
    const mgr = getResourceBudgetManager();
    mgr.updateResource({ availableMemory: 4000, maxMemory: 4000, source: "test" });
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

  test("currentMemoryMB 应反映真实可用内存而非恒0", () => {
    const mgr = getResourceBudgetManager();
    mgr.updateResource({ availableMemory: 500, maxMemory: 4000, source: "test" });
    scheduler.submit({
      name: "sync-check",
      priority: "normal",
      payload: {},
      dependencies: [],
      maxRetries: 0,
    } as any);
    // getNext 会触发 hasResources 同步 currentMemoryMB
    scheduler.getNext();
    const status = scheduler.getStatus();
    // 修复前：currentMemoryMB 恒 0 → FAIL
    // 修复后：应为 max-available (≈3500) 或 heapUsed (>0) → PASS
    expect(status.budget.currentMemoryMB).toBeGreaterThan(0);
  });

  test("maxMemoryMB 默认与 ResourceBudgetManager 同源且可配置", () => {
    const mgr = getResourceBudgetManager();
    const expectedDefault = mgr.getResource().maxMemory;
    scheduler.reset();
    const statusBefore = scheduler.getStatus();
    expect(statusBefore.budget.maxMemoryMB).toBe(expectedDefault);
    scheduler.setBudget({ maxMemoryMB: 8192 });
    const statusAfter = scheduler.getStatus();
    expect(statusAfter.budget.maxMemoryMB).toBe(8192);
    // 恢复由 afterEach 统一处理（原始值回写），此处仅确保 scheduler 与 manager 同步
    expect(getResourceBudgetManager().getResource().maxMemory).toBe(8192);
  });
});

describe("scheduler 代数守卫（审计整改 O4）", () => {
  test("抢占后 gen 自增；旧 gen 的 complete 被忽略不入队副作用", () => {
    scheduler.reset();
    const mgr = getResourceBudgetManager();
    mgr.updateResource({ availableMemory: 4000, maxMemory: 4000, source: "o4-test" });

    const low = scheduler.submit({ name: "low-o4", priority: "low", payload: {}, dependencies: [], maxRetries: 0 });
    const running = scheduler.getNext();
    expect(running?.id).toBe(low.id);

    const crit = scheduler.submit({ name: "crit-o4", priority: "critical", payload: {}, dependencies: [], maxRetries: 0 });
    // 资源耗尽 + critical 等待 → 抢占 low 腾出槽位
    mgr.updateResource({ availableMemory: 100, maxMemory: 4000, source: "o4-test" });
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
    const mgr = getResourceBudgetManager();
    mgr.updateResource({ availableMemory: 4000, maxMemory: 4000, source: "o4-test" });
    const t = scheduler.submit({ name: "compat-o4", priority: "normal", payload: {}, dependencies: [], maxRetries: 0 });
    expect(scheduler.getNext()?.id).toBe(t.id);
    scheduler.complete(t.id, null); // 不带 gen —— 兼容既有调用方
    expect(scheduler.getTask(t.id)?.status).toBe("completed");
  });
});
