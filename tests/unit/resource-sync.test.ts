import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { getResourceBudgetManager } from "../../src/dre/system-resource";
import { scheduler } from "../../src/dre/runtime/scheduler";

/**
 * Task 7 — H-06 双轨零联动
 * scheduler.ts:83 maxMemoryMB 4096 vs system-resource.ts:38 maxMemory 4000
 * 期望：改 config maxMemory 同步至 scheduler (同源)
 */
describe("resource-sync H-06", () => {
  const mgr = getResourceBudgetManager();
  let original: number;

  beforeEach(() => {
    original = mgr.getResource().maxMemory;
    scheduler.reset();
  });

  afterEach(() => {
    mgr.updateResource({ maxMemory: original });
    scheduler.reset();
  });

  test("初始值应与 SystemResource 同源 (scheduler maxMemoryMB === manager maxMemory)", () => {
    const expected = mgr.getResource().maxMemory;
    const actual = scheduler.getStatus().budget.maxMemoryMB;
    // 当前双轨 4096 vs 4000 应 FAIL，修复后 PASS
    expect(actual).toBe(expected);
  });

  test("改 config maxMemory 同步至 scheduler", () => {
    mgr.updateResource({ maxMemory: 8000 });
    const synced = scheduler.getStatus().budget.maxMemoryMB;
    expect(synced).toBe(8000);
  });

  test("多次改 config 应持续同步", () => {
    mgr.updateResource({ maxMemory: 6000 });
    expect(scheduler.getStatus().budget.maxMemoryMB).toBe(6000);
    mgr.updateResource({ maxMemory: 2048 });
    expect(scheduler.getStatus().budget.maxMemoryMB).toBe(2048);
  });

  test("scheduler reset 后仍与 manager 保持同源", () => {
    mgr.updateResource({ maxMemory: 8192 });
    scheduler.reset();
    expect(scheduler.getStatus().budget.maxMemoryMB).toBe(8192);
  });
});
