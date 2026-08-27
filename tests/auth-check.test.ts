/**
 * auth-check 单元测试 —— P0 认证绕过修复的回归防线。
 *
 * 背景：main.ts 曾用 `new URL(req.url).hostname`（即客户端可伪造的 Host
 * header）判定 isLocal，远程攻击者 `Host: localhost` 即可免认证调用全部
 * API。修复后 isLocal 只由 socket 对端地址得出（isLocalAddress），
 * checkApiKey 不再自行解读 Host。
 */
import { describe, it, expect } from "bun:test";
import { isLocalAddress, checkApiKey } from "../src/utils/auth-check.js";

const KEY = "test-token-0123456789abcdef0123456789abcdef";

describe("isLocalAddress", () => {
  it("识别各种回环地址形式", () => {
    expect(isLocalAddress("127.0.0.1")).toBe(true);
    expect(isLocalAddress("::1")).toBe(true);
    expect(isLocalAddress("::ffff:127.0.0.1")).toBe(true);
  });

  it("拒绝非回环与缺失地址", () => {
    expect(isLocalAddress("192.168.2.121")).toBe(false);
    expect(isLocalAddress("10.0.0.1")).toBe(false);
    expect(isLocalAddress("::ffff:192.168.1.1")).toBe(false);
    expect(isLocalAddress("")).toBe(false);
    expect(isLocalAddress(undefined)).toBe(false);
  });
});

describe("checkApiKey", () => {
  it("回环请求一律放行（本地开发 / E2E）", () => {
    expect(checkApiKey(new Request("http://x/chat"), true, KEY)).toBe(true);
    expect(checkApiKey(new Request("http://x/chat"), true, "")).toBe(true);
  });

  it("未配置 token 时 fail-closed，拒绝远程 API 请求", () => {
    expect(checkApiKey(new Request("http://x/chat"), false, "")).toBe(false);
    expect(checkApiKey(new Request("http://x/system/state"), false, "")).toBe(false);
  });

  it("公共路径与真实静态资源免认证", () => {
    expect(checkApiKey(new Request("http://x/health"), false, "")).toBe(true);
    expect(checkApiKey(new Request("http://x/"), false, KEY)).toBe(true);
    expect(checkApiKey(new Request("http://x/assets/index-abc.js"), false, KEY)).toBe(true);
    expect(checkApiKey(new Request("http://x/favicon.ico"), false, KEY)).toBe(true);
  });

  it("P0 回归：URL 中的 Host 不影响判定（isLocal 只能来自 socket）", () => {
    // 伪造 Host: localhost 的远程请求（isLocal=false）必须被拒绝
    expect(checkApiKey(new Request("http://localhost/chat"), false, KEY)).toBe(false);
    expect(checkApiKey(new Request("http://127.0.0.1/chat"), false, KEY)).toBe(false);
    expect(checkApiKey(new Request("http://localhost/chat"), false, "")).toBe(false);
    // 同一 URL 在 socket 判定为本地时才放行
    expect(checkApiKey(new Request("http://localhost/chat"), true, KEY)).toBe(true);
  });

  it("动态 .json/.txt 路由不享受静态豁免", () => {
    expect(checkApiKey(new Request("http://x/traces/abc123.json"), false, KEY)).toBe(false);
    expect(checkApiKey(new Request("http://x/vault/tags/todo.txt"), false, KEY)).toBe(false);
    expect(checkApiKey(new Request("http://x/traces/abc123.json", { headers: { "x-api-key": KEY } }), false, KEY)).toBe(true);
  });

  it("/ws 仅精确匹配豁免，前缀相似路径不豁免", () => {
    expect(checkApiKey(new Request("http://x/ws"), false, KEY)).toBe(true);
    expect(checkApiKey(new Request("http://x/wsanything"), false, KEY)).toBe(false);
  });

  it("x-api-key 与 Bearer 两种凭据均支持，错误凭据拒绝", () => {
    expect(checkApiKey(new Request("http://x/chat", { headers: { "x-api-key": KEY } }), false, KEY)).toBe(true);
    expect(checkApiKey(new Request("http://x/chat", { headers: { authorization: `Bearer ${KEY}` } }), false, KEY)).toBe(true);
    expect(checkApiKey(new Request("http://x/chat", { headers: { "x-api-key": "wrong" } }), false, KEY)).toBe(false);
    expect(checkApiKey(new Request("http://x/chat", { headers: { authorization: "Bearer wrong" } }), false, KEY)).toBe(false);
  });
});
