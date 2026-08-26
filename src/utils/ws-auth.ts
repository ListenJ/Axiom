/**
 * WebSocket 升级鉴权判定 —— 纯逻辑（main.ts /ws 分支使用），独立单元可测。
 *
 * 浏览器 WebSocket API 无法自定义请求头，因此远程（非回环）客户端可通过
 * 三种凭证通道之一携带 AXIOM_AUTH_TOKEN：
 *   1. Header：x-api-key 或 Authorization: Bearer <token>（REST 同款，CLI/脚本用）
 *   2. Sec-WebSocket-Protocol 子协议：axiom.auth.<token>（浏览器推荐，token 不落 URL）
 *   3. URL query：?token=<token>（无法设置 header/子协议的非浏览器客户端）
 *
 * 安全要点：
 *   - isLocal 必须由调用方按 socket 对端地址判定（与 checkApiKey 一致）。
 *   - 未配置 AXIOM_AUTH_TOKEN 时 fail-closed：远程一律拒绝。
 *   - query token 会出现在 URL 中：调用方记录日志/审计时只允许记 pathname，
 *     不得记完整 URL（防止 token 进日志/Referrer）。
 *   - 子协议按前缀 axiom.auth. 匹配且要求后续 token 非空，避免把任意子协议当凭证。
 */
import { LOCAL_ORIGIN_WHITELIST, safeStringEqual } from "./auth-check.js";

/** 握手时回显给客户端的子协议名（客户端必须将其列入 protocols） */
export const WS_AUTH_SUBPROTOCOL = "axiom";
/** 携带凭证的子协议前缀：axiom.auth.<token> */
export const WS_AUTH_TOKEN_PROTOCOL_PREFIX = "axiom.auth.";

export interface WsAuthInput {
  /** x-api-key 或 Authorization: Bearer <token> 提取后的值；无则为 null */
  headerAuth: string | null;
  /** 原始 Sec-WebSocket-Protocol 头；无则为 null */
  protocolHeader: string | null;
  /** URL query 中的 ?token= 值；无则为 null */
  queryToken: string | null;
  /** 是否回环请求（调用方用 socket 对端地址判定） */
  isLocal: boolean;
  /** 服务端 AXIOM_AUTH_TOKEN；空串表示未配置（fail-closed） */
  apiKey: string;
  /** 请求 Origin 头（浏览器 WS 必带且不可伪造；curl/ws 客户端一般没有）；无则为 null */
  origin?: string | null;
  /** 请求 Host 头（host:port）；与 origin 的 host:port 比对判定同源 */
  host?: string;
}

export type WsAuthResult = { ok: true } | { ok: false; reason: string };

/** 从 Sec-WebSocket-Protocol 头中提取 axiom.auth.<token>；无匹配返回 null */
export function extractSubprotocolToken(protocolHeader: string | null): string | null {
  if (!protocolHeader) return null;
  for (const part of protocolHeader.split(",")) {
    const p = part.trim();
    if (p.startsWith(WS_AUTH_TOKEN_PROTOCOL_PREFIX)) {
      const token = p.slice(WS_AUTH_TOKEN_PROTOCOL_PREFIX.length).trim();
      if (token.length > 0) return token;
    }
  }
  return null;
}

/** 凭证闸门：header / query / 子协议任一通道提供且与 apiKey 相等才放行 */
function credentialGate(input: WsAuthInput, denyReason: string): WsAuthResult {
  const subprotocolToken = extractSubprotocolToken(input.protocolHeader);
  const presented = input.headerAuth || input.queryToken || subprotocolToken;
  if (presented && input.apiKey && safeStringEqual(presented, input.apiKey)) return { ok: true };
  return { ok: false, reason: denyReason };
}

/**
 * WS 升级鉴权判定。
 *
 * 回环（isLocal）四态（2026-08-27 Task3 白名单化）：
 *   1. 无 Origin 头 → 放行（curl/wscat 等非浏览器客户端，不存在跨站劫持）；
 *   2. Origin 在 LOCAL_ORIGIN_WHITELIST（与 HTTP 侧 checkApiKey 同源白名单）→ 放行（Dashboard 自身）；
 *   3. 跨源 + 无有效凭证 → 拒绝（CSWSH 防线）；
 *   4. 跨源 + 有效凭证（子协议/header/query 任一通道）→ 放行。
 *   有 Origin 但解析失败 → 一律拒绝（fail-closed）。
 *   Host 去信任（DNS 重绑定防线），仅白名单判定。
 *
 * 远程（非回环）：须提供与 apiKey 相等的凭证，凭证可经 header / query /
 * 子协议任意通道之一提供；未配置 apiKey 时 fail-closed。
 */
export function checkWsUpgradeAuth(input: WsAuthInput): WsAuthResult {
  if (input.isLocal) {
    if (!input.origin) return { ok: true };
    let originHost: string;
    let originHostname: string;
    try {
      const u = new URL(input.origin);
      originHost = u.host;
      originHostname = u.hostname;
    } catch {
      return { ok: false, reason: "invalid Origin header" };
    }
    if (LOCAL_ORIGIN_WHITELIST.has(originHost) || LOCAL_ORIGIN_WHITELIST.has(originHostname)) return { ok: true };
    return credentialGate(input, "cross-origin WebSocket upgrade requires a valid API key");
  }
  if (!input.apiKey) return { ok: false, reason: "AXIOM_AUTH_TOKEN not configured" };
  return credentialGate(input, "invalid or missing API key");
}