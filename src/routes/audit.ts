/**
 * 资源审查路由 —— GET /api/audit/diagnostics
 *
 * 汇总注册表中的模块资源统计 + 进程内存 + 运行时长，供运维/评审使用。
 * 注册位置（由主代理在 routes/index.ts 集成）：
 *   - import { handleAuditDiagnostics } from "./audit.js"
 *   - handlers 数组加入 handleAuditDiagnostics（建议在 handleHealth 之后）
 *   - registerTrieRoutes 注册 GET /api/audit/diagnostics
 */
import type { RouteContext } from "./types.js";
import {
  collectResources,
  listResourceNames,
  registerResource,
} from "../utils/resource-registry.js";
import { searchCache, crawlCache, llmCache } from "../utils/cache.js";
import { wsManager } from "../utils/websocket.js";
import { contextManager } from "../context/context-manager.js";

// ── 资源收集器注册（模块级，幂等）──────────────────────────────

function pick(
  src: Record<string, number | string | boolean>,
  keys: string[],
): Record<string, number | string | boolean> {
  const out: Record<string, number | string | boolean> = {};
  for (const k of keys) {
    const v = src[k];
    if (typeof v === "number" || typeof v === "string" || typeof v === "boolean") out[k] = v;
  }
  return out;
}

registerResource("cache.search", () => pick(searchCache.stats(), ["size", "hits", "misses", "hitRate"]));
registerResource("cache.crawl", () => pick(crawlCache.stats(), ["size", "hits", "misses", "hitRate"]));
registerResource("cache.llm", () => pick(llmCache.stats(), ["size", "hits", "misses", "hitRate"]));
registerResource("websocket", () => ({
  connectedClients: wsManager.getStats().connectedClients,
}));
registerResource("context", () => {
  const s = contextManager.getMemoryStats();
  return { entries: s.entries, totalTokens: s.totalTokens, oldestEntry: s.oldestEntry ?? 0 };
});

export async function handleAuditDiagnostics(ctx: RouteContext): Promise<Response | null> {
  if (ctx.url.pathname === "/api/audit/diagnostics" && ctx.req.method === "GET") {
    const mem = process.memoryUsage();
    const resources = collectResources();
    const degraded = resources.filter((r) => r.status === "degraded").length;
    return ctx.jsonResponse(
      {
        timestamp: new Date().toISOString(),
        uptimeSec: Math.floor((Date.now() - ctx.startupTime) / 1000),
        memory: {
          rss: mem.rss,
          heapUsed: mem.heapUsed,
          heapTotal: mem.heapTotal,
          external: mem.external,
        },
        resourceNames: listResourceNames(),
        resources,
        summary: { total: resources.length, ok: resources.length - degraded, degraded },
      },
      200,
      ctx.baseHeaders,
    );
  }
  return null;
}