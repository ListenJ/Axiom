/**
 * Search routes: vault search, web search, enhanced search, suggestions, history
 */
import { logger } from "../utils/logger.js";
import type { RouteContext } from "./types.js";
import type { SearchEngineResult } from "../crawl/search-engines.js";
import type { UnifiedSearchResult } from "../crawl/unified-search.js";
import type { StructuredCrawlResult } from "../crawl/data-pipeline.js";

// SSRF protection: block internal/private IPs and dangerous protocols
const BLOCKED_PROTOCOLS = ["file:", "ftp:", "gopher:", "dict:"];
const BLOCKED_HOSTS = ["localhost", "127.0.0.1", "0.0.0.0", "[::1]", "169.254.169.254", "metadata.google.internal"];

function isSafeUrl(urlStr: string): boolean {
  try {
    const parsed = new URL(urlStr);
    if (BLOCKED_PROTOCOLS.some(p => parsed.protocol === p)) return false;
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
    const hostname = parsed.hostname.toLowerCase();
    if (BLOCKED_HOSTS.some(h => hostname === h || hostname.endsWith("." + h))) return false;
    // Block private IP ranges
    if (/^10\./.test(hostname) || /^172\.(1[6-9]|2\d|3[01])\./.test(hostname) || /^192\.168\./.test(hostname)) return false;
    return true;
  } catch {
    return false;
  }
}

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
    let result = crawlCache.get(cacheKey) as StructuredCrawlResult | undefined;
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
