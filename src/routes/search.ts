/**
 * Search routes: vault search, web search, enhanced search, suggestions, history
 */
import { logger } from "../utils/logger.js";
import { isSafeUrl } from "../utils/url-safety.js";
import type { RouteContext } from "./types.js";
import { withTimeout } from "../utils/resilience.js";
import type { SearchEngineResult } from "../crawl/search-engines.js";
import type { UnifiedSearchResult } from "../crawl/unified-search.js";
import type { StructuredCrawlResult } from "../crawl/data-pipeline.js";

// SSRF 防护已抽至共享模块 utils/url-safety.ts（含重定向逐跳校验，见 proxy-fetch ssrfGuard）

export async function handleVaultSearch(ctx: RouteContext): Promise<Response | null> {
  if (ctx.url.pathname === "/search" && ctx.req.method === "GET") {
    const query = ctx.url.searchParams.get("q");
    // /search 同时是前端页面路由：无 q 且浏览器导航（Accept: text/html）→ 返回 null 让 SPA 回退；API 无 q → 400
    if (!query) {
      const accept = ctx.req.headers.get("accept") ?? "";
      if (accept.includes("text/html")) return null;
      return ctx.jsonResponse({ error: "Missing q param" }, 400, ctx.baseHeaders);
    }
    if (!ctx.vault) return ctx.jsonResponse({ error: "Vault not initialized" }, 503, ctx.baseHeaders);

    const types = ctx.url.searchParams.get("types")?.split(",").filter(Boolean);
    const tags = ctx.url.searchParams.get("tags")?.split(",").filter(Boolean);
    const para = ctx.url.searchParams.get("para") || undefined;
    const limit = Number(ctx.url.searchParams.get("limit")) || 20;
    const results = ctx.vault.search(query, { types, tags, paraCategory: para, limit });
    return ctx.jsonResponse({ query, strategy: "deterministic", results }, 200, ctx.baseHeaders);
  }
  return null;
}

export async function handleWebSearch(ctx: RouteContext): Promise<Response | null> {
  if (ctx.url.pathname === "/web-search" && ctx.req.method === "GET") {
    const query = ctx.url.searchParams.get("q");
    if (!query) return ctx.jsonResponse({ error: "Missing q param" }, 400, ctx.baseHeaders);

    const { searchCache } = await import("../utils/cache.js");
    const { wsManager } = await import("../utils/websocket.js");

    const engines = ctx.url.searchParams.get("engines")?.split(",") || undefined;
    const num = Number(ctx.url.searchParams.get("num")) || 10;
    const cacheKey = `${query}::${engines?.join(",") || "default"}::${num}`;
    const results = await searchCache.getOrSet(cacheKey, async () => {
      return ctx.pipeline.searchMulti(query, { engines, num });
    }, 10 * 60 * 1000) as SearchEngineResult[];

    ctx.db.run(`INSERT INTO search_history (query, query_hash, engines, results_count, created_at) VALUES (?, ?, ?, ?, ?)`,
      [query, String(Bun.hash(query)), engines?.join(",") || "", results.length, Date.now()]);

    if (ctx.vault) {
      ctx.vault.writeSearchResult(query, engines || ["duckduckgo"], results.map(r => ({ title: r.title, link: r.link, snippet: r.snippet })))
        .catch((e: unknown) => logger.warn("Failed to persist search result", { query, error: (e as Error).message }));
    }

    wsManager.broadcast({ type: "search.completed", payload: { query, resultCount: results.length }, timestamp: new Date().toISOString() });
    return ctx.jsonResponse({ query, engines, results }, 200, ctx.baseHeaders);
  }
  return null;
}

export async function handleEnhancedSearch(ctx: RouteContext): Promise<Response | null> {
  if (ctx.url.pathname === "/enhanced-search" && ctx.req.method === "GET") {
    const query = ctx.url.searchParams.get("q");
    if (!query) return ctx.jsonResponse({ error: "Missing q param" }, 400, ctx.baseHeaders);

    const { unifiedSearch } = await import("../crawl/unified-search.js");
    const { wsManager } = await import("../utils/websocket.js");

    const mode = (ctx.url.searchParams.get("mode") as "deep" | "academic" | "news" | "code" | "quick") || "quick";
    const num = Number(ctx.url.searchParams.get("num")) || 10;

    let results: UnifiedSearchResult[];
    switch (mode) {
      case "deep": results = await unifiedSearch.deepSearch(query, num); break;
      case "academic": results = await unifiedSearch.academicSearch(query, num); break;
      case "news": results = await unifiedSearch.newsSearch(query, num); break;
      case "code": results = await unifiedSearch.codeSearch(query, num); break;
      default: results = await unifiedSearch.quickSearch(query, num); break;
    }

    // Persist search results to Vault + SQLite
    if (ctx.vault) {
      ctx.vault.writeSearchResult(query, ['unified'], results.map(r => ({ title: r.title, link: r.link, snippet: r.snippet })))
        .catch((e: unknown) => logger.warn("Failed to persist unified search result", { query, error: (e as Error).message }));
    }

    wsManager.broadcast({
      type: "search.completed",
      payload: { query, mode, resultCount: results.length },
      timestamp: new Date().toISOString(),
    });

    return ctx.jsonResponse({ query, mode, results }, 200, ctx.baseHeaders);
  }
  return null;
}

export async function handleSearchSuggestions(ctx: RouteContext): Promise<Response | null> {
  if (ctx.url.pathname === "/search/suggestions" && ctx.req.method === "GET") {
    const query = ctx.url.searchParams.get("q");
    if (!query) return ctx.jsonResponse({ error: "Missing q param" }, 400, ctx.baseHeaders);

    // Simple suggestion: return recent searches matching prefix
    interface SuggestionRow { query: string }
    const rows = ctx.db.query(
      "SELECT DISTINCT query FROM search_history WHERE query LIKE ? ORDER BY created_at DESC LIMIT 10"
    ).all(`${query}%`) as SuggestionRow[];
    return ctx.jsonResponse({ query, suggestions: rows.map((r: SuggestionRow) => r.query) }, 200, ctx.baseHeaders);
  }
  return null;
}

export async function handleSearchStats(ctx: RouteContext): Promise<Response | null> {
  if (ctx.url.pathname === "/search/stats" && ctx.req.method === "GET") {
    const { unifiedSearch } = await import("../crawl/unified-search.js");
    return ctx.jsonResponse(unifiedSearch.getStats(), 200, ctx.baseHeaders);
  }
  return null;
}

export async function handleSearchHistory(ctx: RouteContext): Promise<Response | null> {
  if (ctx.url.pathname === "/search/history" && ctx.req.method === "GET") {
    const { unifiedSearch } = await import("../crawl/unified-search.js");
    const limit = Number(ctx.url.searchParams.get("limit")) || 50;
    const offset = Number(ctx.url.searchParams.get("offset")) || 0;
    const history = unifiedSearch.getHistory(limit, offset);
    return ctx.jsonResponse({ history, limit, offset }, 200, ctx.baseHeaders);
  }
  return null;
}

export async function handleRecentSearches(ctx: RouteContext): Promise<Response | null> {
  if (ctx.url.pathname === "/searches/recent" && ctx.req.method === "GET") {
    const rows = ctx.db.query("SELECT * FROM search_history ORDER BY created_at DESC LIMIT ?").all(Number(ctx.url.searchParams.get("limit")) || 20) as Array<Record<string, unknown>>;
    return ctx.jsonResponse({ searches: rows }, 200, ctx.baseHeaders);
  }
  return null;
}

export async function handleWebFetch(ctx: RouteContext): Promise<Response | null> {
  if (ctx.url.pathname === "/web-fetch" && ctx.req.method === "GET") {
    const targetUrl = ctx.url.searchParams.get("url");
    if (!targetUrl) return ctx.jsonResponse({ error: "Missing url param" }, 400, ctx.baseHeaders);

    // SSRF protection: block internal/private IPs and dangerous protocols
    if (!isSafeUrl(targetUrl)) {
      return ctx.jsonResponse({ error: "URL blocked by security policy" }, 403, ctx.baseHeaders);
    }

    const { crawlCache } = await import("../utils/cache.js");
    const { wsManager } = await import("../utils/websocket.js");

    const cacheKey = `crawl::${targetUrl}`;
    const cached = await crawlCache.get(cacheKey);
    let result = cached ? (cached as unknown as StructuredCrawlResult) : undefined;
    if (!result) {
      result = (await ctx.pipeline.crawlStructured(targetUrl)) ?? undefined;
      if (result) {
        crawlCache.set(cacheKey, result as unknown as Record<string, unknown>, 30 * 60 * 1000);
        await ctx.pipeline.saveCrawlResult(result);
      }
    }
    if (!result) return ctx.jsonResponse({ error: "Fetch failed" }, 502, ctx.baseHeaders);

    wsManager.broadcast({ type: "crawl.completed", payload: { url: targetUrl, title: result.title }, timestamp: new Date().toISOString() });
    return ctx.jsonResponse(result, 200, ctx.baseHeaders);
  }
  return null;
}

/** GET /lightpanda/status -- Check Lightpanda availability */
export async function handleLightpandaStatus(ctx: RouteContext): Promise<Response | null> {
  if (ctx.url.pathname !== "/lightpanda/status" || ctx.req.method !== "GET") return null;
  const { getLightpandaStatus } = await import("../crawl/lightpanda-client.js");
  try {
    // 有界超时：状态检查不允许无限等待底层二进制/端口探测
    const status = await withTimeout(getLightpandaStatus(), 3000);
    return ctx.jsonResponse(status, 200, ctx.baseHeaders);
  } catch (e) {
    return ctx.jsonResponse({ available: false, error: e instanceof Error ? e.message : String(e) }, 200, ctx.baseHeaders);
  }
}

/** GET /direct-search?q=X&engines=google,bing -- Direct search without API keys */
export async function handleDirectSearch(ctx: RouteContext): Promise<Response | null> {
  if (ctx.url.pathname !== "/direct-search" || ctx.req.method !== "GET") return null;
  const query = ctx.url.searchParams.get("q");
  if (!query) return ctx.jsonResponse({ error: "Missing q parameter" }, 400, ctx.baseHeaders);
  // SSRF 防护：若查询本身是 URL（如用户直接传 URL），需校验私网/整数IP
  if (/^https?:\/\//i.test(query) && !isSafeUrl(query)) {
    return ctx.jsonResponse({ error: "URL blocked by security policy" }, 403, ctx.baseHeaders);
  }
  const engines = ctx.url.searchParams.get("engines")?.split(",") || ["google", "bing"];
  const num = parseInt(ctx.url.searchParams.get("num") || "10", 10);
  const { directMultiSearch } = await import("../crawl/lightpanda-search.js");
  const results = await directMultiSearch(query, { engines, num });
  return ctx.jsonResponse({ results, count: results.length, query }, 200, ctx.baseHeaders);
}

/** POST /search/decompose -- Decompose a complex query into sub-queries */
export async function handleQueryDecompose(ctx: RouteContext): Promise<Response | null> {
  if (ctx.url.pathname !== "/search/decompose" || ctx.req.method !== "POST") return null;
  const body = await ctx.req.json().catch(() => ({}));
  const { query } = body;
  if (!query) return ctx.jsonResponse({ error: "query is required" }, 400, ctx.baseHeaders);

  const { decomposeQuery } = await import("../agents/query-decomposer.js");
  const result = decomposeQuery(query);

  // If vault is available, also run search
  let fragments: import("../agents/query-decomposer.js").KnowledgeFragment[] = [];
  if (ctx.vault) {
    const { searchKnowledgeBase } = await import("../agents/query-decomposer.js");
    fragments = await searchKnowledgeBase(result.subQueries, ctx.vault);
  }

  return ctx.jsonResponse({ decomposed: result, fragments, count: fragments.length }, 200, ctx.baseHeaders);
}
