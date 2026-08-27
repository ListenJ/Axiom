/**
 * route-confirmation 单元测试 —— P2-1 敏感端点二次确认的回归防线。
 *
 * 覆盖：
 *   - requestConfirmation 使用强随机源（UUID）
 *   - requireHttpConfirmation 缺失确认码时返回 403 + 新 confirmationId
 *   - 有效确认码放行，无效/过期确认码拒绝
 *   - body/header/query 三种 confirmationId 传递方式
 */
import { describe, it, expect } from "bun:test";
import {
  requestConfirmation,
  confirmOperation,
} from "../src/utils/permissions.js";
import { requireHttpConfirmation } from "../src/routes/confirmation.js";
import type { RouteContext } from "../src/routes/types.js";

function makeCtx(req: Request): RouteContext {
  return {
    url: new URL(req.url),
    req,
    vault: null,
    db: {} as any,
    pipeline: {} as any,
    healthMonitor: {} as any,
    fileWatcher: null,
    startupTime: 0,
    baseHeaders: {},
    jsonResponse: (data: unknown, status = 200) =>
      new Response(JSON.stringify(data), {
        status,
        headers: { "Content-Type": "application/json" },
      }),
  };
}

describe("requestConfirmation", () => {
  it("生成的确认码是 UUID 格式（强随机源）", () => {
    const id = requestConfirmation("test:op");
    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    );
  });

  it("多次生成的确认码不重复", () => {
    const ids = new Set(Array.from({ length: 10 }, () => requestConfirmation("test:op")));
    expect(ids.size).toBe(10);
  });
});

describe("requireHttpConfirmation", () => {
  it("缺失 confirmationId 时返回 403 并下发新 confirmationId", async () => {
    const ctx = makeCtx(
      new Request("http://x/vault/write", {
        method: "POST",
        body: JSON.stringify({ path: "x", content: "y" }),
      })
    );
    const res = requireHttpConfirmation(ctx, "vault:write", { path: "x", content: "y" });
    expect(res).not.toBeNull();
    expect(res!.status).toBe(403);
    const data = (await res!.json()) as Record<string, unknown>;
    expect(data.blocked).toBe(true);
    expect(data.operation).toBe("vault:write");
    expect(typeof data.confirmationId).toBe("string");
    expect(data.confirmationId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    );
  });

  it("有效 confirmationId 放行", () => {
    const id = requestConfirmation("vault:write");
    const ctx = makeCtx(
      new Request("http://x/vault/write", {
        method: "POST",
        body: JSON.stringify({ path: "x", content: "y", confirmationId: id }),
      })
    );
    const res = requireHttpConfirmation(ctx, "vault:write", {
      path: "x",
      content: "y",
      confirmationId: id,
    });
    expect(res).toBeNull();
  });

  it("无效 confirmationId 返回 403", () => {
    const ctx = makeCtx(
      new Request("http://x/vault/write", {
        method: "POST",
        body: JSON.stringify({ path: "x", content: "y", confirmationId: "nope" }),
      })
    );
    const res = requireHttpConfirmation(ctx, "vault:write", {
      path: "x",
      content: "y",
      confirmationId: "nope",
    });
    expect(res).not.toBeNull();
    expect(res!.status).toBe(403);
  });

  it("确认码一次性使用，第二次校验失败", () => {
    const id = requestConfirmation("vault:write");
    const ctx1 = makeCtx(
      new Request("http://x/vault/write", { method: "POST" })
    );
    expect(requireHttpConfirmation(ctx1, "vault:write", { confirmationId: id })).toBeNull();

    const ctx2 = makeCtx(
      new Request("http://x/vault/write", { method: "POST" })
    );
    const res = requireHttpConfirmation(ctx2, "vault:write", { confirmationId: id });
    expect(res).not.toBeNull();
    expect(res!.status).toBe(403);
  });

  it("支持从 x-confirmation-id header 读取", () => {
    const id = requestConfirmation("plugins:uninstall");
    const ctx = makeCtx(
      new Request("http://x/plugins/foo/uninstall", {
        method: "POST",
        headers: { "x-confirmation-id": id },
      })
    );
    expect(requireHttpConfirmation(ctx, "plugins:uninstall")).toBeNull();
  });

  it("GET 请求支持从 query.confirmationId 读取", () => {
    const id = requestConfirmation("bootstrap:run");
    const ctx = makeCtx(
      new Request(`http://x/bootstrap?topic=t&confirmationId=${id}`)
    );
    expect(requireHttpConfirmation(ctx, "bootstrap:run")).toBeNull();
  });
});

describe("confirmOperation", () => {
  it("确认码 5 分钟后过期", () => {
    const id = requestConfirmation("vault:write");
    expect(confirmOperation(id).approved).toBe(true);

    const originalNow = Date.now;
    try {
      Date.now = () => originalNow() + 310_000; // 5分10秒后
      expect(confirmOperation(id).approved).toBe(false);
    } finally {
      Date.now = originalNow;
    }
  });
});
