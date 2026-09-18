/**
 * Cache: stress tests for eviction and thundering-herd fix
 */
import { describe, it, expect } from "bun:test";
import { Cache } from "../src/utils/cache.js";

describe("Cache Stress", () => {
  it("get/set basic operations", () => {
    const c = new Cache({ maxSize: 10, defaultTtlMs: 60_000, redis: false });
    c.set("a", 1);
    expect(c.getSync("a")).toBe(1);
  });

  it("getOrSet thundering-herd: concurrent calls deduplicate factory", async () => {
    const c = new Cache({ maxSize: 100, defaultTtlMs: 60_000, redis: false });
    let callCount = 0;
    const factory = async () => {
      callCount++;
      await new Promise(r => setTimeout(r, 10));
      return "computed";
    };
    const results = await Promise.all([
      c.getOrSet("dedup-key", factory),
      c.getOrSet("dedup-key", factory),
      c.getOrSet("dedup-key", factory),
    ]);
    expect(callCount).toBe(1); // Deduped: only 1 factory call
    expect(results[0]).toBe("computed");
    expect(results[1]).toBe("computed");
  });

  it("evictLRU: maintains maxSize under pressure", () => {
    const c = new Cache({ maxSize: 5, defaultTtlMs: 60_000, redis: false });
    for (let i = 0; i < 100; i++) {
      c.set(`k${i}`, i);
    }
    // Should have at most 5 entries
    const stats = c.stats();
    expect(stats.size).toBeLessThanOrEqual(5);
  });

  it("ttl expiry: expired entries are removed", done => {
    const c = new Cache({ maxSize: 10, defaultTtlMs: 50, redis: false });
    c.set("exp", "val", 50);
    expect(c.getSync("exp")).toBe("val");
    setTimeout(() => {
      expect(c.getSync("exp")).toBeUndefined();
      done();
    }, 100);
  });

  it("stress: 1000 set/get operations", () => {
    const c = new Cache({ maxSize: 1000, defaultTtlMs: 60_000, redis: false });
    const start = performance.now();
    for (let i = 0; i < 1000; i++) {
      c.set(`s${i}`, { index: i, data: "x".repeat(100) });
    }
    let hits = 0;
    for (let i = 0; i < 1000; i++) {
      if (c.getSync(`s${i}`)) hits++;
    }
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(2000); // 2s for 2000 ops
    expect(hits).toBe(1000);
  });

  it("maxSize 1: only the latest entry survives", () => {
    const c = new Cache({ maxSize: 1, defaultTtlMs: 60_000, redis: false });
    c.set("a", 1);
    c.set("b", 2);
    c.set("c", 3);
    expect(c.getSync("a")).toBeUndefined();
    expect(c.getSync("b")).toBeUndefined();
    expect(c.getSync("c")).toBe(3);
  });
});
