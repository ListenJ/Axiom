/**
 * Search routes: vault search, web search, enhanced search, suggestions, history
 */
import { logger } from "../utils/logger.js";
import type { RouteContext } from "./types.js";

export async function handleVaultSearch(ctx: RouteContext): Promise<Response | null> {
  if (ctx.url.pathname === "/search" && ctx.req.method === "GET") {
    const query = ctx.url.searchParams.get("q");
    if (!query) return ctx.jsonResponse({ error: "Missing q param" }, 400, ctx.baseHeaders);
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
    }, 10 * 60 * 1000);

    ctx.db.run(`INSERT INTO search_history (query, query_hash, engines, results_count, created_at) VALUES (?, ?, ?, ?, ?)`,
      [query, String(Bun.hash(query)), engines?.join(",") || "", (results as any[]).length, Date.now()]);

    if (ctx.vault) {
      ctx.vault.writeSearchResult(query, engines || ["duckduckgo"], results as any[])
        .catch(e => logger.warn("Failed to persist search result", { query, error: (e as Error).message }));
    }

    wsManager.broadcast({ type: "search.completed", payload: { query, resultCount: (results as any[]).length }, timestamp: new Date().toISOString() });
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

    const mode = (ctx.url.searchParams.get("mode") as any) || "quick";
    const num = Number(ctx.url.searchParams.get("num")) || 10;

    let results: any[];
    switch (mode) {
      case "deep": results = await unifiedSearch.deepSearch(query, num); break;
      case "academic": results = await unifiedSearch.academicSearch(query, num); break;
      case "news": results = await unifiedSearch.newsSearch(query, num); break;
      case "code": results = await unifiedSearch.codeSearch(query, num); break;
      default: results = await unifiedSearch.quickSearch(query, num); break;
    }

    // Persist search results to Vault + SQLite
    if (ctx.vault) {
      ctx.vault.writeSearchResult(query, ['unified'], results as any[])
        .catch(e => logger.warn("Failed to persist unified search result", { query, error: (e as Error).message }));
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
    const rows = ctx.db.query(
      "SELECT DISTINCT query FROM search_history WHERE query LIKE ? ORDER BY created_at DESC LIMIT 10"
    ).all(`${query}%`) as any[];
    return ctx.jsonResponse({ query, suggestions: rows.map((r: any) => r.query) }, 200, ctx.baseHeaders);
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
    const rows = ctx.db.query("SELECT * FROM search_history ORDER BY created_at DESC LIMIT ?").all(Number(ctx.url.searchParams.get("limit")) || 20) as any[];
    return ctx.jsonResponse({ searches: rows }, 200, ctx.baseHeaders);
  }
  return null;
}

export async function handleWebFetch(ctx: RouteContext): Promise<Response | null> {
  if (ctx.url.pathname === "/web-fetch" && ctx.req.method === "GET") {
    const targetUrl = ctx.url.searchParams.get("url");
    if (!targetUrl) return ctx.jsonResponse({ error: "Missing url param" }, 400, ctx.baseHeaders);

    const { crawlCache } = await import("../utils/cache.js");
    const { wsManager } = await import("../utils/websocket.js");

    const cacheKey = `crawl::${targetUrl}`;
    let result: any = crawlCache.get(cacheKey);
    if (!result) {
      result = await ctx.pipeline.crawlStructured(targetUrl);
      if (result) {
        crawlCache.set(cacheKey, result, 30 * 60 * 1000);
        await ctx.pipeline.saveCrawlResult(result);
      }
    }
    if (!result) return ctx.jsonResponse({ error: "Fetch failed" }, 502, ctx.baseHeaders);

    wsManager.broadcast({ type: "crawl.completed", payload: { url: targetUrl, title: result.title }, timestamp: new Date().toISOString() });
    return ctx.jsonResponse(result, 200, ctx.baseHeaders);
  }
  return null;
}
