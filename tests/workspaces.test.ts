/**
 * Workspace list route tests
 *
 * 覆盖：
 *  - GET /api/workspaces 返回当前工作区（含分支、clean 状态、会话数）
 *  - 会话统计来自 ctx.db 的 conversations 表
 *  - Git 状态失败时仍返回工作区列表（sessionCount 照常计算）
 *  - 非 GET / 其他路径不匹配
 */
import { describe, it, expect } from "bun:test";
import path from "node:path";
import { handleWorkspaces } from "../src/routes/workspaces.js";
import type { RouteContext } from "../src/routes/types.js";

function fakeDb(sessionRows: unknown[] = []) {
  return {
    query: (sql: string) => ({
      get: (..._params: unknown[]) =>
        sql.includes("COUNT(*)")
          ? { session_count: sessionRows.length }
          : null,
    }),
  };
}

function fakeCtx(
  method: string,
  path: string,
  db: ReturnType<typeof fakeDb> = fakeDb()
): RouteContext {
  return {
    url: new URL(`http://localhost${path}`),
    req: new Request(`http://localhost${path}`, { method }),
    baseHeaders: {},
    startupTime: Date.now(),
    db: db as never,
    vault: null,
    pipeline: null as never,
    healthMonitor: null as never,
    fileWatcher: null,
    jsonResponse: (data: unknown, status = 200, extra: Record<string, string> = {}) =>
      new Response(JSON.stringify(data), {
        status,
        headers: { "Content-Type": "application/json", ...extra },
      }),
  } as unknown as RouteContext;
}

describe("工作区列表路由", () => {
  it("GET /api/workspaces 返回单个工作区与分支/clean/会话数", async () => {
    const res = await handleWorkspaces(
      fakeCtx("GET", "/api/workspaces", fakeDb([{ session_id: "s1" }, { session_id: "s2" }]))
    );
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    const body = (await res!.json()) as {
      workspaces: Array<{
        id: string;
        name: string;
        path: string;
        branch: string;
        clean: boolean;
        sessionCount: number;
      }>;
    };
    expect(body.workspaces.length).toBe(1);
    const ws = body.workspaces[0];
    expect(ws.id.length).toBeGreaterThan(0);
    expect(ws.name.length).toBeGreaterThan(0);
    expect(path.isAbsolute(ws.path)).toBe(true);
    expect(ws.path.replace(/\\/g, '/')).toContain('openclaw-fusion');
    expect(typeof ws.branch).toBe("string");
    expect(typeof ws.clean).toBe("boolean");
    expect(ws.sessionCount).toBe(2);
  });

  it("会话表查询异常时返回 500 而不是伪造数据", async () => {
    const ctx = fakeCtx("GET", "/api/workspaces", {
      query: () => {
        throw new Error("db locked");
      },
    } as never);
    const res = await handleWorkspaces(ctx);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(500);
  });

  it("非 GET / 其他路径不匹配", async () => {
    expect(await handleWorkspaces(fakeCtx("POST", "/api/workspaces"))).toBeNull();
    expect(await handleWorkspaces(fakeCtx("GET", "/api/other"))).toBeNull();
  });
});
