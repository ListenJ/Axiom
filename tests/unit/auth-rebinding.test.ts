/**
 * DNS 重绑定探针 — auth-check 单测（Slice1 Task1 紧反馈回路）
 *
 * 背景：第二轮动态验证实锤 P2/P6 通过 Host+Origin 同域伪造绕过 AXIOM_AUTH_TOKEN。
 * 本文件为 RED harness：P2 在修复前应 failing（返回 true 而期待 false），
 * 修复后（Task2 白名单化）应全部 passing。P1 无 Origin 放行为设计内预期。
 *
 * 参考：tests/unit/csrf-origin.test.ts（J-2 CSRF 防线）与
 *       tests/auth-check.test.ts（P0 回归）—— 本用例确保不回归其语义。
 * 运行：bun test tests/unit/auth-rebinding.test.ts -v
 */
import { describe, test, expect } from "bun:test";
import { checkApiKey } from "../../src/utils/auth-check.js";

function req(url: string, method: string, origin?: string): Request {
  const headers: Record<string, string> = {};
  if (origin) headers["origin"] = origin;
  return new Request(url, { method, headers });
}

describe("auth rebinding (P1-P3)", () => {
  const apiKey = "secret-token-123";

  test("P1 no Origin -> local bypass allows (design)", () => {
    expect(checkApiKey(req("http://127.0.0.1:18789/terminal/session", "POST"), true, apiKey)).toBe(true);
  });

  test("P2 rebinding Host r.evil.com +同域 Origin -> must deny even if isLocal true (current bug -> true, fix -> false)", () => {
    // Host via URL host, Origin same evil domain (no port)
    // 注意：当前实现对不带端口的 r.evil.com 已因 host 不等而拦截（false），
    // 但带端口的同源仍可绕过，见下一用例 P2b。
    const r = req("http://r.evil.com:18789/terminal/session", "POST", "http://r.evil.com");
    // 当前实现会返回 false（已拦截），修复后仍应为 false — 此用例验证端口不一致场景不回归
    expect(checkApiKey(r, true, apiKey)).toBe(false);
  });

  test("P2b rebinding with port-matched Origin -> must deny (real RCE vector, RED before fix)", () => {
    // 真实 DNS 重绑定：攻击页托管于 http://r.evil.com:18789，Origin 与目标均为 r.evil.com:18789
    // 当前实现 originHost === targetHost → 误判同源而放行（返回 true），修复后应为 false
    const r = req("http://r.evil.com:18789/terminal/session", "POST", "http://r.evil.com:18789");
    expect(checkApiKey(r, true, apiKey)).toBe(false);
  });

  test("P3 Origin != Host -> deny", () => {
    const r = req("http://127.0.0.1:18789/terminal/session", "POST", "http://evil.com");
    expect(checkApiKey(r, true, apiKey)).toBe(false);
  });

  test("P6 terminal input path with rebinding -> must deny", () => {
    const r = req("http://r.evil.com:18789/terminal/session/abc123/input", "POST", "http://r.evil.com:18789");
    expect(checkApiKey(r, true, apiKey, "/terminal/session/abc123/input")).toBe(false);
  });

  test("valid local Origin -> allow", () => {
    const r = req("http://127.0.0.1:18789/terminal/session", "POST", "http://127.0.0.1:18789");
    expect(checkApiKey(r, true, apiKey)).toBe(true);
  });
});
