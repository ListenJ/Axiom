/**
 * Step 3 回归：HTTP 请求面加固纯函数。
 *
 * 证据（OCR medium）：
 *   - src/main.ts:790 只 parseInt(Content-Length) 后比大小，缺头/chunked 被当 0 放行；
 *   - src/main.ts:841 metrics 直接用 url.pathname，UUID/数字段产生无界 series；
 *   - src/main.ts:850 500 响应合并 securityHeaders 而非 baseHeaders，丢 CORS。
 */
import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import {
  parseContentLength,
  validateRequestBodySize,
  normalizeMetricPath,
  mergeErrorHeaders,
} from "../../src/core/request-hardening.js";

describe("Step 3 — parseContentLength", () => {
  test("缺头/空/非数字/负数/小数 → null", () => {
    expect(parseContentLength(null)).toBeNull();
    expect(parseContentLength("")).toBeNull();
    expect(parseContentLength("abc")).toBeNull();
    expect(parseContentLength("-1")).toBeNull();
    expect(parseContentLength("12.5")).toBeNull();
  });

  test("合法非负整数 → number", () => {
    expect(parseContentLength("0")).toBe(0);
    expect(parseContentLength("123")).toBe(123);
    expect(parseContentLength(" 42 ")).toBe(42);
  });
});

describe("Step 3 — validateRequestBodySize", () => {
  test("非写方法不做 body 限制", () => {
    expect(validateRequestBodySize("GET", null, 1024).ok).toBe(true);
    expect(validateRequestBodySize("DELETE", null, 1024).ok).toBe(true);
  });

  test("写方法缺/非法 Content-Length → 411", () => {
    expect(validateRequestBodySize("POST", null, 1024)).toMatchObject({ ok: false, status: 411 });
    expect(validateRequestBodySize("PUT", "abc", 1024)).toMatchObject({ ok: false, status: 411 });
    expect(validateRequestBodySize("PATCH", "", 1024)).toMatchObject({ ok: false, status: 411 });
  });

  test("写方法超过上限 → 413；等于上限 → 放行", () => {
    expect(validateRequestBodySize("POST", "2048", 1024)).toMatchObject({ ok: false, status: 413 });
    expect(validateRequestBodySize("PUT", "1024", 1024).ok).toBe(true);
  });
});

describe("Step 3 — normalizeMetricPath", () => {
  test("UUID / 数字 / 长 hex 段归一为 :id，固定段不变", () => {
    expect(normalizeMetricPath("/api/resource/550e8400-e29b-41d4-a716-446655440000")).toBe("/api/resource/:id");
    expect(normalizeMetricPath("/api/users/123")).toBe("/api/users/:id");
    expect(normalizeMetricPath("/api/sessions/abcdef0123456789")).toBe("/api/sessions/:id");
    expect(normalizeMetricPath("/health")).toBe("/health");
    expect(normalizeMetricPath("/api/v1")).toBe("/api/v1");
  });
});

describe("Step 3 — mergeErrorHeaders", () => {
  test("保留 rate-limit 头，同时带上 baseHeaders（CORS/安全头）；base 优先", () => {
    const merged = mergeErrorHeaders(
      { "Retry-After": "1", "X-RateLimit-Remaining": "0" },
      { "Access-Control-Allow-Origin": "https://example.com", "Content-Type": "application/json" },
    );
    expect(merged["Retry-After"]).toBe("1");
    expect(merged["X-RateLimit-Remaining"]).toBe("0");
    expect(merged["Access-Control-Allow-Origin"]).toBe("https://example.com");
    expect(merged["Content-Type"]).toBe("application/json");
  });
});

describe("Step 3 — main.ts 接线", () => {
  test("main.ts 使用 request-hardening 且 500 路径使用 baseHeaders", () => {
    const src = readFileSync("src/main.ts", "utf8");
    expect(src).toContain("validateRequestBodySize(req.method");
    expect(src).toContain("normalizeMetricPath(url.pathname)");
    expect(src).toContain("mergeErrorHeaders(rl.headers, baseHeaders)");
    expect(src).not.toContain("{ ...rl.headers, ...securityHeaders }");
  });
});
