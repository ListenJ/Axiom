/**
 * P2.1：工具运行时依赖注入（createInjectedToolContext）—— 不得静默降级
 *
 * 背景（本地未覆盖面审计 2026-10-22 #5）：MCP adaptTool 每次 `createToolContext` 只给空
 * localStore ⇒ queryTool 拿不到 vaultManager/searchEngine，本地记忆腿与统一搜索腿被静默跳过，
 * 工具仍返回 success。本文件把「注入失败必须响」变成可断言行为：
 *   - 缺依赖 → typed reason（vault-unavailable / search-engine-unavailable）且 warn（每 reason 一次）；
 *   - 注入成功 → localStore 里确实有 vaultManager/searchEngine（行为断言，不是读源码字符串）；
 *   - MCP 适配工具在降级时输出 `degraded` 原因码（不得返回"完整成功"的假象）；
 *   - 降级结果不得写入 pipeline 缓存（防止把一次缺依赖放大成 5 分钟假数据）。
 */
import { describe, test, expect, beforeEach, spyOn } from "bun:test";
import {
  createInjectedToolContext,
  probeToolRuntimeDeps,
  getToolRuntimeDepsStatus,
  resetToolRuntimeDepsForTests,
  type ToolRuntimeDepsProviders,
} from "../../src/tools/runtime-deps.js";
import { adaptTool } from "../../src/mcp/adapt-tool.js";
import { queryTool } from "../../src/tools/query-tool.js";
import { runPipeline } from "../../src/tools/pipeline.js";
import { createToolContext } from "../../src/tools/types.js";
import { logger } from "../../src/utils/logger.js";

const localVault = (hits: number) => ({
  searchHybrid: async () =>
    Array.from({ length: hits }, (_, i) => ({
      note: { title: `local-${i}`, path: `p/${i}.md`, content: `local content ${i}` },
      excerpt: `local content ${i}`,
    })),
  search: async () => [],
});

const searchEngine = (hits: number) => ({
  search: async () =>
    Array.from({ length: hits }, (_, i) => ({
      title: `web-${i}`,
      snippet: `web snippet ${i}`,
      url: `https://example.com/${i}`,
    })),
});

function healthyProviders(localHits = 3, webHits = 0): ToolRuntimeDepsProviders {
  return {
    loadVault: async () => localVault(localHits),
    loadSearchEngine: async () => searchEngine(webHits),
  };
}

beforeEach(() => {
  resetToolRuntimeDepsForTests();
});

describe("P2.1 createInjectedToolContext：依赖注入与 typed 降级原因", () => {
  test("依赖健康：localStore 真实注入 vaultManager/searchEngine，status 无 degraded", async () => {
    const { context, status } = await createInjectedToolContext("t-healthy", {
      providers: healthyProviders(),
    });
    expect(status.degraded).toEqual([]);
    expect(status.vault).toBe("ok");
    expect(status.searchEngine).toBe("ok");
    expect(status.lastCheckedAt).toBeGreaterThan(0);
    expect(context.localStore.get("vaultManager")).toBeDefined();
    expect(context.localStore.get("searchEngine")).toBeDefined();
    expect(getToolRuntimeDepsStatus().degraded).toEqual([]);
  });

  test("vault 加载失败 → degraded 带 vault-unavailable，warn 每 reason 只一次", async () => {
    const warnSpy = spyOn(logger, "warn");
    try {
      const providers: ToolRuntimeDepsProviders = {
        loadVault: async () => {
          throw new Error("vault init failed");
        },
        loadSearchEngine: async () => searchEngine(0),
      };
      const first = await createInjectedToolContext("t-vault-1", { providers });
      expect(first.status.degraded).toContain("vault-unavailable");
      expect(first.status.vault).toBe("unavailable");
      // 上下文仍然可用（降级而非致命），但必须带 typed 状态
      expect(first.context.localStore.get("runtimeDepsStatus")).toMatchObject({
        degraded: expect.arrayContaining(["vault-unavailable"]),
      });

      await createInjectedToolContext("t-vault-2", { providers });
      const vaultWarns = warnSpy.mock.calls.filter(
        (args) =>
          String(args[0] ?? "").includes("依赖不可用") &&
          (args[1] as { code?: string } | undefined)?.code === "vault-unavailable",
      );
      expect(vaultWarns.length).toBe(1);
    } finally {
      warnSpy.mockRestore();
    }
  });

  test("搜索通道加载失败 → degraded 带 search-engine-unavailable", async () => {
    const { status } = await probeToolRuntimeDeps(
      {
        loadVault: async () => localVault(1),
        loadSearchEngine: async () => {
          throw new Error("unified search module failed");
        },
      },
      "startup",
    );
    expect(status.degraded).toEqual(["search-engine-unavailable"]);
    expect(status.searchEngine).toBe("unavailable");
    expect(status.vault).toBe("ok");
  });

  test("adaptTool(query) 注入生效：本地腿结果真实返回，健康路径无 degraded 字段", async () => {
    const def = adaptTool(queryTool, { runtimeDeps: healthyProviders(3, 0) });
    const result = (await def.handler({ query: "memory probe" })) as {
      results: Array<{ source: string }>;
      degraded?: string[];
    };
    expect(result.results.length).toBe(3);
    expect(result.results.every((r) => r.source === "local")).toBe(true);
    expect(result.degraded).toBeUndefined();
  });

  test("adaptTool(query) 降级时不得返回成功假象：输出带 typed degraded 原因", async () => {
    const def = adaptTool(queryTool, {
      runtimeDeps: {
        loadVault: async () => {
          throw new Error("vault down");
        },
        // 搜索通道健康但只回 1 条 ⇒ 不触发真实网络
        loadSearchEngine: async () => searchEngine(1),
      },
    });
    const result = (await def.handler({ query: "degraded probe" })) as {
      results: Array<{ source: string }>;
      degraded?: string[];
    };
    expect(result.degraded).toContain("vault-unavailable");
    expect(result.results.some((r) => r.source === "web")).toBe(true);
  });

  test("降级查询结果不写 pipeline 缓存（避免把缺依赖放大成假数据）", async () => {
    const cacheSet: Array<{ key: string }> = [];
    const fakeCache = {
      get: async () => null,
      set: (key: string) => {
        cacheSet.push({ key });
      },
    };
    const ctx = createToolContext("t-cache");
    (ctx as unknown as { cache: typeof fakeCache }).cache = fakeCache;
    ctx.localStore.set("runtimeDepsStatus", {
      degraded: ["vault-unavailable"],
      vault: "unavailable",
      searchEngine: "ok",
      lastCheckedAt: Date.now(),
    });
    // 搜索通道已注入（避免真实网络）；local 腿缺失 → 输出 degraded
    ctx.localStore.set("searchEngine", searchEngine(1));
    const pipelineResult = await runPipeline(
      [{ tool: queryTool, input: { query: "cache-degraded-probe" } }],
      ctx,
    );
    expect(pipelineResult.error).toBeUndefined();
    const out = pipelineResult.stepResults[0] as { degraded?: string[] };
    expect(out.degraded).toContain("vault-unavailable");
    expect(cacheSet).toEqual([]);
  });
});
