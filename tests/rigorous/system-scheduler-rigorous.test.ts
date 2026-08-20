import { describe, test, expect, beforeEach } from "bun:test";
import { getResourceBudgetManager } from "../../src/dre/system-resource.js";
import { scheduler } from "../../src/dre/runtime/scheduler.js";

describe("严苛：VRAM Budget 边界与确定性回放", () => {
  beforeEach(() => {
    scheduler.reset();
    // 恢复默认 4000
    getResourceBudgetManager().updateResource({ maxMemory: 4000, availableMemory: 4000 });
    // 防抖 <5% 可能保留旧值，需强制大步恢复
    const mgr = getResourceBudgetManager();
    mgr.updateResource({ availableMemory: 4000 });
  });

  test("5次同输入回放：canRun 与 recommendedMaxTokens 必须一致", () => {
    const mgr = getResourceBudgetManager();
    mgr.updateResource({ availableMemory: 2000 });
    const results = Array.from({ length: 5 }, () => mgr.canRun());
    for (let i = 1; i < results.length; i++) {
      expect(results[i].canRun).toBe(results[0].canRun);
      expect(results[i].recommendedMaxTokens).toBe(results[0].recommendedMaxTokens);
    }
    // 2000MB: availableForKV=900, 900*1024/229376≈4, 可运行且 token>0 即可，数值随实现校准
    expect(results[0].canRun).toBe(true);
    expect(results[0].recommendedMaxTokens).toBeGreaterThan(0);
  });

  test("边界：availableMemory 精确等于 required (1300) 应可运行，1299 不可", () => {
    const mgr = getResourceBudgetManager();
    // 先强制大值避免防抖
    mgr.updateResource({ maxMemory: 4000, availableMemory: 4000 });
    // 直接构造小预算管理器绕过防抖验证原始逻辑
    const { ResourceBudgetManager } = require("../../src/dre/system-resource.js");
    const m1 = new ResourceBudgetManager({ resource: { maxMemory: 4000, availableMemory: 1300, maxCompute: 100, availableCompute: 100, source: "test" } });
    const m2 = new ResourceBudgetManager({ resource: { maxMemory: 4000, availableMemory: 1299, maxCompute: 100, availableCompute: 100, source: "test" } });
    expect(m1.canRun().canRun).toBe(true);
    expect(m2.canRun().canRun).toBe(false);
    // 1300时 availableForKV=200, 200*1024/229376=0, 允许为0（边界），仅验证可运行性
    expect(m1.canRun().recommendedMaxTokens).toBeGreaterThanOrEqual(0);
  });

  test("非法输入：负数/NaN 必须抛错而非静默", () => {
    const mgr = getResourceBudgetManager();
    expect(() => mgr.updateResource({ availableMemory: -1 as any })).toThrow();
    expect(() => mgr.updateResource({ availableMemory: NaN as any })).toThrow();
    expect(() => mgr.updateResource({ maxMemory: 0 as any })).toThrow();
    expect(() => mgr.updateResource({ maxMemory: NaN as any })).toThrow();
  });

  test("防抖：<5% 抖动被过滤，≥5% 通过", () => {
    const mgr = getResourceBudgetManager();
    mgr.updateResource({ availableMemory: 2000 });
    const before = mgr.getResource().availableMemory;
    mgr.updateResource({ availableMemory: 2099 }); // +4.95% <5% 过滤
    expect(mgr.getResource().availableMemory).toBe(before);
    mgr.updateResource({ availableMemory: 2100 }); // +5% 通过
    expect(mgr.getResource().availableMemory).toBe(2100);
  });

  test("recommendedMaxTokens 随 available 线性：2000 vs 4000 差约2倍", () => {
    const { ResourceBudgetManager } = require("../../src/dre/system-resource.js");
    const mk = (avail: number) => new ResourceBudgetManager({ resource: { maxMemory: 4000, availableMemory: avail, maxCompute: 100, availableCompute: 100, source: "t" } }).canRun().recommendedMaxTokens!;
    const a2000 = mk(2000);
    const a4000 = mk(4000);
    expect(a4000).toBeGreaterThan(a2000);
    expect(a4000 / a2000).toBeGreaterThan(1.8);
    expect(a4000 / a2000).toBeLessThan(3.5);
  });

  test("并发：100 并发 updateResource 不崩且最终为合法值", async () => {
    const mgr = getResourceBudgetManager();
    const vals = Array.from({ length: 100 }, (_, i) => 1500 + (i % 5) * 10);
    await Promise.all(vals.map(v => Promise.resolve().then(() => {
      try { mgr.updateResource({ availableMemory: v }); } catch {}
    })));
    const cur = mgr.getResource().availableMemory;
    expect(cur).toBeGreaterThanOrEqual(1500);
    expect(cur).toBeLessThanOrEqual(1540);
  });
});

describe("严苛：Scheduler 限流与抢占", () => {
  beforeEach(() => {
    scheduler.reset();
    getResourceBudgetManager().updateResource({ maxMemory: 4000, availableMemory: 4000 });
  });

  test("maxConcurrentTasks=5 严格：6并发第6应为null", () => {
    for (let i = 0; i < 5; i++) {
      scheduler.submit({ name: `t${i}`, priority: "normal", payload: {}, dependencies: [], maxRetries: 0 });
      expect(scheduler.getNext()).not.toBeNull();
    }
    scheduler.submit({ name: "t5", priority: "normal", payload: {}, dependencies: [], maxRetries: 0 });
    expect(scheduler.getNext()).toBeNull();
  });

  test("优先级：critical 抢占 low/background", () => {
    // 填满 5 slots，含 2 个可抢占
    for (let i = 0; i < 3; i++) {
      scheduler.submit({ name: `n${i}`, priority: "normal", payload: {}, dependencies: [], maxRetries: 0 });
      scheduler.getNext();
    }
    scheduler.submit({ name: "low1", priority: "low", payload: {}, dependencies: [], maxRetries: 0 });
    scheduler.getNext();
    scheduler.submit({ name: "bg1", priority: "background", payload: {}, dependencies: [], maxRetries: 0 });
    scheduler.getNext();
    // 队列满
    scheduler.submit({ name: "crit", priority: "critical", payload: {}, dependencies: [], maxRetries: 0 });
    // getNext 应抢占
    const nxt = scheduler.getNext();
    expect(nxt).not.toBeNull();
    expect(nxt!.priority).toBe("critical");
  });

  test("deadline 已过应自动失败并从队列移除", async () => {
    const t = scheduler.submit({ name: "dead", priority: "normal", payload: {}, dependencies: [], maxRetries: 0, deadline: Date.now() - 10 });
    // getNext 会触发 expire
    const n = scheduler.getNext();
    // deadline 任务已被移至 completed，无论 n 是否为 dead
    expect(scheduler.getTask(t.id)?.status).toBe("failed");
    expect(scheduler.getStatus().completed).toBeGreaterThan(0);
  });

  test("notBefore 退避：未到时间不调度", () => {
    const t = scheduler.submit({ name: "retry", priority: "normal", payload: {}, dependencies: [], maxRetries: 2 });
    const first = scheduler.getNext()!;
    scheduler.fail(first.id, "err");
    // 立即取应为 null（退避 100ms）
    expect(scheduler.getNext()).toBeNull();
  });

  test("依赖：未满足依赖不调度", () => {
    const a = scheduler.submit({ name: "A", priority: "high", payload: {}, dependencies: [], maxRetries: 0 });
    scheduler.submit({ name: "B", priority: "critical", payload: {}, dependencies: [a.id], maxRetries: 0 });
    const n1 = scheduler.getNext();
    expect(n1!.name).toBe("A");
    // B 依赖 A 未完成，不应被调度
    expect(scheduler.getNext()).toBeNull();
    scheduler.complete(n1!.id, {});
    const n2 = scheduler.getNext();
    expect(n2!.name).toBe("B");
  });

  test("资源不足：availableMemory 100 应阻塞调度", () => {
    getResourceBudgetManager().updateResource({ availableMemory: 100 });
    scheduler.submit({ name: "blocked", priority: "normal", payload: {}, dependencies: [], maxRetries: 0 });
    expect(scheduler.getNext()).toBeNull();
    getResourceBudgetManager().updateResource({ availableMemory: 4000 });
  });

  test("并发提交：100 任务按优先级有序出队", () => {
    scheduler.reset();
    const priors: Array<"critical"|"high"|"normal"|"low"|"background"> = ["background","low","normal","high","critical"];
    for (let i = 0; i < 100; i++) {
      scheduler.submit({ name: `t${i}`, priority: priors[i % 5], payload: {}, dependencies: [], maxRetries: 0 });
    }
    const order: string[] = [];
    let t;
    // 依次取 5 个并发槽，完成后继续取
    while ((t = scheduler.getNext()) !== null) {
      order.push(t.priority);
      scheduler.complete(t.id, {});
      if (order.length >= 20) break;
    }
    // 前 20 应以 critical/high 为主
    const critHigh = order.filter(p => p === "critical" || p === "high").length;
    expect(critHigh).toBeGreaterThan(8);
  });

  test("确定性：同优先级提交顺序应稳定", () => {
    scheduler.reset();
    for (let i = 0; i < 5; i++) scheduler.submit({ name: `s${i}`, priority: "normal", payload: {}, dependencies: [], maxRetries: 0 });
    const seq1: string[] = [];
    while (true) { const t = scheduler.getNext(); if (!t) break; seq1.push(t.name); scheduler.complete(t.id, {}); }
    scheduler.reset();
    for (let i = 0; i < 5; i++) scheduler.submit({ name: `s${i}`, priority: "normal", payload: {}, dependencies: [], maxRetries: 0 });
    const seq2: string[] = [];
    while (true) { const t = scheduler.getNext(); if (!t) break; seq2.push(t.name); scheduler.complete(t.id, {}); }
    expect(seq1).toEqual(seq2);
  });
});
