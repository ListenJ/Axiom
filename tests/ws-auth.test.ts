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