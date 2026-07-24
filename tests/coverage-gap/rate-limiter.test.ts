/**
 * 限流器测试 — 覆盖率空白补充
 *
 * 测试目标：RateLimiter / MultiDimensionLimiter / 中间件工厂
 * 测试维度：基础功能 / 边界条件 / 异常输入 / 高并发 / 兼容性
 *
 * 覆盖组件：src/utils/rate-limiter.ts
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  RateLimiter,
  MultiDimensionLimiter,
  createRateLimitMiddleware,
  createMultiDimensionMiddleware,
  extractUserKey,
  apiLimiter,
  multiDimLimiter,
} from "../../src/utils/rate-limiter.js";

// ═══════════════════════════════════════════════════════════════
// A. RateLimiter 基础功能
// ═══════════════════════════════════════════════════════════════

describe("A. RateLimiter 基础功能", () => {
  let limiter: RateLimiter;

  beforeEach(() => {
    limiter = new RateLimiter({ windowMs: 1000, maxRequests: 5 });
  });

  test("默认规则应允许在配额内的请求", () => {
    const r1 = limiter.check("user-1");
    expect(r1.allowed).toBe(true);
    expect(r1.remaining).toBe(4);
    expect(r1.resetAt).toBeGreaterThan(Date.now());
  });

  test("配额递减 — 每次 check 后 remaining 减少", () => {
    for (let i = 5; i > 0; i--) {
      const r = limiter.check("user-1");
      expect(r.allowed).toBe(true);
      expect(r.remaining).toBe(i - 1);
    }
  });

  test("超过配额应拒绝并返回 retryAfter", () => {
    for (let i = 0; i < 5; i++) limiter.check("user-1");
    const blocked = limiter.check("user-1");
    expect(blocked.allowed).toBe(false);
    expect(blocked.remaining).toBe(0);
    expect(blocked.retryAfter).toBeGreaterThanOrEqual(1);
    expect(blocked.resetAt).toBeGreaterThan(Date.now());
  });

  test("不同 key 独立计数", () => {
    for (let i = 0; i < 5; i++) limiter.check("user-A");
    const aBlocked = limiter.check("user-A");
    const bAllowed = limiter.check("user-B");
    expect(aBlocked.allowed).toBe(false);
    expect(bAllowed.allowed).toBe(true);
  });

  test("per-path 规则覆盖默认规则", () => {
    limiter.setRule("/web-search", { windowMs: 1000, maxRequests: 2 });
    const r1 = limiter.check("user-1", "/web-search");
    const r2 = limiter.check("user-1", "/web-search");
    const r3 = limiter.check("user-1", "/web-search");
    expect(r1.allowed).toBe(true);
    expect(r2.allowed).toBe(true);
    expect(r3.allowed).toBe(false);
    // 同用户访问其他路径仍按默认规则
    const rOther = limiter.check("user-1", "/other");
    expect(rOther.allowed).toBe(true);
  });

  test("窗口滚动 — 超过 windowMs 后配额恢复", async () => {
    const short = new RateLimiter({ windowMs: 50, maxRequests: 2 });
    short.check("k");
    short.check("k");
    expect(short.check("k").allowed).toBe(false);
    await new Promise((r) => setTimeout(r, 60));
    const after = short.check("k");
    expect(after.allowed).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════
// B. 边界条件
// ═══════════════════════════════════════════════════════════════

describe("B. RateLimiter 边界条件", () => {
  test("maxRequests=1 — 单次请求后即限流", () => {
    const lim = new RateLimiter({ windowMs: 1000, maxRequests: 1 });
    expect(lim.check("k").allowed).toBe(true);
    expect(lim.check("k").allowed).toBe(false);
  });

  test("maxRequests=0 — 立即限流", () => {
    const lim = new RateLimiter({ windowMs: 1000, maxRequests: 0 });
    const r = lim.check("k");
    // maxRequests=0 时 length(0) >= 0 为 true，立即拒绝
    expect(r.allowed).toBe(false);
  });

  test("windowMs 极小（1ms）— 快速恢复", async () => {
    const lim = new RateLimiter({ windowMs: 1, maxRequests: 1 });
    lim.check("k");
    expect(lim.check("k").allowed).toBe(false);
    await new Promise((r) => setTimeout(r, 5));
    expect(lim.check("k").allowed).toBe(true);
  });

  test("窗口边界 — 恰好在边界上的请求被清理", async () => {
    const lim = new RateLimiter({ windowMs: 50, maxRequests: 2 });
    lim.check("k");
    await new Promise((r) => setTimeout(r, 30));
    lim.check("k");
    // 第 3 次应该被拒绝（窗口内已有 2 个）
    expect(lim.check("k").allowed).toBe(false);
    // 等待窗口完全滚动
    await new Promise((r) => setTimeout(r, 30));
    expect(lim.check("k").allowed).toBe(true);
  });

  test("cleanup 清除过期状态", async () => {
    const lim = new RateLimiter({ windowMs: 50, maxRequests: 5 });
    lim.check("k1");
    lim.check("k2");
    // 等待窗口过期 2 倍
    await new Promise((r) => setTimeout(r, 120));
    lim.cleanup();
    // cleanup 后状态被清除，新请求重新计数
    const r = lim.check("k1");
    expect(r.remaining).toBe(4); // 5-1
  });

  test("getHeaders 正确生成限流头", () => {
    const lim = new RateLimiter({ windowMs: 1000, maxRequests: 5 });
    const r = lim.check("k");
    const headers = lim.getHeaders(r);
    expect(headers["X-RateLimit-Remaining"]).toBe("4");
    expect(headers["X-RateLimit-Reset"]).toMatch(/^\d+$/);
    expect(headers["Retry-After"]).toBeUndefined();

    // 限流后应有 Retry-After
    for (let i = 0; i < 4; i++) lim.check("k");
    const blocked = lim.check("k");
    const blockedHeaders = lim.getHeaders(blocked);
    expect(blockedHeaders["Retry-After"]).toMatch(/^\d+$/);
  });
});

// ═══════════════════════════════════════════════════════════════
// C. 异常输入处理
// ═══════════════════════════════════════════════════════════════

describe("C. RateLimiter 异常输入", () => {
  test("空字符串 key 应被接受（不崩溃）", () => {
    const lim = new RateLimiter({ windowMs: 1000, maxRequests: 1 });
    const r = lim.check("");
    expect(r.allowed).toBe(true);
  });

  test("undefined path 应回退到默认规则", () => {
    const lim = new RateLimiter({ windowMs: 1000, maxRequests: 1 });
    const r = lim.check("k", undefined);
    expect(r.allowed).toBe(true);
  });

  test("不存在的 path 应回退到默认规则", () => {
    const lim = new RateLimiter({ windowMs: 1000, maxRequests: 1 });
    const r = lim.check("k", "/non-existent");
    expect(r.allowed).toBe(true);
  });

  test("超长 key 应正常工作", () => {
    const lim = new RateLimiter({ windowMs: 1000, maxRequests: 1 });
    const longKey = "x".repeat(10_000);
    const r = lim.check(longKey);
    expect(r.allowed).toBe(true);
  });

  test("特殊字符 key 应正常工作", () => {
    const lim = new RateLimiter({ windowMs: 1000, maxRequests: 2 });
    const keys = ["user@domain.com", "192.168.1.1", "key with spaces", "key\nwith\nnewlines", "中文密钥"];
    for (const k of keys) {
      expect(lim.check(k).allowed).toBe(true);
    }
  });
});

// ═══════════════════════════════════════════════════════════════
// D. 高并发场景
// ═══════════════════════════════════════════════════════════════

describe("D. RateLimiter 高并发", () => {
  test("1000 并发 check — 不超过 maxRequests", () => {
    const lim = new RateLimiter({ windowMs: 10_000, maxRequests: 100 });
    const results = Array.from({ length: 1000 }, () => lim.check("concurrent-user"));
    const allowed = results.filter((r) => r.allowed).length;
    const blocked = results.filter((r) => !r.allowed).length;
    expect(allowed).toBe(100);
    expect(blocked).toBe(900);
  });

  test("多用户并发 — 各自独立限流", () => {
    const lim = new RateLimiter({ windowMs: 10_000, maxRequests: 10 });
    const results: boolean[] = [];
    for (let u = 0; u < 100; u++) {
      for (let i = 0; i < 10; i++) {
        results.push(lim.check(`user-${u}`).allowed);
      }
    }
    const allowed = results.filter(Boolean).length;
    expect(allowed).toBe(1000); // 每用户 10 次，100 用户
  });

  test("cleanup 在大量 key 下性能稳定", () => {
    const lim = new RateLimiter({ windowMs: 1000, maxRequests: 5 });
    for (let i = 0; i < 10_000; i++) {
      lim.check(`user-${i}`);
    }
    const t0 = performance.now();
    lim.cleanup();
    const elapsed = performance.now() - t0;
    expect(elapsed).toBeLessThan(50);
  });
});

// ═══════════════════════════════════════════════════════════════
// E. MultiDimensionLimiter
// ═══════════════════════════════════════════════════════════════

describe("E. MultiDimensionLimiter 多维度限流", () => {
  let ml: MultiDimensionLimiter;

  beforeEach(() => {
    ml = new MultiDimensionLimiter({
      ip: { windowMs: 60_000, maxRequests: 5 },
      user: { windowMs: 60_000, maxRequests: 10 },
      global: { windowMs: 60_000, maxRequests: 1000 },
    });
  });

  test("三维度都通过时允许请求", () => {
    const r = ml.check("1.1.1.1", "user-hash-1");
    expect(r.allowed).toBe(true);
    expect(r.limitedDimension).toBeUndefined();
  });

  test("IP 维度超限 — limitedDimension=ip", () => {
    for (let i = 0; i < 5; i++) ml.check("1.1.1.1", "user-hash-1");
    const r = ml.check("1.1.1.1", "user-hash-1");
    expect(r.allowed).toBe(false);
    expect(r.limitedDimension).toBe("ip");
  });

  test("user 维度超限 — limitedDimension=user", () => {
    // 同一 user 从不同 IP 访问（绕过 IP 限流）
    for (let i = 0; i < 10; i++) ml.check(`ip-${i}`, "user-hash-1");
    const r = ml.check("ip-new", "user-hash-1");
    expect(r.allowed).toBe(false);
    expect(r.limitedDimension).toBe("user");
  });

  test("global 维度超限 — limitedDimension=global", () => {
    const small = new MultiDimensionLimiter({
      ip: { windowMs: 60_000, maxRequests: 10000 },
      user: { windowMs: 60_000, maxRequests: 10000 },
      global: { windowMs: 60_000, maxRequests: 3 },
    });
    small.check("ip-1", "u-1");
    small.check("ip-2", "u-2");
    small.check("ip-3", "u-3");
    const r = small.check("ip-4", "u-4");
    expect(r.allowed).toBe(false);
    expect(r.limitedDimension).toBe("global");
  });

  test("未认证请求（无 userKey）只走 IP + global", () => {
    const r = ml.check("1.1.1.1");
    expect(r.allowed).toBe(true);
    // 未认证请求不应触发 user 维度限流
    for (let i = 0; i < 20; i++) {
      ml.check("1.1.1.1"); // 无 userKey
    }
    // IP 维度超限
    const blocked = ml.check("1.1.1.1");
    expect(blocked.allowed).toBe(false);
    expect(blocked.limitedDimension).toBe("ip");
  });

  test("返回最小 remaining", () => {
    // IP 配额 5，user 配额 10 → 走 1 次后 remaining 应为 4（IP 更小）
    const r = ml.check("1.1.1.1", "user-1");
    expect(r.remaining).toBe(4);
  });

  test("setRule 应用到所有维度", () => {
    ml.setRule("/strict", { windowMs: 60_000, maxRequests: 1 });
    const r1 = ml.check("1.1.1.1", "user-1", "/strict");
    const r2 = ml.check("1.1.1.1", "user-1", "/strict");
    expect(r1.allowed).toBe(true);
    expect(r2.allowed).toBe(false);
    // check 顺序为 global → ip → user，setRule 应用到所有维度，
    // 所以 global 维度（配额也是 1）先触发
    expect(r2.limitedDimension).toBe("global");
  });

  test("getHeaders 生成正确头", () => {
    const r = ml.check("1.1.1.1", "user-1");
    const headers = ml.getHeaders(r);
    expect(headers["X-RateLimit-Remaining"]).toBe("4");
    expect(headers["X-RateLimit-Reset"]).toMatch(/^\d+$/);
  });
});

// ═══════════════════════════════════════════════════════════════
// F. 中间件工厂 + Request 兼容性
// ═══════════════════════════════════════════════════════════════

describe("F. 限流中间件", () => {
  test("createRateLimitMiddleware — 从 Request 提取 IP", async () => {
    const lim = new RateLimiter({ windowMs: 1000, maxRequests: 5 });
    const mw = createRateLimitMiddleware(lim);
    const req = new Request("https://example.com/api", {
      headers: { "x-real-ip": "203.0.113.1" },
    });
    const result = await mw(req);
    expect(result.allowed).toBe(true);
    expect(result.headers["X-RateLimit-Remaining"]).toBeDefined();
  });

  test("createRateLimitMiddleware — 优先使用传入的 socket IP", async () => {
    const lim = new RateLimiter({ windowMs: 1000, maxRequests: 1 });
    const mw = createRateLimitMiddleware(lim);
    const req = new Request("https://example.com/api", {
      headers: { "x-real-ip": "spoofed-ip" },
    });
    // 传入的 ip 参数应优先于可伪造的 header
    const r1 = await mw(req, "real-socket-ip");
    const r2 = await mw(req, "real-socket-ip");
    expect(r1.allowed).toBe(true);
    expect(r2.allowed).toBe(false);
  });

  test("createMultiDimensionMiddleware — 提取 userKey", async () => {
    const ml = new MultiDimensionLimiter({
      ip: { windowMs: 1000, maxRequests: 100 },
      user: { windowMs: 1000, maxRequests: 100 },
      global: { windowMs: 1000, maxRequests: 1000 },
    });
    const mw = createMultiDimensionMiddleware(ml);
    const req = new Request("https://example.com/api", {
      headers: { "x-api-key": "sk-test-key-12345" },
    });
    const result = await mw(req, "1.2.3.4");
    expect(result.allowed).toBe(true);
  });

  test("extractUserKey — 从 x-api-key 提取", () => {
    const req = new Request("https://example.com", {
      headers: { "x-api-key": "sk-1234567890abcdef" },
    });
    const key = extractUserKey(req);
    expect(key).toBeDefined();
    expect(key).toHaveLength(16); // sha256 前 16 字符
    expect(key).toMatch(/^[0-9a-f]{16}$/);
  });

  test("extractUserKey — 从 Authorization: Bearer 提取", () => {
    const req = new Request("https://example.com", {
      headers: { authorization: "Bearer sk-bearer-token-xyz" },
    });
    const key = extractUserKey(req);
    expect(key).toBeDefined();
    expect(key).toMatch(/^[0-9a-f]{16}$/);
  });

  test("extractUserKey — 无认证头返回 undefined", () => {
    const req = new Request("https://example.com");
    expect(extractUserKey(req)).toBeUndefined();
  });

  test("extractUserKey — 相同 key 产生相同 hash（确定性）", () => {
    const req1 = new Request("https://example.com", {
      headers: { "x-api-key": "sk-same-key" },
    });
    const req2 = new Request("https://example.com", {
      headers: { "x-api-key": "sk-same-key" },
    });
    expect(extractUserKey(req1)).toBe(extractUserKey(req2));
  });

  test("extractUserKey — 不同 key 产生不同 hash", () => {
    const req1 = new Request("https://example.com", {
      headers: { "x-api-key": "sk-key-1" },
    });
    const req2 = new Request("https://example.com", {
      headers: { "x-api-key": "sk-key-2" },
    });
    expect(extractUserKey(req1)).not.toBe(extractUserKey(req2));
  });
});

// ═══════════════════════════════════════════════════════════════
// G. 全局单例
// ═══════════════════════════════════════════════════════════════

describe("G. 全局单例", () => {
  test("apiLimiter 已配置默认规则", () => {
    expect(apiLimiter).toBeDefined();
    // 默认规则 100/min
    const r = apiLimiter.check("singleton-test-key-" + Date.now());
    expect(r.allowed).toBe(true);
  });

  test("multiDimLimiter 可用", () => {
    expect(multiDimLimiter).toBeDefined();
    const r = multiDimLimiter.check("singleton-test-ip-" + Date.now(), "singleton-test-user-" + Date.now());
    expect(r.allowed).toBe(true);
  });
});
