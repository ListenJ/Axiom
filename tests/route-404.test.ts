/**
 * R-017 回归测试：未知路径返回 404 JSON（不再以 200 端点列表掩盖）
 *
 * 直接单测 defaultResponse，fake 最小 RouteContext（同 route-auth.test.ts 策略）。
 */
import { describe, it, expect } from "bun:test";
import { defaultResponse } from "../src/routes/index.js";
import type { RouteContext } from "../src/routes/types.js";

function fakeCtx(method: string, path: string): RouteContext {
  return {
    url: new URL(`http://localhost${path}`),
    req: new Request(`http://localhost${path}`, { method }),
    baseHeaders: {},
    startupTime: Date.now(),
    jsonResponse: (data: unknown, status = 200, extra: Record<string, string> = {}) =>
      new Response(JSON.stringify(data), {
        status,
        headers: { "Content-Type": "application/json", ...extra },
      }),
  } as unknown as RouteContext;
}

describe("R-017 未知路径 404 语义", () => {
  it("未知 API 路径返回 404 JSON", async () => {
    const res = defaultResponse(fakeCtx("GET", "/api/definitely-not-exist"));
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error?: boolean; message?: string };
    expect(body.error).toBe(true);
    expect(body.message).toContain("/api/definitely-not-exist");
  });

  it("非 GET 未知路径同样 404", () => {
    const res = defaultResponse(fakeCtx("POST", "/nope"));
    expect(res.status).toBe(404);
  });

  it("响应仍附端点目录辅助排错", async () => {
    const res = defaultResponse(fakeCtx("GET", "/nope"));
    const body = (await res.json()) as { endpoints?: string[] };
    expect(Array.isArray(body.endpoints)).toBe(true);
    expect(body.endpoints!.length).toBeGreaterThan(10);
  });
});
