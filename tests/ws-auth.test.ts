/**
 * WebSocket 升级鉴权判定测试（R-006 遗留闭环：远程 WS 鉴权通道）
 * 覆盖：header / query token / Sec-WebSocket-Protocol 子协议、回环放行、
 * fail-closed（未配置 token）、子协议前缀剥离与空 token 拒绝。
 */
import { describe, expect, it } from "bun:test";
import {
  checkWsUpgradeAuth,
  extractSubprotocolToken,
  WS_AUTH_SUBPROTOCOL,
  WS_AUTH_TOKEN_PROTOCOL_PREFIX,
} from "../src/utils/ws-auth.js";

const KEY = "s3cr3t-token";

function base(overrides: Record<string, unknown> = {}) {
  return {
    headerAuth: null,
    protocolHeader: null,
    queryToken: null,
    isLocal: false,
    apiKey: KEY,
    ...overrides,
  } as Parameters<typeof checkWsUpgradeAuth>[0];
}

describe("checkWsUpgradeAuth (R-006 远程 WS 鉴权)", () => {
  it("回环地址直接放行（无需凭证）", () => {
    expect(checkWsUpgradeAuth(base({ isLocal: true }))).toEqual({ ok: true });
  });

  it("远程经 header 凭证鉴权（x-api-key / Bearer 提取后的值）", () => {
    expect(checkWsUpgradeAuth(base({ headerAuth: KEY }))).toEqual({ ok: true });
  });

  it("远程经 URL query token 鉴权", () => {
    expect(checkWsUpgradeAuth(base({ queryToken: KEY }))).toEqual({ ok: true });
  });

  it("远程经 Sec-WebSocket-Protocol 子协议鉴权", () => {
    const protocolHeader = `${WS_AUTH_SUBPROTOCOL}, ${WS_AUTH_TOKEN_PROTOCOL_PREFIX}${KEY}`;
    expect(checkWsUpgradeAuth(base({ protocolHeader }))).toEqual({ ok: true });
  });

  it("多子协议混排时提取正确凭证", () => {
    const protocolHeader = `foo, ${WS_AUTH_TOKEN_PROTOCOL_PREFIX}${KEY}, bar`;
    expect(extractSubprotocolToken(protocolHeader)).toBe(KEY);
  });

  it("子协议前缀不匹配或 token 为空时拒绝", () => {
    expect(extractSubprotocolToken(`${WS_AUTH_SUBPROTOCOL}, other`)).toBeNull();
    expect(extractSubprotocolToken(WS_AUTH_TOKEN_PROTOCOL_PREFIX)).toBeNull();
    const res = checkWsUpgradeAuth(base({
      protocolHeader: `${WS_AUTH_SUBPROTOCOL}, ${WS_AUTH_TOKEN_PROTOCOL_PREFIX}`,
    }));
    expect(res).toEqual({ ok: false, reason: "invalid or missing API key" });
  });

  it("凭证错误时拒绝（header 与 query 通道）", () => {
    expect(checkWsUpgradeAuth(base({ headerAuth: "wrong" }))).toEqual({ ok: false, reason: "invalid or missing API key" });
    expect(checkWsUpgradeAuth(base({ queryToken: "wrong" }))).toEqual({ ok: false, reason: "invalid or missing API key" });
  });

  it("未配置 AXIOM_AUTH_TOKEN 时 fail-closed（远程一律拒绝）", () => {
    const res = checkWsUpgradeAuth(base({ apiKey: "", headerAuth: "anything" }));
    expect(res).toEqual({ ok: false, reason: "AXIOM_AUTH_TOKEN not configured" });
  });
});

describe("checkWsUpgradeAuth CSWSH 本地四态（S2）", () => {
  it("本地 + 无 Origin 头 → 放行（curl/wscat 等非浏览器客户端）", () => {
    expect(checkWsUpgradeAuth(base({ isLocal: true }))).toEqual({ ok: true });
    expect(checkWsUpgradeAuth(base({ isLocal: true, origin: null }))).toEqual({ ok: true });
  });

  it("本地 + 同源 Origin（origin 的 host:port == 请求 host:port）→ 放行", () => {
    const res = checkWsUpgradeAuth(base({
      isLocal: true,
      origin: "http://127.0.0.1:18789",
      host: "127.0.0.1:18789",
    }));
    expect(res).toEqual({ ok: true });
  });

  it("本地 + 跨源 Origin + 无 token → 拒绝", () => {
    const res = checkWsUpgradeAuth(base({
      isLocal: true,
      origin: "http://evil.example",
      host: "127.0.0.1:18789",
    }));
    expect(res.ok).toBe(false);
  });

  it("本地 + 跨源 Origin + 合法 token 子协议 → 放行", () => {
    const res = checkWsUpgradeAuth(base({
      isLocal: true,
      origin: "http://evil.example",
      host: "127.0.0.1:18789",
      protocolHeader: `${WS_AUTH_TOKEN_PROTOCOL_PREFIX}${KEY}`,
    }));
    expect(res).toEqual({ ok: true });
  });

  it("本地 + 跨源 Origin + 错误 token → 拒绝；Origin 解析失败 → 一律拒绝", () => {
    const wrongToken = checkWsUpgradeAuth(base({
      isLocal: true,
      origin: "http://evil.example",
      host: "127.0.0.1:18789",
      headerAuth: "wrong-token",
    }));
    expect(wrongToken.ok).toBe(false);

    const unparseableOrigin = checkWsUpgradeAuth(base({
      isLocal: true,
      origin: "not-a-valid-url",
      host: "127.0.0.1:18789",
    }));
    expect(unparseableOrigin.ok).toBe(false);
  });

  it("远程路径行为不变：不传 origin/host 时维持原有判定与 reason 文案", () => {
    expect(checkWsUpgradeAuth(base({}))).toEqual({ ok: false, reason: "invalid or missing API key" });
    expect(checkWsUpgradeAuth(base({ headerAuth: KEY }))).toEqual({ ok: true });
  });
});