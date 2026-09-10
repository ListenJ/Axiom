/**
 * CDP 端点安全守卫回归测试（审计 M7）
 *
 * 行为规格：
 * 1. 未提供 cdpUrl 时回退默认回环端点 http://127.0.0.1:9222。
 * 2. 默认仅允许回环地址（127.0.0.1 / localhost / ::1）；远程地址必须显式放行。
 * 3. 仅允许 http/https 协议；畸形输入拒绝。
 */
import { describe, test, expect } from "bun:test";
import { assertSafeCdpUrl, DEFAULT_CDP_URL } from "../../src/utils/url-safety.js";

describe("assertSafeCdpUrl（M7 回归）", () => {
  test("未提供时回退默认回环端点", () => {
    expect(assertSafeCdpUrl(undefined)).toBe(DEFAULT_CDP_URL);
    expect(assertSafeCdpUrl(null)).toBe(DEFAULT_CDP_URL);
    expect(assertSafeCdpUrl("")).toBe(DEFAULT_CDP_URL);
    expect(assertSafeCdpUrl("   ")).toBe(DEFAULT_CDP_URL);
  });

  test("回环地址默认放行", () => {
    expect(assertSafeCdpUrl("http://127.0.0.1:9222")).toContain("127.0.0.1");
    expect(assertSafeCdpUrl("http://localhost:9222")).toContain("localhost");
    expect(assertSafeCdpUrl("http://[::1]:9222")).toContain("[::1]");
    expect(assertSafeCdpUrl("http://127.0.0.2:9223")).toBeDefined(); // 127/8 均为回环
  });

  test("远程地址默认拒绝，显式 allowRemote 才放行", () => {
    expect(() => assertSafeCdpUrl("http://192.168.0.150:9222")).toThrow(/remote cdpUrl blocked/i);
    expect(() => assertSafeCdpUrl("https://example.com:9222")).toThrow(/remote cdpUrl blocked/i);
    expect(() =>
      assertSafeCdpUrl("http://192.168.0.150:9222", { allowRemote: true }),
    ).not.toThrow();
  });

  test("非 http(s) 协议拒绝", () => {
    expect(() => assertSafeCdpUrl("file:///c:/windows/win.ini")).toThrow(/protocol/i);
    expect(() => assertSafeCdpUrl("ftp://127.0.0.1:21")).toThrow(/protocol/i);
  });

  test("畸形输入拒绝", () => {
    expect(() => assertSafeCdpUrl("not-a-url")).toThrow();
    expect(() => assertSafeCdpUrl("http://")).toThrow();
  });
});
