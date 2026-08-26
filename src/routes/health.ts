/**
 * Health, metrics, and dashboard routes
 */
import type { RouteContext } from "./types.js";
import { safeStringEqual } from "../utils/auth-check.js";
import { readString } from "../utils/env.js";

/**
 * 二因素写保护（审计 S1，2026-08-25）：AXIOM_SECOND_FACTOR_TOKEN 未配置时
 * 放行（fail-open，与 sandbox.ts requireAuthToken 调用语义一致）；
 * 配置后不匹配 → 403。
 */
function requireSecondFactorToken(ctx: RouteContext): Response | null {
  const expected = readString("AXIOM_SECOND_FACTOR_TOKEN");
  if (!expected) return null;
  const provided =
    ctx.req.headers.get("x-api-key") ||
    ctx.req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ||
    "";
  if (safeStringEqual(provided, expected)) return null;
  return ctx.jsonResponse(
    { error: "Unauthorized - second factor token required" },
    403,
    ctx.baseHeaders,
  );
}

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

export async function handleApiDocs(ctx: RouteContext): Promise<Response | null> {
  if (ctx.url.pathname === "/api" && ctx.req.method === "GET") {
    const { getTokenTracker } = await import("../router/token-tracker.js");
    const tracker = getTokenTracker();
    const overallStats = tracker.getOverallStats();

    return ctx.jsonResponse({
      version: "2.9.0",
      documentation: {
        health: "GET /health — System health with module status",
        metrics: "GET /metrics — Prometheus-format metrics",
        stats: "GET /stats — Database and cache statistics",
        config: "GET /config — Current configuration",
        chat: "POST /chat — Send message (streaming supported via /chat/stream)",
        search: "GET /search?q=... — Unified search",
        vault: "GET /vault/stats — Vault statistics",
        knowledge: "GET /knowledge/pending-review — Pending knowledge reviews",
        agents: "GET /agents/status — Agent status",
        eval: "GET /eval/stats — Model evaluation stats",
        kg: "GET /kg/stats — Knowledge graph stats",
        ocr: "POST /ocr/scan — OCR document scanning",
        research: "POST /research/run — Deep research",
        plugins: "GET /plugins — Plugin list",
        consciousness: "GET /consciousness/status — Consciousness status",
        tokenUsage: "GET /memory/usage — Per-model token usage",
        trends: "GET /stats/trends?days=7 — Usage trends",
      },
      tokenStats: {
        totalTokens: overallStats.totalTokens,
        totalCalls: overallStats.totalCalls,
      },
      endpoints: [
        "/health", "/metrics", "/stats", "/config", "/api",
        "/chat", "/chat/stream", "/search", "/web-search",
        "/vault/stats", "/vault/note", "/vault/atomic",
        "/kg/stats", "/kg/entities", "/kg/search",
        "/agents/status", "/eval/stats", "/eval/models",
        "/ocr/scan", "/research/run", "/plugins",
        "/consciousness/status", "/memory/usage", "/stats/trends",
        "/knowledge/pending-review", "/proxies",
      ],
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
    const { getConfig } = await import("../core/config-center.js");
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
    // 安全（2026-07-26 审查修复）：绝不序列化任何令牌/密钥字段。
    // 此前 gateway.auth.token（即 AXIOM_AUTH_TOKEN）、obsidianApiToken、
    // serpapiKey 均以明文返回，本地任意进程可窃取并用于远程访问。
    const { auth: _auth, ...safeGateway } = config.gateway as typeof config.gateway & { auth?: unknown };
    const { obsidianApiToken: _obsToken, ...safeMemory } = config.memory as typeof config.memory & { obsidianApiToken?: unknown };
    const { serpapiKey: _serpKey, ...safeCrawler } = config.crawler as typeof config.crawler & { serpapiKey?: unknown };
    return ctx.jsonResponse({
      gateway: { ...safeGateway, authConfigured: Boolean(config.gateway?.auth?.token) },
      models: safeModels,
      memory: safeMemory,
      crawler: safeCrawler,
    }, 200, ctx.baseHeaders);
  }
  if (ctx.url.pathname === "/config" && ctx.req.method === "POST") {
    const authErr = requireSecondFactorToken(ctx);
    if (authErr) return authErr;
    try {
      const body = await ctx.req.json();
      const { reloadConfig } = await import("../core/config-center.js");
      // 只支持更新 gateway 和 crawler 配置
      const fs = await import("fs");
      const YAML = await import("yaml");
      // 安全回写：以原始文件为基（parseDocument 保留注释与 ${VAR} 占位符），
      // 仅应用请求中的增量——绝不把运行时解析后的真实 token/apiKey 序列化回跟踪文件。
      const raw = fs.readFileSync("./config/axiom.yaml", "utf-8");
      const doc = YAML.parseDocument(raw);
      for (const section of ["gateway", "crawler"]) {
        if (body[section] && typeof body[section] === "object") {
          for (const [k, v] of Object.entries(body[section])) {
            doc.setIn([section, k], v);
          }
        }
      }
      fs.writeFileSync("./config/axiom.yaml", doc.toString(), "utf-8");
      reloadConfig();
      return ctx.jsonResponse({ success: true, message: "Config updated" }, 200, ctx.baseHeaders);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return ctx.jsonResponse({ error: msg }, 400, ctx.baseHeaders);
    }
  }
  return null;
}

export async function handlePermissionCheck(ctx: RouteContext): Promise<Response | null> {
  if (ctx.url.pathname !== "/permissions/check" || ctx.req.method !== "POST") return null
  try {
    const body = await ctx.req.json() as { type: "command" | "file"; command?: string; path?: string; operation?: string }
    if (body.type === "command" && body.command) {
      const { checkCommandPermission } = await import("../utils/permissions.js")
      return ctx.jsonResponse(checkCommandPermission(body.command), 200, ctx.baseHeaders)
    }
    if (body.type === "file" && body.path && body.operation) {
      const { checkFilePermission } = await import("../utils/permissions.js")
      return ctx.jsonResponse(checkFilePermission(body.path, body.operation as "read" | "write" | "delete" | "execute"), 200, ctx.baseHeaders)
    }
    return ctx.jsonResponse({ error: "Invalid request" }, 400)
  } catch (e) {
    return ctx.jsonResponse({ error: String(e) }, 500)
  }
}

export async function handlePermissionConfirm(ctx: RouteContext): Promise<Response | null> {
  if (ctx.url.pathname !== "/permissions/confirm" || ctx.req.method !== "POST") return null
  try {
    const body = await ctx.req.json() as { confirmationId: string }
    const { confirmOperation } = await import("../utils/permissions.js")
    const result = confirmOperation(body.confirmationId)
    return ctx.jsonResponse(result, result.approved ? 200 : 403, ctx.baseHeaders)
  } catch (e) {
    return ctx.jsonResponse({ error: String(e) }, 500)
  }
}

/**
 * GET/POST /permissions/mode — 查询或设置权限自动接收模式。
 *
 * 响应（GET）：
 *   { autoAccept: boolean, highRiskAlwaysConfirmed: true }
 *
 * 请求（POST）：{ autoAccept: boolean }
 * 响应（POST）：{ autoAccept: boolean, highRiskAlwaysConfirmed: true }
 *
 * 安全说明：high-risk 操作永远需要手动确认，不受 autoAccept 影响。
 */
export async function handlePermissionMode(ctx: RouteContext): Promise<Response | null> {
  const path = ctx.url.pathname;
  if (path !== "/permissions/mode") return null;

  const { isAutoAcceptMode, setAutoAcceptMode } = await import("../utils/permissions.js");

  if (ctx.req.method === "GET") {
    return ctx.jsonResponse(
      { autoAccept: isAutoAcceptMode(), highRiskAlwaysConfirmed: true },
      200,
      ctx.baseHeaders,
    );
  }

  if (ctx.req.method === "POST") {
    const authErr = requireSecondFactorToken(ctx);
    if (authErr) return authErr;
    try {
      const body = (await ctx.req.json()) as { autoAccept?: boolean };
      const next = setAutoAcceptMode(!!body.autoAccept);
      return ctx.jsonResponse(
        { autoAccept: next, highRiskAlwaysConfirmed: true },
        200,
        ctx.baseHeaders,
      );
    } catch (e) {
      return ctx.jsonResponse({ error: String(e) }, 500, ctx.baseHeaders);
    }
  }

  return null;
}
