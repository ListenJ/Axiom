/**
 * 模型注册表校验 + 核心路由单元测试
 */
import { describe, it, expect } from "bun:test";

describe("模型注册表", () => {
  it("所有模型有关键字段", async () => {
    const { UNIFIED_REGISTRY } = await import("../src/router/models/registry.js");
    expect(Array.isArray(UNIFIED_REGISTRY)).toBeTrue();
    expect(UNIFIED_REGISTRY.length).toBeGreaterThan(50);
    for (const m of UNIFIED_REGISTRY) {
      expect(m.id).toBeString();
      expect(m.id.length).toBeGreaterThan(0);
      expect(m.provider).toBeString();
      expect(m.model).toBeString();
      expect(Array.isArray(m.roles)).toBeTrue();
      expect(m.roles.length).toBeGreaterThan(0);
      expect(typeof m.contextWindow).toBe("number");
      expect(m.contextWindow).toBeGreaterThan(0);
    }
  });

  it("无重复 ID", async () => {
    const { UNIFIED_REGISTRY } = await import("../src/router/models/registry.js");
    const ids = UNIFIED_REGISTRY.map(m => m.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("所有模型引用有效 provider", async () => {
    const { UNIFIED_REGISTRY } = await import("../src/router/models/registry.js");
    const { PROVIDER_CONFIG } = await import("../src/router/models/providers.js");
    const validProviders = Object.keys(PROVIDER_CONFIG);
    for (const m of UNIFIED_REGISTRY) {
      expect(validProviders).toContain(m.provider);
    }
  });
});

describe("HttpRouter", () => {
  it("注册并匹配 GET 路由", async () => {
    const { HttpRouter } = await import("../src/core/http-router.js");
    const r = new HttpRouter({ cacheMaxSize: 10, cacheTtlMs: 1000, redis: false } as any);
    r.register({ method: "GET", path: "/test", handler: async () => new Response("ok") });
    const ctx: any = { url: new URL("http://localhost/test"), req: new Request("http://localhost/test"), vault: null, db: null, pipeline: null, healthMonitor: null, fileWatcher: null, startupTime: 0, baseHeaders: {}, jsonResponse: (d: any) => d };
    const res = await r.execute(ctx);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
  });

  it("未知路径返回 null", async () => {
    const { HttpRouter } = await import("../src/core/http-router.js");
    const r = new HttpRouter({ redis: false } as any);
    r.register({ method: "GET", path: "/known", handler: async () => new Response("ok") });
    const ctx: any = { url: new URL("http://localhost/unknown"), req: new Request("http://localhost/unknown"), vault: null, db: null, pipeline: null, healthMonitor: null, fileWatcher: null, startupTime: 0, baseHeaders: {}, jsonResponse: (d: any) => d };
    const res = await r.execute(ctx);
    expect(res).toBeNull();
  });

  it("方法不匹配返回 null", async () => {
    const { HttpRouter } = await import("../src/core/http-router.js");
    const r = new HttpRouter({ redis: false } as any);
    r.register({ method: "POST", path: "/onlypost", handler: async () => new Response("ok") });
    const ctx: any = { url: new URL("http://localhost/onlypost"), req: new Request("http://localhost/onlypost", { method: "GET" }), vault: null, db: null, pipeline: null, healthMonitor: null, fileWatcher: null, startupTime: 0, baseHeaders: {}, jsonResponse: (d: any) => d };
    const res = await r.execute(ctx);
    expect(res).toBeNull();
  });
});

describe("Services barrel", () => {
  it("所有导出函数可用", async () => {
    const svc = await import("../src/services/index.js");
    expect(typeof svc.prepareChatContext).toBe("function");
    expect(typeof svc.executeChat).toBe("function");
    expect(svc.getConsciousness).toBeDefined();
    expect(svc.executionMode).toBeDefined();
    expect(typeof svc.getConstitutionForMode).toBe("function");
    expect(svc.router).toBeDefined();
  });
});
