/**
 * 熔断器单元测试 — 开/合/半开状态机 + 防泄漏清理
 */
import { describe, expect, it } from "bun:test";
import { CircuitBreaker, routerBreaker } from "../src/utils/circuit-breaker.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("CircuitBreaker", () => {
  it("初始为闭合：allow=true", () => {
    const cb = new CircuitBreaker();
    expect(cb.allow("p/m")).toBe(true);
    expect(cb.stats().open).toBe(0);
  });

  it("连续失败达到阈值后打开：allow=false", () => {
    const cb = new CircuitBreaker({ failureThreshold: 3, cooldownMs: 60_000 });
    expect(cb.allow("p/m")).toBe(true);
    cb.recordFailure("p/m");
    cb.recordFailure("p/m");
    expect(cb.allow("p/m")).toBe(true); // 未达阈值
    cb.recordFailure("p/m");
    expect(cb.allow("p/m")).toBe(false); // 已打开
    expect(cb.stats().open).toBe(1);
  });

  it("冷却结束后半开放行并复位", async () => {
    const cb = new CircuitBreaker({ failureThreshold: 2, cooldownMs: 40 });
    cb.recordFailure("p/m");
    cb.recordFailure("p/m");
    expect(cb.allow("p/m")).toBe(false);
    await sleep(60);
    expect(cb.allow("p/m")).toBe(true);
    // 半开探测成功 → 复位
    cb.recordSuccess("p/m");
    expect(cb.stats().open).toBe(0);
  });

  it("成功即复位（不累积失败）", () => {
    const cb = new CircuitBreaker({ failureThreshold: 3 });
    cb.recordFailure("p/m");
    cb.recordFailure("p/m");
    cb.recordSuccess("p/m");
    cb.recordFailure("p/m");
    expect(cb.allow("p/m")).toBe(true);
  });

  it("不同 key 互不影响", () => {
    const cb = new CircuitBreaker({ failureThreshold: 1 });
    cb.recordFailure("a/x");
    expect(cb.allow("a/x")).toBe(false);
    expect(cb.allow("b/y")).toBe(true);
  });

  it("prune 清理过期条目（防 Map 无限增长）", async () => {
    const cb = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 1_000_000 });
    cb.recordFailure("old/key");
    expect(cb.stats().entries).toBe(1);
    await sleep(30);
    const removed = cb.prune(10);
    expect(removed).toBe(1);
    expect(cb.stats().entries).toBe(0);
  });

  it("reset 清空全部条目（测试隔离 / 运维复位）", () => {
    const cb = new CircuitBreaker({ failureThreshold: 1 });
    cb.recordFailure("a/x");
    cb.recordFailure("b/y");
    expect(cb.stats().entries).toBe(2);
    expect(cb.reset()).toBe(2);
    expect(cb.stats().entries).toBe(0);
    expect(cb.allow("a/x")).toBe(true);
  });

  it("全局单例 routerBreaker 可用", () => {
    expect(typeof routerBreaker.allow).toBe("function");
    expect(routerBreaker.stats().entries).toBeGreaterThanOrEqual(0);
  });
});