/**
 * Task 3 fix 回归：terminal 写入无论 isLocal 均需 AXIOM_AUTH_TOKEN（双闸）
 *
 * 背景：Task3 前 handleTerminalCreate/Input/Close 仅靠 main.ts 的 checkApiKey，
 * isLocal 时无 Origin 可直通；Task3 已在路由层追加 requireAuthToken（未配 503/未带 401）
 * 且与 sandbox 二层语义一致。本文件为 TDD 固定器：even when isLocal true，
 * 写入端点仍需有效凭证。
 *
 * 同时覆盖 ws-auth credentialGate 多通道修复：header 无效但 query 有效仍应放行。
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { handleTerminalCreate } from "../../src/routes/terminal.js";
import { checkWsUpgradeAuth } from "../../src/utils/ws-auth.js";
import type { RouteContext } from "../../src/routes/types.js";
import { closeAllSessions } from "../../src/terminal/pty-session.js";

const TOKEN = "terminal-fix-token-1234567890abcdef";

function makeCtx(
  pathname: string,
  method: string,
  headers: Record<string, string> = {},
  body?: unknown,
): RouteContext {
  const req = new Request("https://example.com" + pathname, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return {
    url: new URL(req.url),
    req,
    vault: null,
    db: {} as never,
    pipeline: {} as never,
    healthMonitor: {} as never,
    fileWatcher: null,
    startupTime: Date.now(),
    baseHeaders: {},
    jsonResponse: (data: unknown, status = 200, extra?: Record<string, string>) =>
      new Response(JSON.stringify(data), {
        status,
        headers: { "Content-Type": "application/json", ...(extra ?? {}) },
      }),
  } as unknown as RouteContext;
}

describe("terminal double-gate: isLocal true 仍需鉴权 (Task3 fix)", () => {
  let origToken: string | undefined;
  let origSecond: string | undefined;

  beforeEach(() => {
    origToken = process.env.AXIOM_AUTH_TOKEN;
    origSecond = process.env.AXIOM_SECOND_FACTOR_TOKEN;
    process.env.AXIOM_AUTH_TOKEN = TOKEN;
    delete process.env.AXIOM_SECOND_FACTOR_TOKEN;
  });

  afterEach(async () => {
    if (origToken === undefined) delete process.env.AXIOM_AUTH_TOKEN;
    else process.env.AXIOM_AUTH_TOKEN = origToken;
    if (origSecond === undefined) delete process.env.AXIOM_SECOND_FACTOR_TOKEN;
    else process.env.AXIOM_SECOND_FACTOR_TOKEN = origSecond;
    await closeAllSessions();
  });

  test("POST /terminal/session 无凭证 -> 401 或 503 (requireAuthToken, 即使 isLocal)", async () => {
    const ctx = makeCtx("/terminal/session", "POST");
    const res = await handleTerminalCreate(ctx);
    expect(res).not.toBeNull();
    // 未配 token 时 503，未带 token 时 401；本用例已配 token 但未带 => 401
    expect([401, 503]).toContain(res!.status);
    const body = (await res!.json()) as { error: string };
    expect(body.error).toMatch(/Unauthorized|AXIOM_AUTH_TOKEN/);
  });

  test("POST /terminal/session 携带正确 x-api-key -> 放行 (200, 非 401)", async () => {
    const ctx = makeCtx("/terminal/session", "POST", { "x-api-key": TOKEN });
    const res = await handleTerminalCreate(ctx);
    expect(res).not.toBeNull();
    // 通过鉴权后进入会话创建：成功 200 带 sessionId；若环境不支持 pty 则 503 但非鉴权 401
    expect(res!.status).not.toBe(401);
    expect(res!.status).not.toBe(403);
    if (res!.status === 200) {
      const body = (await res!.json()) as { sessionId: string };
      expect(typeof body.sessionId).toBe("string");
      expect(body.sessionId.length).toBeGreaterThan(0);
    }
  });

  test("POST /terminal/session 携带 Bearer token -> 放行", async () => {
    const ctx = makeCtx("/terminal/session", "POST", { authorization: `Bearer ${TOKEN}` });
    const res = await handleTerminalCreate(ctx);
    expect(res).not.toBeNull();
    expect([200, 503]).toContain(res!.status);
    expect(res!.status).not.toBe(401);
  });

  test("POST /terminal/session Bearer 大小写/多空格容忍 (timing-safe)", async () => {
    const ctx = makeCtx("/terminal/session", "POST", { authorization: `Bearer    ${TOKEN}` });
    const res = await handleTerminalCreate(ctx);
    expect(res!.status).not.toBe(401);
    const ctx2 = makeCtx("/terminal/session", "POST", { authorization: `bearer ${TOKEN}` });
    const res2 = await handleTerminalCreate(ctx2);
    expect(res2!.status).not.toBe(401);
  });

  test("未配置 AXIOM_AUTH_TOKEN -> 503 fail-closed (即使本地)", async () => {
    delete process.env.AXIOM_AUTH_TOKEN;
    const ctx = makeCtx("/terminal/session", "POST", { "x-api-key": TOKEN });
    const res = await handleTerminalCreate(ctx);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(503);
  });
});

describe("ws-auth credentialGate 多通道任一有效即放行 (Task3 fix)", () => {
  const apiKey = "secret-multi-channel";

  test("header 无效但 query 有效 -> 仍放行 (修复前 || 短路会拒)", () => {
    const r = checkWsUpgradeAuth({
      headerAuth: "wrong",
      protocolHeader: null,
      queryToken: apiKey,
      isLocal: false,
      apiKey,
      origin: null,
    });
    expect(r.ok).toBe(true);
  });

  test("header 无效但 subprotocol 有效 -> 仍放行", () => {
    const r = checkWsUpgradeAuth({
      headerAuth: "wrong",
      protocolHeader: `axiom.auth.${apiKey}`,
      queryToken: null,
      isLocal: false,
      apiKey,
      origin: null,
    });
    expect(r.ok).toBe(true);
  });

  test("三通道全无效 -> 拒绝", () => {
    const r = checkWsUpgradeAuth({
      headerAuth: "wrong",
      protocolHeader: "axiom.auth.wrong2",
      queryToken: "wrong3",
      isLocal: false,
      apiKey,
      origin: null,
    });
    expect(r.ok).toBe(false);
  });

  test("host 字段已去信任：evil host 不影响白名单判定", () => {
    const r = checkWsUpgradeAuth({
      headerAuth: null,
      protocolHeader: null,
      queryToken: null,
      isLocal: true,
      apiKey,
      origin: "http://r.evil.com",
      host: "r.evil.com",
    });
    expect(r.ok).toBe(false);
    // 白名单 Origin 仍放行，即使 host 为 evil
    const r2 = checkWsUpgradeAuth({
      headerAuth: null,
      protocolHeader: null,
      queryToken: null,
      isLocal: true,
      apiKey,
      origin: "http://127.0.0.1:18789",
      host: "r.evil.com",
    });
    expect(r2.ok).toBe(true);
  });
});
