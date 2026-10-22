/**
 * P1.4 第二因子分级（D1=C）：写 fail-closed / 读 fail-open（+ warn once）
 *
 * 覆盖：
 *  1. 写端点 + 未配置 → 403 + code=second-factor-unconfigured + recovery（env 名 + 文档路径），不是 503；
 *  2. 读端点 + 未配置 → 放行（200）且 warn 每进程只记一次；
 *  3. 已配置 + 错误凭证 → 403 + code=invalid-second-factor；
 *  4. 已配置 + 正确凭证（x-api-key / Authorization: Bearer）→ 放行；
 *  5. git 写路由（fake ctx，不真实执行 git）与 /permissions/mode 代表性拒绝路径。
 */
import { describe, test, expect, afterEach, spyOn } from "bun:test";
import { handlePermissionMode, handleHealth } from "../../src/routes/health.js";
import { handleTerminalList } from "../../src/routes/terminal.js";
import { handleGitRoutes } from "../../src/routes/git.js";
import { getSecondFactorStatus } from "../../src/routes/route-auth.js";
import { logger } from "../../src/utils/logger.js";
import type { RouteContext } from "../../src/routes/types.js";

const AUTH = "auth-token-0123456789abcdef";
const SECOND = "second-factor-0123456789abcdef";

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
    healthMonitor: { checkAll: async () => [] } as never,
    fileWatcher: null,
    startupTime: Date.now(),
    baseHeaders: {},
    jsonResponse: (data: unknown, status = 200, extra?: Record<string, string>) =>
      new Response(JSON.stringify(data), {
        status,
        headers: { "Content-Type": "application/json", ...(extra ?? {}) },
      }),
  };
}

const savedAuth = process.env.AXIOM_AUTH_TOKEN;
const savedSecond = process.env.AXIOM_SECOND_FACTOR_TOKEN;

afterEach(() => {
  if (savedAuth === undefined) delete process.env.AXIOM_AUTH_TOKEN;
  else process.env.AXIOM_AUTH_TOKEN = savedAuth;
  if (savedSecond === undefined) delete process.env.AXIOM_SECOND_FACTOR_TOKEN;
  else process.env.AXIOM_SECOND_FACTOR_TOKEN = savedSecond;
});

describe("P1.4 第二因子 C：写 fail-closed / 读 fail-open", () => {
  test("1. 写端点 + 未配置 → 403 fail-closed，body 带 code + recovery（不是 503）", async () => {
    process.env.AXIOM_AUTH_TOKEN = AUTH;
    delete process.env.AXIOM_SECOND_FACTOR_TOKEN;
    const res = (await handlePermissionMode(
      makeCtx("/permissions/mode", "POST", { "x-api-key": AUTH }, { autoAccept: false }),
    )) as Response;
    expect(res.status).toBe(403);
    const body = (await res.json()) as {
      error?: string;
      code?: string;
      recovery?: { env?: string; docs?: string; hint?: string };
    };
    expect(body.code).toBe("second-factor-unconfigured");
    expect(body.recovery?.env).toBe("AXIOM_SECOND_FACTOR_TOKEN");
    expect(body.recovery?.docs).toBe("docs/CONFIGURATION.md");
    expect(body.recovery?.hint?.length ?? 0).toBeGreaterThan(0);
    expect(body.error ?? "").toContain("AXIOM_SECOND_FACTOR_TOKEN");
  });

  test("2. 读端点 + 未配置 → 放行（200），且 warn 每进程只记一次", async () => {
    process.env.AXIOM_AUTH_TOKEN = AUTH;
    delete process.env.AXIOM_SECOND_FACTOR_TOKEN;
    const warnSpy = spyOn(logger, "warn");
    try {
      const first = (await handleTerminalList(
        makeCtx("/terminal/sessions", "GET", { "x-api-key": AUTH }),
      )) as Response;
      expect(first.status).toBe(200);
      const second = (await handleTerminalList(
        makeCtx("/terminal/sessions", "GET", { "x-api-key": AUTH }),
      )) as Response;
      expect(second.status).toBe(200);
      const warnCalls = warnSpy.mock.calls.filter((args) =>
        String(args[0] ?? "").includes("AXIOM_SECOND_FACTOR_TOKEN"),
      );
      expect(warnCalls.length).toBe(1);
    } finally {
      warnSpy.mockRestore();
    }
  });

  test("3. 已配置 + 错误凭证 → 403 code=invalid-second-factor", async () => {
    process.env.AXIOM_AUTH_TOKEN = AUTH;
    process.env.AXIOM_SECOND_FACTOR_TOKEN = SECOND;
    const res = (await handlePermissionMode(
      makeCtx("/permissions/mode", "POST", { "x-api-key": "wrong-second" }, { autoAccept: false }),
    )) as Response;
    expect(res.status).toBe(403);
    const body = (await res.json()) as { code?: string };
    expect(body.code).toBe("invalid-second-factor");
  });

  test("4. 已配置 + 正确凭证（x-api-key 与 Bearer 双通道）→ 放行", async () => {
    process.env.AXIOM_AUTH_TOKEN = AUTH;
    process.env.AXIOM_SECOND_FACTOR_TOKEN = SECOND;
    const viaKey = (await handlePermissionMode(
      makeCtx("/permissions/mode", "POST", { "x-api-key": SECOND }, { autoAccept: false }),
    )) as Response;
    expect(viaKey.status).toBe(200);
    const viaBearer = (await handlePermissionMode(
      makeCtx("/permissions/mode", "POST", { authorization: `Bearer ${SECOND}` }, { autoAccept: false }),
    )) as Response;
    expect(viaBearer.status).toBe(200);
  });

  test("5a. git 写路由（fake ctx，不真实执行 git）：未配置 → 403 且守卫先于 git", async () => {
    process.env.AXIOM_AUTH_TOKEN = AUTH;
    delete process.env.AXIOM_SECOND_FACTOR_TOKEN;
    const res = (await handleGitRoutes(
      makeCtx("/api/git/push", "POST", { "x-api-key": AUTH }, { remote: "internal", branch: "x" }),
    )) as Response;
    expect(res.status).toBe(403);
    const body = (await res.json()) as { code?: string };
    expect(body.code).toBe("second-factor-unconfigured");
  });

  test("5b. git 写路由：已配置 + 错误凭证 → 403 code=invalid-second-factor", async () => {
    process.env.AXIOM_AUTH_TOKEN = AUTH;
    process.env.AXIOM_SECOND_FACTOR_TOKEN = SECOND;
    const res = (await handleGitRoutes(
      makeCtx("/api/git/commit", "POST", { "x-api-key": "wrong-second" }, { message: "x" }),
    )) as Response;
    expect(res.status).toBe(403);
    const body = (await res.json()) as { code?: string };
    expect(body.code).toBe("invalid-second-factor");
  });
});

/**
 * D3=C（2026-10-22 P2）：只读二因子维持 fail-open，但降级必须在 /health 可见。
 * 断言的是「状态可观测」而不是把只读改成 fail-closed —— 拒绝语义保持不变（P1.4 已覆盖）。
 */
describe("D3=C 只读二因子降级可见性（/health）", () => {
  test("getSecondFactorStatus：未配置时 configured=false + 暴露缺失 env；tier 语义不变", () => {
    delete process.env.AXIOM_SECOND_FACTOR_TOKEN;
    const missing = getSecondFactorStatus();
    expect(missing.configured).toBe(false);
    expect(missing.writeTier).toBe("fail-closed");
    expect(missing.readTier).toBe("fail-open");
    expect(missing.missingEnv).toBe("AXIOM_SECOND_FACTOR_TOKEN");

    process.env.AXIOM_SECOND_FACTOR_TOKEN = SECOND;
    const configured = getSecondFactorStatus();
    expect(configured.configured).toBe(true);
    expect(configured.missingEnv).toBeUndefined();
    expect(configured.writeTier).toBe("fail-closed");
    expect(configured.readTier).toBe("fail-open");
  });

  test("GET /health 暴露 security.secondFactor（未配置 → 只读降级可见）", async () => {
    process.env.AXIOM_AUTH_TOKEN = AUTH;
    delete process.env.AXIOM_SECOND_FACTOR_TOKEN;
    const res = (await handleHealth(makeCtx("/health", "GET"))) as Response;
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      security?: {
        secondFactor?: {
          configured?: boolean;
          writeTier?: string;
          readTier?: string;
          missingEnv?: string;
        };
      };
    };
    expect(body.security?.secondFactor).toBeDefined();
    expect(body.security!.secondFactor!.configured).toBe(false);
    expect(body.security!.secondFactor!.writeTier).toBe("fail-closed");
    expect(body.security!.secondFactor!.readTier).toBe("fail-open");
    expect(body.security!.secondFactor!.missingEnv).toBe("AXIOM_SECOND_FACTOR_TOKEN");
  });
});
