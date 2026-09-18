import { describe, it, expect, afterAll } from "bun:test";
import type { RouteContext } from "../src/routes/types.js";

const TMP_DIR = "./.tmp-integration-edge";

afterAll(async () => {
  const fs = await import("fs/promises");
  await fs.rm(TMP_DIR, { recursive: true, force: true }).catch(() => {});
});

// ═══════════════════════════════════════════════════════════════════
// 1. Tool Pipeline integration
// ═══════════════════════════════════════════════════════════════════
describe("Tool Pipeline integration", () => {
  it("Pipeline with mixed tools (read + write + query) produces 3 results", async () => {
    const { createToolContext } = await import("../src/tools/types.js");
    const { runPipeline } = await import("../src/tools/pipeline.js");
    const { readTool } = await import("../src/tools/read-tool.js");
    const { writeTool } = await import("../src/tools/write-tool.js");
    const { queryTool } = await import("../src/tools/query-tool.js");

    const ctx = createToolContext("mixed-test");
    const testFile = `${TMP_DIR}/mixed-test.txt`;

    const result = await runPipeline([
      { tool: writeTool, input: { target: "file" as const, path: testFile, content: "mixed pipeline test" } },
      { tool: readTool, input: { source: "file" as const, path: testFile } },
      { tool: queryTool, input: { query: "pipeline integration" } },
    ], ctx);

    expect(result.stepResults).toHaveLength(3);
    expect(result.error).toBeUndefined();
  }, 15000);

  it("Pipeline abort mid-flight stops after step 0", async () => {
    const { createToolContext } = await import("../src/tools/types.js");
    const { runPipeline } = await import("../src/tools/pipeline.js");
    const { writeTool } = await import("../src/tools/write-tool.js");
    const { queryTool } = await import("../src/tools/query-tool.js");

    let step0Done = false;
    const ctx = createToolContext("abort-test", 50000, 50000, (event) => {
      if (event.stage === "complete" && event.toolName === "write" && !step0Done) {
        step0Done = true;
        ctx.aborted = true;
      }
    });

    const result = await runPipeline([
      { tool: writeTool, input: { target: "file" as const, path: `${TMP_DIR}/abort-test.txt`, content: "step-0" } },
      { tool: queryTool, input: { query: "step 2 should not run" } },
      { tool: queryTool, input: { query: "step 3 should not run" } },
    ], ctx);

    expect(result.stepResults).toHaveLength(1);
    expect(result.aborted).toBeTrue();
  }, 15000);

  it("Pipeline with cache returns cached data on cache hit", async () => {
    const { createToolContext, normalizeQuery } = await import("../src/tools/types.js");
    const { Cache } = await import("../src/utils/cache.js");
    const { runPipeline } = await import("../src/tools/pipeline.js");
    const { queryTool } = await import("../src/tools/query-tool.js");

    const ctx = createToolContext("cache-test");
    const cache = new Cache({ maxSize: 100, defaultTtlMs: 60000, redis: false });
    (ctx as any).cache = cache;

    const cacheKey = `tool:${normalizeQuery("test query")}`;
    const cachedValue = { results: [{ source: "cache", title: "cached", snippet: "cached-data" }], totalFound: 1, scopeUsed: "cache" };
    cache.set(cacheKey, cachedValue);

    const result = await runPipeline([
      { tool: queryTool, input: { query: "test query" } },
    ], ctx);

    expect(result.stepResults).toHaveLength(1);
    expect(result.stepResults[0]).toEqual(cachedValue);
  });
});

// ═══════════════════════════════════════════════════════════════════
// 2. MockVaultManager concurrent stress
// ═══════════════════════════════════════════════════════════════════
describe("MockVaultManager concurrent stress", () => {
  it("500 concurrent writeNote calls with unique paths, all 500 exist", async () => {
    const { MockVaultManager } = await import("./helpers/vault-mock.js");
    const vault = new MockVaultManager();

    const promises = [];
    for (let i = 0; i < 500; i++) {
      promises.push(vault.writeNote(`stress-write-${i}.md`, `content-${i}`));
    }
    await Promise.all(promises);

    expect(vault.notes.size).toBe(500);
    for (let i = 0; i < 500; i++) {
      expect(vault.notes.has(`stress-write-${i}.md`)).toBeTrue();
    }
  });

  it("100 concurrent mixed read/write operations, no crash", async () => {
    const { MockVaultManager } = await import("./helpers/vault-mock.js");
    const vault = new MockVaultManager();

    for (let i = 0; i < 50; i++) {
      await vault.writeNote(`preload-${i}.md`, `preload-${i}`);
    }

    const promises = [];
    for (let i = 0; i < 50; i++) {
      promises.push(vault.writeNote(`mixed-write-${i}.md`, `mixed-${i}`));
      promises.push(vault.readNote(`preload-${i}.md`));
    }
    const results = await Promise.allSettled(promises);

    expect(vault.notes.size).toBe(100);
    for (const r of results) {
      expect(r.status).toBe("fulfilled");
    }
  });
});

// ═══════════════════════════════════════════════════════════════════
// 3. ConfigCenter integration
// ═══════════════════════════════════════════════════════════════════
describe("ConfigCenter integration", () => {
  it("Set config, getConfig() returns matching gateway.port", async () => {
    const { resetConfigCenter, getConfigCenter, getConfig } = await import("../src/core/config-center.js");
    resetConfigCenter();
    const cc = getConfigCenter();
    cc.set("gateway.port", 9999, "test", false);
    const config = getConfig();
    expect(config.gateway.port).toBe(9999);
  });

  it("Set config, verify it appears in getAll()", async () => {
    const { resetConfigCenter, getConfigCenter } = await import("../src/core/config-center.js");
    resetConfigCenter();
    const cc = getConfigCenter();
    cc.set("memory.vault_path", "/test/vault", "test", false);
    const all = cc.getAll();
    expect(all["memory.vault_path"]).toBeDefined();
    expect(all["memory.vault_path"].value).toBe("/test/vault");
    expect(all["memory.vault_path"].source).toBe("runtime");
  });
});

// ═══════════════════════════════════════════════════════════════════
// 4. EventBus integration
// ═══════════════════════════════════════════════════════════════════
describe("EventBus integration", () => {
  it("Publish 100 events with subscriber, all received", async () => {
    const { eventBus } = await import("../src/dre/runtime/event-bus.js");
    let count = 0;

    const id = eventBus.subscribe("eventbus.test.100", () => { count++; });
    for (let i = 0; i < 100; i++) {
      eventBus.publish({ type: "eventbus.test.100", source: "test", data: { i }, priority: "normal" });
    }
    eventBus.unsubscribe(id);

    expect(count).toBe(100);
  });

  it("Subscribe/unsubscribe pattern - only first batch received", async () => {
    const { eventBus } = await import("../src/dre/runtime/event-bus.js");
    let count = 0;

    const ids: string[] = [];
    for (let i = 0; i < 10; i++) {
      ids.push(eventBus.subscribe("eventbus.test.unsub", () => { count++; }));
    }

    eventBus.publish({ type: "eventbus.test.unsub", source: "test", data: {}, priority: "normal" });
    expect(count).toBe(10);

    for (const id of ids) {
      eventBus.unsubscribe(id);
    }

    eventBus.publish({ type: "eventbus.test.unsub", source: "test", data: {}, priority: "normal" });
    expect(count).toBe(10);
  });
});

// ═══════════════════════════════════════════════════════════════════
// 5. HttpRouter integration
// ═══════════════════════════════════════════════════════════════════
describe("HttpRouter integration", () => {
  it("Register 100 routes, execute each, verify non-null response", async () => {
    const { HttpRouter } = await import("../src/core/http-router.js");
    const router = new HttpRouter();

    for (let i = 0; i < 100; i++) {
      router.register({
        method: "GET",
        path: `/route-test/${i}`,
        handler: async (_ctx: RouteContext) => new Response(`route-${i}`),
      });
    }

    for (let i = 0; i < 100; i++) {
      const routeCtx: RouteContext = {
        url: new URL(`http://localhost/route-test/${i}`),
        req: new Request(`http://localhost/route-test/${i}`, { method: "GET" }),
        vault: null,
        db: null as any,
        pipeline: null as any,
        healthMonitor: null as any,
        fileWatcher: null,
        startupTime: Date.now(),
        baseHeaders: {},
        jsonResponse: (data, status) => new Response(JSON.stringify(data), { status }),
      };
      const response = await router.execute(routeCtx);
      expect(response).not.toBeNull();
      expect(response!.status).toBe(200);
    }
  });

  it("Method mismatch (register GET, request POST) returns null", async () => {
    const { HttpRouter } = await import("../src/core/http-router.js");
    const router = new HttpRouter();

    router.register({
      method: "GET",
      path: "/method-test",
      handler: async (_ctx: RouteContext) => new Response("ok"),
    });

    const routeCtx: RouteContext = {
      url: new URL("http://localhost/method-test"),
      req: new Request("http://localhost/method-test", { method: "POST" }),
      vault: null,
      db: null as any,
      pipeline: null as any,
      healthMonitor: null as any,
      fileWatcher: null,
      startupTime: Date.now(),
      baseHeaders: {},
      jsonResponse: (data, status) => new Response(JSON.stringify(data), { status }),
    };
    const response = await router.execute(routeCtx);
    expect(response).toBeNull();
  });
});
