import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { getResourceBudgetManager } from "../../src/dre/system-resource";
import { scheduler } from "../../src/dre/runtime/scheduler";

/**
 * Task 7 — H-06 双轨零联动
 * scheduler.ts:83 maxMemoryMB 4096 vs system-resource.ts:38 maxMemory 4000
 * 期望：改 config maxMemory 同步至 scheduler (同源)
 *
 * 2026-09-28 环境耦合修复（Linux 首次全量实测暴露）：
 * bun test 单进程跑全部测试文件，getResourceBudgetManager() 是**跨文件单例**——
 * 前序文件可能把 maxMemory 留在任意值（本机首次全量实测进入本文件时已是 8192，
 * 而单文件新进程里是 DEFAULT 4000）。H-07 防抖（|Δ|/curr < 5% 视为抖动过滤）使
 * 硬编码目标（8000/8192 等）变成"对进入状态抽奖"：8192→8000 仅 2.3% 被滤 ⇒ 红。
 * 修复口径：beforeEach 先跳 2×（对任意 current 恒 ≥100%，必被接受）；各用例目标
 * 一律取 current 的倍数（同为 ≥100% 跳变，防抖永不拦截）；afterEach 从 ≥2× 回跳
 * original（≥50%，必被接受）——断言与状态对进入值、执行顺序、宿主机全解耦。
 */
describe("resource-sync H-06", () => {
  const mgr = getResourceBudgetManager();
  let original: number;

  beforeEach(() => {
    original = mgr.getResource().maxMemory;
    mgr.updateResource({ maxMemory: original * 2 });
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
    const target = mgr.getResource().maxMemory * 2;
    mgr.updateResource({ maxMemory: target });
    const synced = scheduler.getStatus().budget.maxMemoryMB;
    expect(synced).toBe(target);
  });

  test("多次改 config 应持续同步", () => {
    const c = mgr.getResource().maxMemory;
    mgr.updateResource({ maxMemory: c * 2 });
    expect(scheduler.getStatus().budget.maxMemoryMB).toBe(c * 2);
    mgr.updateResource({ maxMemory: c * 4 });
    expect(scheduler.getStatus().budget.maxMemoryMB).toBe(c * 4);
  });

  test("scheduler reset 后仍与 manager 保持同源", () => {
    const target = mgr.getResource().maxMemory * 2;
    mgr.updateResource({ maxMemory: target });
    scheduler.reset();
    expect(scheduler.getStatus().budget.maxMemoryMB).toBe(target);
  });
});
