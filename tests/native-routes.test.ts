import { describe, it, expect } from "bun:test";
import {
  handleNativeSearch,
  handleNativeRouterPerf,
  handleNativeStats,
  handleNativeProxy,
} from "../src/routes/native-routes.js";

function mockCtx(overrides: Partial<any> = {}): any {
  return {
    url: new URL("http://localhost:18789"),
    req: new Request("http://localhost:18789"),
    jsonResponse: (data: unknown, status = 200) =>
      Response.json(data, { status }),
    ...overrides,
  };
}

describe("Native Routes", () => {
  it("should return null for non-native paths", async () => {
    const ctx = mockCtx({ url: new URL("http://localhost:18789/search") });
    expect(await handleNativeSearch(ctx)).toBeNull();
    expect(await handleNativeRouterPerf(ctx)).toBeNull();
    expect(await handleNativeStats(ctx)).toBeNull();
  });

  it("should return 503 when native not ready", async () => {
    const ctx = mockCtx({
      url: new URL("http://localhost:18789/native/search"),
      req: new Request("http://localhost:18789/native/search", {
        method: "POST",
        body: JSON.stringify({ query: "test" }),
      }),
    });
    const res = await handleNativeSearch(ctx);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(503);
  });

  it("should return 503 for perf when native not ready", async () => {
    const ctx = mockCtx({
      url: new URL("http://localhost:18789/native/router/perf"),
      req: new Request("http://localhost:18789/native/router/perf"),
    });
    const res = await handleNativeRouterPerf(ctx);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(503);
  });

  it("should return 200 empty state for stats when native not ready", async () => {
    const ctx = mockCtx({
      url: new URL("http://localhost:18789/native/stats"),
      req: new Request("http://localhost:18789/native/stats"),
    });
    const res = await handleNativeStats(ctx);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    expect(await res!.json()).toMatchObject({ available: false });
  });

  it("should proxy non-matching native paths", async () => {
    const ctx = mockCtx({
      url: new URL("http://localhost:18789/native/health"),
      req: new Request("http://localhost:18789/native/health"),
    });
    const res = await handleNativeProxy(ctx);
    // Should attempt proxy and likely fail (no rust running)
    expect(res).not.toBeNull();
  });
});
