/**
 * Health, metrics, and dashboard routes
 */
import type { RouteContext } from "./types.js";

export async function handleHealth(ctx: RouteContext): Promise<Response | null> {
  if (ctx.url.pathname === "/health" && ctx.req.method === "GET") {
    const checks = await ctx.healthMonitor.checkAll();
    // Phase P1-6: read from the async-refreshed cache instead of calling
    // vault.stats() synchronously inside the request hot path.
    const { vaultStatsCache } = await import("../utils/vault-stats-cache.js");
    const vStats = vaultStatsCache.read();
    const { searchAggregator } = await import("../crawl/search-engines.js");
    const { searchCache, crawlCache } = await import("../utils/cache.js");
    const { wsManager } = await import("../utils/websocket.js");

    return ctx.jsonResponse({
      status: "ok", timestamp: new Date().toISOString(), version: "2.2.0",
      uptime: Math.floor((Date.now() - ctx.startupTime) / 1000),
      checks, searchEngines: searchAggregator.listEngines(),
      vault: vStats ? { notes: vStats.totalNotes, words: vStats.totalWords } : null,
      cache: { search: searchCache.stats(), crawl: crawlCache.stats() },
      websocket: wsManager.getStats(),
    }, 200, ctx.baseHeaders);
  }
  return null;
}

export async function handleMetrics(ctx: RouteContext): Promise<Response | null> {
  if (ctx.url.pathname === "/metrics" && ctx.req.method === "GET") {
    const { metrics } = await import("../utils/metrics.js");
    return new Response(metrics.getPrometheusFormat(), {
      status: 200,
      headers: { "Content-Type": "text/plain; version=0.0.4", ...ctx.baseHeaders },
    });
  }
  return null;
}

export async function handleDashboard(ctx: RouteContext): Promise<Response | null> {
  if (ctx.url.pathname === "/" || ctx.url.pathname === "/index.html") {
    const { createCorsHeaders } = await import("../utils/security.js");
    const file = Bun.file("./public/index.html");
    if (await file.exists()) {
      return new Response(file, { headers: { "Content-Type": "text/html", ...createCorsHeaders() } });
    }
    return ctx.jsonResponse({ error: "Dashboard not found" }, 404);
  }
  return null;
}

export async function handleStats(ctx: RouteContext): Promise<Response | null> {
  if (ctx.url.pathname === "/stats" && ctx.req.method === "GET") {
    const { searchCache, crawlCache } = await import("../utils/cache.js");
    const { vaultStatsCache } = await import("../utils/vault-stats-cache.js");
    const s = (table: string) => (ctx.db.query(`SELECT COUNT(*) as c FROM ${table}`).get() as { c: number } | null)?.c || 0;
    return ctx.jsonResponse({
      searchCount: s("search_history"), crawlCount: s("crawl_results"),
      memoryCount: s("conversations"), entityCount: s("entities"),
      relationCount: s("relationships"), taskCount: s("tasks"),
      uptime: Math.floor((Date.now() - ctx.startupTime) / 1000),
      // Phase P1-6: cached, never blocks the request thread.
      vault: vaultStatsCache.read(),
      cache: { search: searchCache.stats(), crawl: crawlCache.stats() },
    }, 200, ctx.baseHeaders);
  }
  return null;
}

export async function handleCacheStats(ctx: RouteContext): Promise<Response | null> {
  if (ctx.url.pathname === "/cache/stats" && ctx.req.method === "GET") {
    const { searchCache, crawlCache } = await import("../utils/cache.js");
    return ctx.jsonResponse({ search: searchCache.stats(), crawl: crawlCache.stats() }, 200, ctx.baseHeaders);
  }
  return null;
}

export async function handleEngines(ctx: RouteContext): Promise<Response | null> {
  if (ctx.url.pathname === "/engines" && ctx.req.method === "GET") {
    const { searchAggregator } = await import("../crawl/search-engines.js");
    return ctx.jsonResponse({ engines: searchAggregator.listEngines() }, 200, ctx.baseHeaders);
  }
  return null;
}

export async function handleMemoryGateStats(ctx: RouteContext): Promise<Response | null> {
  if (ctx.url.pathname === "/memory-gate/stats" && ctx.req.method === "GET") {
    const { getMemoryGate } = await import("../memory/memory-gate.js");
    const gate = getMemoryGate();
    return ctx.jsonResponse({ memoryGate: gate.stats() }, 200, ctx.baseHeaders);
  }
  return null;
}

export async function handleTrends(ctx: RouteContext): Promise<Response | null> {
  if (ctx.url.pathname === "/stats/trends" && ctx.req.method === "GET") {
    const days = parseInt(ctx.url.searchParams.get("days") || "7", 10);
    const since = Date.now() - days * 24 * 60 * 60 * 1000;

    // 搜索趋势
    const searchTrend = ctx.db.query(`
      SELECT date(created_at / 1000, 'unixepoch') as day, COUNT(*) as count
      FROM search_history WHERE created_at >= ?
      GROUP BY day ORDER BY day DESC LIMIT ?
    `).all(since, days) as Array<{ day: string; count: number }>;

    // 对话趋势
    const chatTrend = ctx.db.query(`
      SELECT date(created_at / 1000, 'unixepoch') as day, COUNT(*) as count
      FROM conversations WHERE created_at >= ?
      GROUP BY day ORDER BY day DESC LIMIT ?
    `).all(since, days) as Array<{ day: string; count: number }>;

    // 模型调用趋势
    const modelTrend = ctx.db.query(`
      SELECT model_name, COUNT(*) as count, AVG(latency_ms) as avg_latency
      FROM model_usage WHERE created_at >= ?
      GROUP BY model_name ORDER BY count DESC LIMIT 10
    `).all(since) as Array<{ model_name: string; count: number; avg_latency: number }>;

    // 任务趋势
    const taskTrend = ctx.db.query(`
      SELECT status, COUNT(*) as count
      FROM tasks WHERE created_at >= ? OR updated_at >= ?
      GROUP BY status
    `).all(since, since) as Array<{ status: string; count: number }>;

    return ctx.jsonResponse({
      days,
      searchTrend: searchTrend.reverse(),
      chatTrend: chatTrend.reverse(),
      modelTrend,
      taskTrend,
      generatedAt: new Date().toISOString(),
    }, 200, ctx.baseHeaders);
  }
  return null;
}

export async function handleConfig(ctx: RouteContext): Promise<Response | null> {
  if (ctx.url.pathname === "/config" && ctx.req.method === "GET") {
    const { getConfig } = await import("../utils/config.js");
    const config = getConfig();
    // 过滤掉敏感字段（apiKey 只返回前8位）
    const safeModels = config.models.map((m) => ({
      name: m.name,
      provider: m.provider,
      model: m.model,
      tier: m.tier,
      purpose: m.purpose,
      priority: m.priority,
      freeOnly: m.freeOnly,
      apiKeyMasked: m.apiKey ? `${m.apiKey.slice(0, 8)}...` : "",
    }));
    return ctx.jsonResponse({
      gateway: config.gateway,
      models: safeModels,
      memory: config.memory,
      crawler: config.crawler,
    }, 200, ctx.baseHeaders);
  }
  if (ctx.url.pathname === "/config" && ctx.req.method === "POST") {
    try {
      const body = await ctx.req.json();
      const { getConfig, reloadConfig } = await import("../utils/config.js");
      const current = getConfig();
      // 只支持更新 gateway 和 crawler 配置
      const updated = {
        ...current,
        gateway: { ...current.gateway, ...body.gateway },
        crawler: { ...current.crawler, ...body.crawler },
      };
      // 写回 YAML（简单实现：直接覆盖）
      const fs = await import("fs");
      const YAML = await import("yaml");
      const yamlStr = YAML.stringify(updated);
      fs.writeFileSync("./config/axiom.yaml", yamlStr, "utf-8");
      reloadConfig();
      return ctx.jsonResponse({ success: true, message: "Config updated" }, 200, ctx.baseHeaders);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return ctx.jsonResponse({ error: msg }, 400, ctx.baseHeaders);
    }
  }
  return null;
}
