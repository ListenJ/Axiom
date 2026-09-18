/**
 * SharedBlackboard 缓存语义测试（Fix 5）。
 * expireTime === 0 表示“永不过期”，但此前 syncToCache/storeEntry 会把
 * 0 - Date.now()（负数）或未传 TTL 给 cache.set，触发默认 1h TTL，
 * 导致永不过期事实被缓存层 1h 后淘汰。修复：将 expireTime===0 映射为缓存的
 * 永不过期哨兵 ttlMs=0（cache.ts 语义：ttlMs===0 → NO_EXPIRY）。
 */

import { describe, expect, it } from "bun:test";
import { SharedBlackboard } from "../../src/memory/blackboard.js";

describe("SharedBlackboard 永不过期条目的缓存语义（Fix 5）", () => {
  it("expireTime===0 的条目 storeEntry 后缓存 expiresAt 为永不淘汰", () => {
    const bb = new SharedBlackboard({ persistent: false, redis: false }) as any;
    bb.write("fact.forever", "always-true", "session-a", { confidence: 0.99 });

    const cache = (bb as any).cache;
    const fullKey = cache.key("fact.forever");
    const entry = (cache.store as Map<string, { expiresAt: number; value: unknown }>).get(fullKey);
    expect(entry).toBeDefined();
    // 永不过期：expiresAt 应远大于当前时间（即 NO_EXPIRY 区间），而不是落在 1h 默认 TTL 附近
    expect(entry!.expiresAt).toBeGreaterThan(Date.now() + 24 * 60 * 60 * 1000);
    // cache 存储整个 BlackboardEntry 对象作为 value
    expect((entry!.value as { value: unknown }).value).toBe("always-true");
  });

  it("syncToCache 对永不过期条目使用永不淘汰 TTL", () => {
    const bb = new SharedBlackboard({ persistent: false, redis: false }) as any;
    // expireTime===0 表示永不过期
    bb.write("fact.forever2", { value: 42 }, "session-b");
    bb.syncToCache("fact.forever2");

    const cache = (bb as any).cache;
    const fullKey = cache.key("fact.forever2");
    const entry = (cache.store as Map<string, { expiresAt: number }>).get(fullKey);
    expect(entry).toBeDefined();
    // 不得是约 1h 后的默认 TTL（那意味着永不过期被错判为 1h 过期）
    const defaultTtlWindow = 60 * 60 * 1000; // 1h
    expect(Math.abs(entry!.expiresAt - (Date.now() + defaultTtlWindow))).toBeGreaterThan(10 * 60 * 1000);
    expect(entry!.expiresAt).toBeGreaterThan(Date.now() + 24 * 60 * 60 * 1000);
  });

  it("有过期时间的条目仍按相对 TTL 写入缓存（非永不过期语义不受影响）", () => {
    const bb = new SharedBlackboard({ persistent: false, redis: false }) as any;
    const expiresAtMs = Date.now() + 5 * 60 * 1000; // 5 分钟后过期
    bb.write("fact.temporary", "temp-value", "session-c", { expireMs: 5 * 60 * 1000 });
    bb.syncToCache("fact.temporary");

    const cache = (bb as any).cache;
    const fullKey = cache.key("fact.temporary");
    const entry = (cache.store as Map<string, { expiresAt: number }>).get(fullKey);
    expect(entry).toBeDefined();
    // 应在 5 分钟过期窗口附近（允许 ±10s 时钟抖动）
    expect(entry!.expiresAt).toBeGreaterThan(Date.now() + 4 * 60 * 1000);
    expect(entry!.expiresAt).toBeLessThan(Date.now() + 6 * 60 * 1000);
  });
});
