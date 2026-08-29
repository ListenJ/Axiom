/**
 * 限流 Map cleanup 定时调度接线测试（B3-Medium，docs/reviews/2026-08-29-joint-verification-audit.md §4）
 *
 * 审计症状：security.ts:125 rateLimitStore 根本没有 cleanup；rate-limiter.ts:33 的
 * RateLimiter.cleanup 存在但全仓无调用 → 两个限流 Map 均无界增长。
 * 修复：两处均在模块加载时 setInterval 调度 cleanup（间隔与既有窗口 TTL 对齐，unref() 防驻留）。
 */
import { describe, it, expect } from "bun:test";
import fs from "fs";
import { RateLimiter } from "../src/utils/rate-limiter.js";

describe("限流 cleanup 调度静态断言（B3-Medium）", () => {
  it("rate-limiter.ts 定时调度 apiLimiter/multiDimLimiter.cleanup 且 unref 防驻留", () => {
    const src = fs.readFileSync("src/utils/rate-limiter.ts", "utf8");
    expect(src).toContain("setInterval");
    expect(src).toContain("apiLimiter.cleanup()");
    expect(src).toContain("multiDimLimiter.cleanup()");
    expect(src).toMatch(/\.unref\?\.\(\)|\.unref\(\)/);
    // 间隔与既有窗口 TTL 对齐（默认窗口 60s）
    expect(src).toMatch(/60_000|60000/);
  });

  it("security.ts 具备 cleanupRateLimitStore 且定时调度 + unref", () => {
    const src = fs.readFileSync("src/utils/security.ts", "utf8");
    expect(src).toContain("cleanupRateLimitStore");
    expect(src).toContain("setInterval");
    expect(src).toMatch(/\.unref\?\.\(\)|\.unref\(\)/);
    expect(src).toMatch(/60_000|60000/);
  });
});

describe("限流 cleanup 行为（B3-Medium）", () => {
  it("RateLimiter.cleanup 删除空闲 key（窗口外/空记录），保留活跃 key", () => {
    const limiter = new RateLimiter({ windowMs: 60_000, maxRequests: 10 });
    limiter.check("fresh");
    // 构造空闲与空记录 key（免等待真实窗口流逝）
    (limiter as unknown as { store: Map<string, { requests: number[] }> }).store.set("stale", {
      requests: [Date.now() - 10 * 60_000],
    });
    (limiter as unknown as { store: Map<string, { requests: number[] }> }).store.set("empty", {
      requests: [],
    });
    limiter.cleanup();
    const store = (limiter as unknown as { store: Map<string, { requests: number[] }> }).store;
    expect(store.has("stale")).toBe(false);
    expect(store.has("empty")).toBe(false);
    expect(store.has("fresh")).toBe(true);
  });

  it("cleanupRateLimitStore 删除超窗 entry，保留窗口内 entry", async () => {
    const mod = await import("../src/utils/security.js");
    mod.rateLimitStore.set("old", { timestamps: [Date.now() - 10 * 60_000] });
    mod.rateLimitStore.set("fresh", { timestamps: [Date.now()] });
    mod.cleanupRateLimitStore();
    expect(mod.rateLimitStore.has("old")).toBe(false);
    expect(mod.rateLimitStore.has("fresh")).toBe(true);
  });
});
