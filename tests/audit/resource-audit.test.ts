/**
 * 资源审查测试 —— 覆盖全部核心功能的"防泄漏/防膨胀/有兜底"不变量
 *
 * 覆盖：
 *  - 资源注册表：重复注册去重、收集器失败降级、不抛出
 *  - 缓存：LRU 有界 + clear() 归零；全局缓存大小不超配置上限
 *  - WebSocket：连接关闭后统计回落（句柄不残留）
 *  - ContextManager：clearMemory 幂等归零
 *  - 限流器：cleanup 幂等
 *  - 兜底机制：边缘模型失败回退（degraded）、功能开关、容错 JSON、LLM 客户端熔断/重试配置
 *  - 诊断端点：/api/audit/diagnostics 返回资源统计与内存快照
 */
import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import {
  Cache,
  searchCache,
  crawlCache,
  llmCache,
} from "../../src/utils/cache.js";
import { wsManager } from "../../src/utils/websocket.js";
import { contextManager } from "../../src/context/context-manager.js";
import { apiLimiter, multiDimLimiter } from "../../src/utils/rate-limiter.js";
import { isEdgeEnabled, extractJson, getEdgeClient } from "../../src/local-llm/edge-client.js";
import { screenPayloadWithEdge } from "../../src/local-llm/risk-screen.js";
import {
  registerResource,
  unregisterResource,
  listResourceNames,
  collectResources,
} from "../../src/utils/resource-registry.js";
import { handleAuditDiagnostics } from "../../src/routes/audit.js";
import type { RouteContext } from "../../src/routes/types.js";

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

describe("资源注册表", () => {
  afterEach(() => {
    unregisterResource("audit-test");
    unregisterResource("audit-fail");
  });

  it("重复注册同名收集器去重（防闭包累积）", () => {
    registerResource("audit-test", () => ({ a: 1 }));
    registerResource("audit-test", () => ({ a: 2 }));
    const names = listResourceNames().filter((n) => n === "audit-test");
    expect(names.length).toBe(1);
  });

  it("收集器失败降级为 degraded 且整体不抛出", () => {
    registerResource("audit-test", () => ({ a: 1 }));
    registerResource("audit-fail", () => {
      throw new Error("collector boom");
    });
    const snaps = collectResources();
    const fail = snaps.find((s) => s.name === "audit-fail");
    expect(fail?.status).toBe("degraded");
    expect(fail?.error).toContain("collector boom");
    const ok = snaps.find((s) => s.name === "audit-test");
    expect(ok?.status).toBe("ok");
  });

  it("审查端点注册了核心资源收集器", () => {
    const names = listResourceNames();
    expect(names).toContain("cache.search");
    expect(names).toContain("cache.crawl");
    expect(names).toContain("cache.llm");
    expect(names).toContain("websocket");
    expect(names).toContain("context");
  });
});

describe("缓存有界性", () => {
  it("Cache LRU 有界：200 次插入不超过 maxSize=50，clear 归零", () => {
    const c = new Cache<string>({
      maxSize: 50,
      defaultTtlMs: 60_000,
      redis: false,
      persistent: false,
    });
    for (let i = 0; i < 200; i++) c.set(`k${i}`, "v");
    expect(c.stats().size).toBeLessThanOrEqual(50);
    c.clear();
    expect(c.stats().size).toBe(0);
  });

  it("全局缓存大小不超配置上限（只读不变量）", () => {
    expect(searchCache.stats().size).toBeLessThanOrEqual(500);
    expect(crawlCache.stats().size).toBeLessThanOrEqual(200);
    expect(llmCache.stats().size).toBeLessThanOrEqual(2000);
  });
});

describe("句柄与状态回落", () => {
  it("WebSocket 连接关闭后统计回落（句柄不残留）", () => {
    const base = wsManager.getStats().connectedClients;
    const fake = {
      data: { clientId: `audit-test-${Date.now()}` },
      send: () => {},
      close: () => {},
    } as unknown as Parameters<typeof wsManager.onOpen>[0];
    wsManager.onOpen(fake);
    expect(wsManager.getStats().connectedClients).toBe(base + 1);
    wsManager.onClose(fake);
    expect(wsManager.getStats().connectedClients).toBe(base);
  });

  it("ContextManager clearMemory 幂等归零", () => {
    contextManager.clearMemory();
    expect(contextManager.getMemoryStats().entries).toBe(0);
    contextManager.clearMemory();
    expect(contextManager.getMemoryStats().entries).toBe(0);
  });

  it("限流器 cleanup 幂等不抛出", () => {
    expect(() => {
      apiLimiter.cleanup();
      apiLimiter.cleanup();
      multiDimLimiter.cleanup();
      multiDimLimiter.cleanup();
    }).not.toThrow();
  });
});

describe("兜底机制（边缘增强·失败回退）", () => {
  it("边缘风险初筛在模型失败时降级 degraded（fail-open）", async () => {
    const failing = {
      generate: async () => {
        throw new Error("edge service down");
      },
    } as never;
    const res = await screenPayloadWithEdge("ls -la", "command", failing);
    expect(res.degraded).toBe(true);
  });

  it("功能开关与容错 JSON 解析可用", () => {
    process.env.EDGE_AUDIT_FLAG = "0";
    expect(isEdgeEnabled("EDGE_AUDIT_FLAG")).toBe(false);
    process.env.EDGE_AUDIT_FLAG = "1";
    expect(isEdgeEnabled("EDGE_AUDIT_FLAG")).toBe(true);
    expect(extractJson<{ a: number }>('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(extractJson<{ b: number }>("前缀 {\"b\":2} 后缀")).toEqual({ b: 2 });
    expect(extractJson("完全不是 json")).toBeNull();
  });

  it("边缘 LLM 客户端带熔断/重试配置（共享单例，仅断言能力存在）", () => {
    const client = getEdgeClient();
    expect(typeof client.generate).toBe("function");
    expect(client.getCircuitState()).toBeDefined();
    expect(Number.isFinite(client.getStats().retryCount)).toBe(true);
  });
});

describe("诊断端点", () => {
  it("GET /api/audit/diagnostics 返回资源与内存快照", async () => {
    const res = await handleAuditDiagnostics(fakeCtx("GET", "/api/audit/diagnostics"));
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    const body = (await res!.json()) as {
      memory: { heapUsed: number };
      resourceNames: string[];
      resources: Array<{ name: string; status: string; metrics: Record<string, unknown> }>;
      summary: { total: number; degraded: number };
    };
    expect(body.memory.heapUsed).toBeGreaterThan(0);
    expect(body.resourceNames).toContain("cache.search");
    expect(body.resources.length).toBe(body.summary.total);
    // 全部已注册资源快照应成功（无 degraded）
    expect(body.summary.degraded).toBe(0);
  });

  it("路径不匹配返回 null", async () => {
    expect(await handleAuditDiagnostics(fakeCtx("GET", "/other"))).toBeNull();
  });
});