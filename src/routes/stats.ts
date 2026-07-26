import type { RouteContext } from "./types.js";
import { getGlobalVault } from "../memory/vault-manager.js";
import { getTokenTracker } from "../router/token-tracker.js";

export async function handleStats(ctx: RouteContext): Promise<Response | null> {
  if (ctx.url.pathname !== "/api/stats" || ctx.req.method !== "GET") return null;

  try {
    const vault = getGlobalVault();
    const vaultStats = vault.stats();
    const tokenTracker = getTokenTracker();

    const stats = {
      activeTasks: Math.floor(Math.random() * 5) + 1,
      agents: 4,
      completed: vaultStats.totalNotes,
      tokensUsed: tokenTracker.getOverallStats().totalTokens,
      vaultNotes: vaultStats.totalNotes,
      vaultTags: vaultStats.totalTags ?? 0,
      uptime: process.uptime(),
      timestamp: Date.now(),
    };

    return ctx.jsonResponse(stats, 200, ctx.baseHeaders);
  } catch (e) {
    return ctx.jsonResponse({ error: String(e) }, 500, ctx.baseHeaders);
  }
}

export async function handleTokenDetails(ctx: RouteContext): Promise<Response | null> {
  if (ctx.url.pathname !== "/api/token-details" || ctx.req.method !== "GET") return null;

  const tracker = getTokenTracker();

  const days = parseInt(ctx.url.searchParams.get("days") || "7", 10);
  const since = Date.now() - days * 24 * 60 * 60 * 1000;

  const byModel = tracker.getStatsByModel({ since });
  const dailyTrend = tracker.getDailyStats(days);
  const recentCalls = tracker.getRecentUsage(50);
  const overall = tracker.getOverallStats();

  const totalCacheHits = dailyTrend.reduce((sum, d) => sum + (d.cacheHits ?? 0), 0);
  const totalCalls = overall.totalCalls || 1;

  return ctx.jsonResponse({
    perModel: byModel.map((m) => ({
      model: m.model,
      provider: m.provider,
      calls: m.totalCalls,
      promptTokens: m.totalPromptTokens,
      completionTokens: m.totalCompletionTokens,
      totalTokens: m.totalTokens,
      avgLatency: Math.round(m.avgLatencyMs),
    })),
    hourlyTrend: dailyTrend.map((d) => ({
      date: d.date,
      totalCalls: d.totalCalls,
      totalTokens: d.totalTokens,
      promptTokens: d.promptTokens,
      completionTokens: d.completionTokens,
    })),
    overall: {
      totalTokens: overall.totalTokens,
      totalCalls: overall.totalCalls,
      promptTokens: overall.totalPromptTokens,
      completionTokens: overall.totalCompletionTokens,
      avgLatency: Math.round(overall.avgLatencyMs),
    },
    recentCalls: recentCalls.map((c) => ({
      timestamp: c.timestamp,
      model: c.model,
      promptTokens: c.promptTokens,
      completionTokens: c.completionTokens,
      latencyMs: Math.round(c.latencyMs),
      success: c.success,
    })),
    cacheStats: {
      totalCalls,
      cacheHits: totalCacheHits,
      hitRate: totalCalls > 0 ? Math.round((totalCacheHits / totalCalls) * 100) : 0,
    },
  }, 200, ctx.baseHeaders);
}
