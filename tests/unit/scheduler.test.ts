/**
 * Task 6: scheduler memory throttling H-M2-05
 * memoryMB 永远为0 导致限流形同虚设 — TDD Red-Green
 * 修复前应 FAIL（hasResources 恒 true，currentMemoryMB 恒0），修复后 PASS
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { scheduler } from "../../src/dre/runtime/scheduler";
import { getResourceBudgetManager } from "../../src/dre/system-resource";

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

  test("maxMemoryMB 默认 4096 且可配置", () => {
    scheduler.reset();
    const statusBefore = scheduler.getStatus();
    expect(statusBefore.budget.maxMemoryMB).toBe(4096);
    scheduler.setBudget({ maxMemoryMB: 8192 });
    const statusAfter = scheduler.getStatus();
    expect(statusAfter.budget.maxMemoryMB).toBe(8192);
    // 恢复
    scheduler.setBudget({ maxMemoryMB: 4096 });
  });
});
