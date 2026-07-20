/**
 * route-auth 单元测试
 *
 * 覆盖 requireAuthToken + auditSuccess 的 4 个核心场景：
 *   1. 未配置 AXIOM_AUTH_TOKEN → 503 + auditLogger.auth.failure
 *   2. 错误 token → 401 + auditLogger.auth.failure
 *   3. 正确 token → 返回 null（放行）
 *   4. auditSuccess 写入审计日志 event 字段正确
 *
 * 测试策略：
 *   - 最小化 mock RouteContext（仅 url / req / jsonResponse / baseHeaders）
 *   - 临时设/还原 process.env.AXIOM_AUTH_TOKEN
 *   - 读取 auditLogger 单例的 readAll() 验证最近一条审计条目
 *
 * 注意：auditLogger 是写入 data/logs/audit.log 的全局单例，
 * appendFileSync 同步落盘 → 测试调用返回后即可读到最后一条。
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { requireAuthToken, auditSuccess } from "../src/routes/route-auth.js";
import { auditLogger } from "../src/utils/audit-logger.js";
import type { RouteContext } from "../src/routes/types.js";

const TOKEN = "test-token-abc123xyz789"; // ≥ 16 字符，避免触发 env 校验告警
const RESOURCE = "/test/route";

let originalToken: string | undefined;

beforeEach(() => {
  originalToken = process.env.AXIOM_AUTH_TOKEN;
  process.env.AXIOM_AUTH_TOKEN = TOKEN;
});

afterEach(() => {
  if (originalToken === undefined) {
    delete process.env.AXIOM_AUTH_TOKEN;
  } else {
    process.env.AXIOM_AUTH_TOKEN = originalToken;
  }
});

/** 构造最小化 mock RouteContext（只填充 route-auth 依赖的字段） */
function makeCtx(headers: Record<string, string> = {}): RouteContext {
  const req = new Request("https://example.com" + RESOURCE, {
    method: "POST",
    headers,
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
  };
}

/** 读取 auditLogger 单例最近一条审计条目（appendFileSync 同步落盘） */
function readLastAuditEntry(): Record<string, unknown> | null {
  const content = auditLogger.readAll();
  if (!content) return null;
  const lines = content.trim().split("\n");
  if (lines.length === 0) return null;
  try {
    return JSON.parse(lines[lines.length - 1]);
  } catch {
    return null;
  }
}

describe("requireAuthToken", () => {
  it("未配置 AXIOM_AUTH_TOKEN → 503 + auditLogger auth.failure", async () => {
    delete process.env.AXIOM_AUTH_TOKEN;
    const ctx = makeCtx({ "x-real-ip": "1.2.3.4" });

    const res = requireAuthToken(ctx);

    expect(res).not.toBeNull();
    expect(res!.status).toBe(503);
    const body = (await res!.json()) as { error: string };
    expect(body.error).toContain("AXIOM_AUTH_TOKEN");

    const entry = readLastAuditEntry();
    expect(entry).not.toBeNull();
    expect(entry!.event).toBe("auth.failure");
    expect(entry!.outcome).toBe("denied");
    expect(entry!.actor).toBe("1.2.3.4");
    expect(entry!.resource).toBe(RESOURCE);
    expect(String(entry!.reason)).toContain("AXIOM_AUTH_TOKEN");
  });

  it("错误 token → 401 + auditLogger auth.failure", async () => {
    const ctx = makeCtx({
      "x-api-key": "wrong-token",
      "x-real-ip": "5.6.7.8",
    });

    const res = requireAuthToken(ctx);

    expect(res).not.toBeNull();
    expect(res!.status).toBe(401);
    const body = (await res!.json()) as { error: string };
    expect(body.error).toBe("Unauthorized");

    const entry = readLastAuditEntry();
    expect(entry).not.toBeNull();
    expect(entry!.event).toBe("auth.failure");
    expect(entry!.outcome).toBe("denied");
    expect(entry!.actor).toBe("5.6.7.8");
    expect(entry!.resource).toBe(RESOURCE);
    expect(String(entry!.reason)).toContain("invalid or missing token");
  });

  it("正确 token (x-api-key) → 返回 null（放行）", () => {
    const ctx = makeCtx({ "x-api-key": TOKEN });

    const res = requireAuthToken(ctx);

    expect(res).toBeNull();
  });

  it("正确 token (Authorization: Bearer) → 返回 null（放行）", () => {
    const ctx = makeCtx({ authorization: `Bearer ${TOKEN}` });

    const res = requireAuthToken(ctx);

    expect(res).toBeNull();
  });
});

describe("auditSuccess", () => {
  it("写入审计日志 event 字段正确", () => {
    const ctx = makeCtx({ "x-real-ip": "9.10.11.12" });

    auditSuccess(ctx, "vault.write", "/vault/test");

    const entry = readLastAuditEntry();
    expect(entry).not.toBeNull();
    expect(entry!.event).toBe("vault.write");
    expect(entry!.outcome).toBe("success");
    expect(entry!.actor).toBe("9.10.11.12");
    expect(entry!.resource).toBe("/vault/test");
  });

  it("metadata 被正确记录到审计条目", () => {
    const ctx = makeCtx({ "x-real-ip": "13.14.15.16" });

    auditSuccess(ctx, "sandbox.execute", "ls", { exitCode: 0 });

    const entry = readLastAuditEntry();
    expect(entry).not.toBeNull();
    expect(entry!.event).toBe("sandbox.execute");
    expect(entry!.outcome).toBe("success");
    expect(entry!.metadata).toEqual({ exitCode: 0 });
  });

  it("resource 缺省时回退到 ctx.url.pathname", () => {
    const ctx = makeCtx({ "x-real-ip": "17.18.19.20" });

    auditSuccess(ctx, "apikey.set");

    const entry = readLastAuditEntry();
    expect(entry).not.toBeNull();
    expect(entry!.event).toBe("apikey.set");
    expect(entry!.resource).toBe(RESOURCE);
  });
});
