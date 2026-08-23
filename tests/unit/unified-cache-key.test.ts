/**
 * unified-search 缓存键强化回归测试（审计 L12a）
 *
 * 行为规格：
 * 1. 相同输入产出稳定键；不同输入不碰撞（500 组样本全唯一）。
 * 2. 键形如 cache_<32 位 hex>。
 */
import { describe, test, expect } from "bun:test";
import { strongCacheKey } from "../../src/crawl/unified-search.js";

describe("strongCacheKey（L12a 回归）", () => {
  test("相同输入稳定；不同输入不碰撞", () => {
    const k1 = strongCacheKey("q", ["a", "b"], 10, 0.5);
    expect(k1).toBe(strongCacheKey("q", ["a", "b"], 10, 0.5));
    const seen = new Set<string>();
    for (let i = 0; i < 500; i++) seen.add(strongCacheKey(`q${i}`, ["e"], i, i / 100));
    expect(seen.size).toBe(500);
  });

  test("输出形如 cache_<32hex>", () => {
    expect(strongCacheKey("x", [], 1, 0)).toMatch(/^cache_[0-9a-f]{32}$/);
  });
});
