/**
 * OpenClaw AI Agent — 主入口 v2.1
 * Vault 核心记忆引擎 + 确定性推理 + Obsidian 共享记忆库
 */
import { Database } from "bun:sqlite";
import { VaultManager } from "./memory/vault-manager.js";
import { DataPipeline } from "./crawl/data-pipeline.js";
import { searchAggregator } from "./crawl/search-engines.js";
import { enhancedSearch } from "./crawl/enhanced-search.js";
import { proxyManager } from "./crawl/proxy-manager.js";
import { logger } from "./utils/logger.js";
import { searchCache, crawlCache } from "./utils/cache.js";
import { apiLimiter, createRateLimitMiddleware } from "./utils/rate-limiter.js";
import { getConfig } from "./utils/config.js";
import { KnowledgeGraph } from "./kg/graph.js";
import { wsManager } from "./utils/websocket.js";
import { VaultFileWatcher } from "./memory/file-watcher.js";
import { AgentBootstrap } from "./memory/bootstrap.js";
import { MemoryDistiller } from "./memory/distiller.js";
import { HealthMonitor } from "./utils/resilience.js";
import { validateEnv } from "./utils/env-validation.js";
import { registerShutdownHook, setupGracefulShutdown } from "./utils/graceful-shutdown.js";
import { createSecurityHeaders, createCorsHeaders, sanitizeRequestBody } from "./utils/security.js";
import { metrics } from "./utils/metrics.js";

// ===== 环境验证 =====
const envValidation = validateEnv({ strict: false, exitOnError: false });
if (!envValidation.valid) {
  logger.warn("Environment validation warnings present", {
    missing: envValidation.missing,
    invalid: envValidation.invalid.map(i => i.name),
  });
}

// ===== 初始化 =====

await Bun.write("./data/.gitkeep", "").catch(() => {});
await Bun.write("./data/logs/.gitkeep", "").catch(() => {});

const config = getConfig();
const dbPath = config.memory.databasePath;
const db = new Database(dbPath);
const startupTime = Date.now();

logger.info("OpenClaw AI Agent 启动中", {
  version: "2.1.0",
  node: process.version,
  bun: Bun.version,
  env: process.env.NODE_ENV || "development",
});

// 系统状态
db.run(`CREATE TABLE IF NOT EXISTS system_state (key TEXT PRIMARY KEY, value TEXT, updated_at INTEGER DEFAULT (unixepoch()))`);
db.run(`INSERT OR REPLACE INTO system_state (key, value) VALUES (?, ?)`, ["last_boot", new Date().toISOString()]);

// Vault — 核心记忆引擎
let vault: VaultManager | null = null;
try {
  vault = new VaultManager({ vaultPath: config.memory.vaultPath });
  logger.info("VaultManager initialized", { notes: vault.stats().totalNotes });
} catch (e: any) {
  logger.warn("VaultManager init failed", { error: e.message });
}

// Pipeline
const pipeline = new DataPipeline({
  maxConcurrent: config.crawler.maxConcurrent,
  requestDelay: config.crawler.requestDelay,
});
logger.info("DataPipeline initialized");

// Knowledge Graph
const kg = new KnowledgeGraph(dbPath);

// Agent Auto-Discovery — 启动时自动检查/更新索引
{
  const { discoverAgentsIfNeeded, listAgentSources } = await import("./agents/agent-discovery.js");
  const sources = listAgentSources();
  if (sources.length > 0) {
    for (const sourceDir of sources) {
      const result = discoverAgentsIfNeeded({ sourceDir, force: false });
      if (result) {
        logger.info("Agent index updated", {
          source: sourceDir,
          total: result.count,
          new: result.newCount,
          updated: result.updatedCount,
        });
      }
    }
  }
}

// File Watcher — Vault 变更自动刷新索引
let fileWatcher: VaultFileWatcher | null = null;
if (vault) {
  fileWatcher = new VaultFileWatcher({ vaultPath: config.memory.vaultPath });
  fileWatcher.start((event, path) => {
    wsManager.broadcast({
      type: "vault_change",
      payload: { event, file: path },
      timestamp: new Date().toISOString(),
    });
  });
  logger.info("VaultFileWatcher started", { watchedDirs: fileWatcher.watchedCount });
}

// Cron
try { await import("./cron/scheduler.js"); logger.info("Cron scheduler started"); }
catch (e: any) { logger.warn("Cron scheduler not started", { error: e.message }); }

// HealthMonitor — 周期性健康检查
const healthMonitor = new HealthMonitor();
healthMonitor.register({
  name: "database",
  check: async () => {
    try { db.query("SELECT 1").get(); return true; }
    catch { return false; }
  },
  interval: 60000,
});
if (vault) {
  healthMonitor.register({
    name: "vault",
    check: async () => {
      try { vault!.stats(); return true; }
      catch { return false; }
    },
    interval: 60000,
  });
}
healthMonitor.register({
  name: "siliconflow",
  check: async () => checkPlatform("siliconflow", process.env.SILICONFLOW_API_KEY),
  interval: 120000,
});
healthMonitor.register({
  name: "ofoxai",
  check: async () => checkPlatform("ofoxai", process.env.OFOXAI_API_KEY),
  interval: 120000,
});
healthMonitor.register({
  name: "openrouter",
  check: async () => checkPlatform("openrouter", process.env.OPENROUTER_API_KEY),
  interval: 120000,
});
healthMonitor.register({
  name: "deepseek",
  check: async () => checkPlatform("deepseek", process.env.DEEPSEEK_API_KEY),
  interval: 120000,
});
healthMonitor.register({
  name: "kimiCode",
  check: async () => checkPlatform("kimi-code", process.env.KIMI_CODE_API_KEY),
  interval: 120000,
});
healthMonitor.start();
logger.info("HealthMonitor started", { checks: Array.from((healthMonitor as any).checks?.keys?.() || []) });

// WebSocket 心跳 — 每 30 秒广播一次系统状态
const heartbeatInterval = setInterval(() => {
  wsManager.broadcast({
    type: "heartbeat",
    payload: {
      uptime: Date.now() - startupTime,
      clients: wsManager.getStats().connectedClients,
      vaultNotes: vault?.stats().totalNotes ?? 0,
    },
    timestamp: new Date().toISOString(),
  });
}, 30000);

// ===== 辅助函数 =====

async function checkPlatform(name: string, apiKey?: string): Promise<boolean> {
  if (!apiKey) return false;
  const endpoints: Record<string, string> = {
    siliconflow: "https://api.siliconflow.cn/v1/models",
    ofoxai: "https://api.ofox.ai/v1/models",
    openrouter: "https://openrouter.ai/api/v1/models",
    deepseek: "https://api.deepseek.com/v1/models",
    "kimi-code": "https://api.kimi.com/coding/v1/models",
  };
  try { const res = await fetch(endpoints[name], { headers: { Authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(3000) }); return res.ok; }
  catch { return false; }
}

const securityHeaders = createSecurityHeaders({ hsts: process.env.NODE_ENV === "production", csp: false });

function corsHeaders(origin?: string): Record<string, string> {
  return createCorsHeaders(origin, {
    allowedOrigins: process.env.CORS_ORIGINS?.split(",") || ["*"],
    allowedMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "X-Request-ID"],
    allowCredentials: !!process.env.CORS_CREDENTIALS,
  });
}

function jsonResponse(data: unknown, status = 200, extraHeaders?: Record<string, string>): Response {
  return Response.json(data, { status, headers: { ...securityHeaders, ...corsHeaders(), ...extraHeaders } });
}

// 请求体大小限制
const MAX_BODY_SIZE = parseInt(process.env.MAX_BODY_SIZE || "1048576", 10); // 1MB default

async function logRequest(req: Request, status: number, durationMs: number, extra?: Record<string, unknown>) {
  const url = new URL(req.url);
  logger.debug("HTTP request", { method: req.method, path: url.pathname, status, durationMs, ...extra });
}

const rateLimitCheck = createRateLimitMiddleware(apiLimiter);

// ===== HTTP 服务 =====

const port = config.gateway.port;

const server = Bun.serve({
  port,
  async fetch(req, server) {
    const startTime = performance.now();
    const url = new URL(req.url);
    const requestOrigin = req.headers.get("origin") || "";

    // 添加安全头到所有响应
    const baseHeaders = { ...securityHeaders, ...corsHeaders(requestOrigin) };

    if (req.method === "OPTIONS") return new Response(null, { headers: baseHeaders });

    // WebSocket
    if (url.pathname === "/ws") {
      const success = server.upgrade(req, { data: { clientId: crypto.randomUUID() } } as any);
      if (success) return undefined as any;
      return jsonResponse({ error: "WebSocket upgrade failed" }, 400, baseHeaders);
    }

    const rl = await rateLimitCheck(req);
    if (!rl.allowed) {
      await logRequest(req, 429, Math.round(performance.now() - startTime), { rateLimited: true });
      return jsonResponse({ error: "Rate limit exceeded" }, 429, rl.headers);
    }

    // 请求体大小检查
    if (req.method === "POST" || req.method === "PUT" || req.method === "PATCH") {
      const contentLength = parseInt(req.headers.get("content-length") || "0", 10);
      if (contentLength > MAX_BODY_SIZE) {
        await logRequest(req, 413, Math.round(performance.now() - startTime));
        return jsonResponse({ error: `Request body too large (max ${MAX_BODY_SIZE} bytes)` }, 413, baseHeaders);
      }
    }

    try {
      let response: Response;

      // === Metrics ===
      if (url.pathname === "/metrics" && req.method === "GET") {
        response = new Response(metrics.getPrometheusFormat(), {
          status: 200,
          headers: { "Content-Type": "text/plain; version=0.0.4", ...baseHeaders },
        });
      }

      // === Dashboard ===
      if (url.pathname === "/" || url.pathname === "/index.html") {
        const file = Bun.file("./public/index.html");
        response = await file.exists()
          ? new Response(file, { headers: { "Content-Type": "text/html", ...corsHeaders() } })
          : jsonResponse({ error: "Dashboard not found" }, 404);
      }

      // === Health ===
      else if (url.pathname === "/health") {
        const checks = await healthMonitor.checkAll();
        const vStats = vault?.stats();
        response = jsonResponse({
          status: "ok", timestamp: new Date().toISOString(), version: "2.1.0",
          uptime: Math.floor((Date.now() - startupTime) / 1000),
          checks, searchEngines: searchAggregator.listEngines(),
          proxies: { healthy: proxyManager.getHealthyCount() },
          vault: vStats ? { notes: vStats.totalNotes, words: vStats.totalWords } : null,
          cache: { search: searchCache.stats(), crawl: crawlCache.stats() },
          websocket: wsManager.getStats(),
        }, 200, rl.headers);
      }

      // === Chat (默认启用意图识别 + 分层路由 + CodeGraph 记忆) ===
      else if (url.pathname === "/chat" && req.method === "POST") {
        const body = await req.json();
        const { taskType, messages = [], intent: enableIntent = true } = body;
        const { router } = await import("./router/model-router.js");

        let chatMessages = messages;
        let intentInfo = null;
        let codegraphContext = "";

        if (enableIntent !== false && messages.length > 0) {
          const lastUserMsg = [...messages].reverse().find((m: any) => m.role === "user");
          if (lastUserMsg?.content) {
            const { buildAgentMessages } = await import("./agents/intent-router.js");
            const history = messages.slice(0, -1).filter((m: any) => m.role !== "system");
            const { intent, messages: agentMessages } = buildAgentMessages(lastUserMsg.content, history);
            chatMessages = agentMessages;
            intentInfo = intent;

            // 代码相关意图：自动检索 CodeGraph 记忆
            if (intent && ["engineering", "game-development", "integrations", "testing"].includes(intent.intent)) {
              try {
                const { retrieveCodeMemory } = await import("./memory/codegraph-index.js");
                const cgResult = await retrieveCodeMemory(lastUserMsg.content);
                if (cgResult && cgResult.results) {
                  codegraphContext = cgResult.results.slice(0, 3000);
                  chatMessages = [
                    { role: "system", content: `[CodeGraph Context]\n${codegraphContext}` },
                    ...chatMessages.filter((m: any) => m.role !== "system"),
                  ];
                }
              } catch { /* ignore codegraph errors */ }
            }
          }
        }

        // 分层路由：优先按意图自动路由，其次按 taskType
        let result;
        if (intentInfo) {
          result = await router.routeByIntent(intentInfo.intent, chatMessages);
        } else if (taskType) {
          result = await router.chat(taskType, chatMessages);
        } else {
          result = await router.chat("general-chat", chatMessages);
        }

        response = jsonResponse({
          ...result,
          codegraphContext: codegraphContext ? { length: codegraphContext.length } : null,
          intent: intentInfo ? {
            name: intentInfo.agentName,
            category: intentInfo.intent,
            confidence: intentInfo.confidence,
            emoji: intentInfo.agent.emoji,
          } : null,
        }, 200, rl.headers);
        wsManager.broadcast({
          type: "model.usage",
          payload: { layer: result.layer, taskType: taskType || "auto", provider: result.provider },
          timestamp: new Date().toISOString(),
        });
        if (intentInfo) {
          wsManager.broadcast({
            type: "agent.intent",
            payload: { intent: intentInfo.agentName, confidence: intentInfo.confidence, layer: result.layer },
            timestamp: new Date().toISOString(),
          });
        }
      }

      // === Agent Chat (意图识别 + 分层路由) ===
      else if (url.pathname === "/agent-chat" && req.method === "POST") {
        const body = await req.json();
        const { message, history = [], taskType } = body;
        const { buildAgentMessages } = await import("./agents/intent-router.js");
        const { intent, messages: agentMessages } = buildAgentMessages(message, history);
        const { router } = await import("./router/model-router.js");

        let result;
        if (intent) {
          result = await router.routeByIntent(intent.intent, agentMessages);
        } else if (taskType) {
          result = await router.chat(taskType, agentMessages);
        } else {
          result = await router.chat("general-chat", agentMessages);
        }

        response = jsonResponse({
          ...result,
          intent: intent ? {
            name: intent.agentName,
            category: intent.intent,
            confidence: intent.confidence,
            emoji: intent.agent.emoji,
          } : null,
        }, 200, rl.headers);
        wsManager.broadcast({
          type: "agent.intent",
          payload: { intent: intent?.agentName || "general", confidence: intent?.confidence || 0, layer: result.layer },
          timestamp: new Date().toISOString(),
        });
      }

      // === Vault Search (确定性) ===
      else if (url.pathname === "/search" && req.method === "GET") {
        const query = url.searchParams.get("q");
        if (!query) { response = jsonResponse({ error: "Missing q param" }, 400, rl.headers); }
        else if (!vault) { response = jsonResponse({ error: "Vault not initialized" }, 503, rl.headers); }
        else {
          const types = url.searchParams.get("types")?.split(",").filter(Boolean);
          const tags = url.searchParams.get("tags")?.split(",").filter(Boolean);
          const para = url.searchParams.get("para") || undefined;
          const limit = Number(url.searchParams.get("limit")) || 20;
          const results = vault.search(query, { types, tags, paraCategory: para, limit });
          response = jsonResponse({ query, strategy: "deterministic", results }, 200, rl.headers);
        }
      }

      // === Web Search ===
      else if (url.pathname === "/web-search" && req.method === "GET") {
        const query = url.searchParams.get("q");
        if (!query) { response = jsonResponse({ error: "Missing q param" }, 400, rl.headers); }
        else {
          const engines = url.searchParams.get("engines")?.split(",") || undefined;
          const num = Number(url.searchParams.get("num")) || 10;
          const cacheKey = `${query}::${engines?.join(",") || "default"}::${num}`;
          const results = await searchCache.getOrSet(cacheKey, async () => {
            return pipeline.searchMulti(query, { engines, num });
          }, 10 * 60 * 1000);

          db.run(`INSERT INTO search_history (query, query_hash, engines, results_count, created_at) VALUES (?, ?, ?, ?, ?)`,
            [query, String(Bun.hash(query)), engines?.join(",") || "", (results as any[]).length, Date.now()]);

          // 自动写入 Vault
          if (vault) {
            vault.writeSearchResult(query, engines || ["duckduckgo"], results as any[]).catch(() => {});
          }

          wsManager.broadcast({ type: "search.completed", payload: { query, resultCount: (results as any[]).length }, timestamp: new Date().toISOString() });
          response = jsonResponse({ query, engines, results }, 200, rl.headers);
        }
      }

      // === Enhanced Search ===
      else if (url.pathname === "/enhanced-search" && req.method === "GET") {
        const query = url.searchParams.get("q");
        if (!query) { response = jsonResponse({ error: "Missing q param" }, 400, rl.headers); }
        else {
          const mode = (url.searchParams.get("mode") as any) || "quick";
          const num = Number(url.searchParams.get("num")) || 10;
          const engines = url.searchParams.get("engines")?.split(",") || undefined;
          const enhanceContent = url.searchParams.get("enhance") !== "false";
          const rerank = url.searchParams.get("rerank") !== "false";
          const dedup = url.searchParams.get("dedup") !== "false";
          const cacheTtl = Number(url.searchParams.get("cache")) || undefined;

          let results: any[];
          switch (mode) {
            case "deep":
              results = await enhancedSearch.deepSearch(query, num);
              break;
            case "academic":
              results = await enhancedSearch.academicSearch(query, num);
              break;
            case "news":
              results = await enhancedSearch.newsSearch(query, num);
              break;
            case "code":
              results = await enhancedSearch.codeSearch(query, num);
              break;
            default:
              results = await enhancedSearch.search({
                query,
                num,
                engines,
                enhanceContent,
                rerank,
                dedup,
                cacheTtl,
                recordHistory: true,
              });
          }

          wsManager.broadcast({
            type: "search.completed",
            payload: { query, mode, resultCount: results.length },
            timestamp: new Date().toISOString(),
          });

          response = jsonResponse({ query, mode, results }, 200, rl.headers);
        }
      }

      // === Search Suggestions ===
      else if (url.pathname === "/search/suggestions" && req.method === "GET") {
        const query = url.searchParams.get("q");
        if (!query) { response = jsonResponse({ error: "Missing q param" }, 400, rl.headers); }
        else {
          const suggestions = enhancedSearch.getSuggestions(query);
          response = jsonResponse({ query, suggestions }, 200, rl.headers);
        }
      }

      // === Search Stats ===
      else if (url.pathname === "/search/stats" && req.method === "GET") {
        const stats = enhancedSearch.getStats();
        response = jsonResponse(stats, 200, rl.headers);
      }

      // === Search History ===
      else if (url.pathname === "/search/history" && req.method === "GET") {
        const limit = Number(url.searchParams.get("limit")) || 50;
        const offset = Number(url.searchParams.get("offset")) || 0;
        const history = enhancedSearch.getHistory(limit, offset);
        response = jsonResponse({ history, limit, offset }, 200, rl.headers);
      }

      // === Web Fetch ===
      else if (url.pathname === "/web-fetch" && req.method === "GET") {
        const targetUrl = url.searchParams.get("url");
        if (!targetUrl) { response = jsonResponse({ error: "Missing url param" }, 400, rl.headers); }
        else {
          const cacheKey = `crawl::${targetUrl}`;
          let result: any = crawlCache.get(cacheKey);
          if (!result) {
            result = await pipeline.crawlStructured(targetUrl);
            if (result) {
              crawlCache.set(cacheKey, result, 30 * 60 * 1000);
              await pipeline.saveCrawlResult(result);
            }
          }
          if (!result) { response = jsonResponse({ error: "Fetch failed" }, 502, rl.headers); }
          else {
            wsManager.broadcast({ type: "crawl.completed", payload: { url: targetUrl, title: result.title }, timestamp: new Date().toISOString() });
            response = jsonResponse(result, 200, rl.headers);
          }
        }
      }

      // === Vault APIs ===
      else if (url.pathname === "/vault/stats" && req.method === "GET") {
        if (!vault) { response = jsonResponse({ error: "Vault not initialized" }, 503, rl.headers); }
        else { response = jsonResponse(vault.stats(), 200, rl.headers); }
      }
      else if (url.pathname.startsWith("/vault/para/") && req.method === "GET") {
        if (!vault) { response = jsonResponse({ error: "Vault not initialized" }, 503, rl.headers); }
        else {
          const category = url.pathname.slice("/vault/para/".length);
          const notes = vault.browsePara(category);
          response = jsonResponse({ category, notes }, 200, rl.headers);
        }
      }
      else if (url.pathname.startsWith("/vault/tags/") && req.method === "GET") {
        if (!vault) { response = jsonResponse({ error: "Vault not initialized" }, 503, rl.headers); }
        else {
          const tag = decodeURIComponent(url.pathname.slice("/vault/tags/".length));
          const notes = vault.browseTag(tag);
          response = jsonResponse({ tag, notes }, 200, rl.headers);
        }
      }
      else if (url.pathname.startsWith("/vault/network/") && req.method === "GET") {
        if (!vault) { response = jsonResponse({ error: "Vault not initialized" }, 503, rl.headers); }
        else {
          const notePath = decodeURIComponent(url.pathname.slice("/vault/network/".length));
          const depth = Number(url.searchParams.get("depth")) || 1;
          const network = vault.getNetwork(notePath, depth);
          response = jsonResponse({ notePath, depth, ...network }, 200, rl.headers);
        }
      }
      else if (url.pathname === "/vault/note" && req.method === "GET") {
        if (!vault) { response = jsonResponse({ error: "Vault not initialized" }, 503, rl.headers); }
        else {
          const notePath = url.searchParams.get("path");
          if (!notePath) { response = jsonResponse({ error: "Missing path param" }, 400, rl.headers); }
          else {
            const note = vault.readNote(notePath);
            if (!note) { response = jsonResponse({ error: "Note not found" }, 404, rl.headers); }
            else { response = jsonResponse({ path: notePath, ...note }, 200, rl.headers); }
          }
        }
      }
      else if (url.pathname === "/vault/write" && req.method === "POST") {
        if (!vault) { response = jsonResponse({ error: "Vault not initialized" }, 503, rl.headers); }
        else {
          const body = await req.json();
          const { path: notePath, content, ...opts } = body;
          if (!notePath || !content) { response = jsonResponse({ error: "Missing path or content" }, 400, rl.headers); }
          else {
            const written = await vault.writeNote(notePath, content, opts);
            response = jsonResponse({ path: written }, 201, rl.headers);
          }
        }
      }
      else if (url.pathname === "/vault/atomic" && req.method === "POST") {
        if (!vault) { response = jsonResponse({ error: "Vault not initialized" }, 503, rl.headers); }
        else {
          const body = await req.json();
          const { title, idea, ...opts } = body;
          if (!title || !idea) { response = jsonResponse({ error: "Missing title or idea" }, 400, rl.headers); }
          else {
            const path = await vault.writeAtomicNote(title, idea, opts);
            response = jsonResponse({ path, title }, 201, rl.headers);
          }
        }
      }
      else if (url.pathname === "/vault/code-index" && req.method === "POST") {
        if (!vault) { response = jsonResponse({ error: "Vault not initialized" }, 503, rl.headers); }
        else {
          const result = await vault.indexCode();
          response = jsonResponse(result, 200, rl.headers);
        }
      }

      // === CodeGraph 记忆检索 ===
      else if (url.pathname === "/codegraph/search" && req.method === "GET") {
        const query = url.searchParams.get("q");
        if (!query) { response = jsonResponse({ error: "Missing q param" }, 400, rl.headers); }
        else {
          const { retrieveCodeMemory } = await import("./memory/codegraph-index.js");
          const result = await retrieveCodeMemory(query);
          response = jsonResponse(
            result ?? { error: "CodeGraph not initialized or no results" },
            result ? 200 : 404,
            rl.headers
          );
        }
      }
      else if (url.pathname === "/codegraph/init" && req.method === "POST") {
        const { initializeCodegraph, getStatus } = await import("./memory/codegraph-index.js");
        await initializeCodegraph();
        const status = await getStatus();
        response = jsonResponse(status ?? { ok: true }, 200, rl.headers);
      }
      else if (url.pathname === "/codegraph/status" && req.method === "GET") {
        const { getStatus } = await import("./memory/codegraph-index.js");
        const status = await getStatus();
        response = jsonResponse(status ?? { initialized: false }, 200, rl.headers);
      }
      else if (url.pathname === "/vault/reload" && req.method === "POST") {
        if (!vault) { response = jsonResponse({ error: "Vault not initialized" }, 503, rl.headers); }
        else { vault.reload(); response = jsonResponse({ ok: true }, 200, rl.headers); }
      }
      else if (url.pathname === "/vault/watch-status" && req.method === "GET") {
        response = jsonResponse({
          watching: fileWatcher?.isWatching ?? false,
          watchedDirectories: fileWatcher?.watchedCount ?? 0,
        }, 200, rl.headers);
      }
      else if (url.pathname === "/vault/distill" && req.method === "POST") {
        if (!vault) { response = jsonResponse({ error: "Vault not initialized" }, 503, rl.headers); }
        else {
          const body = await req.json();
          const distiller = new MemoryDistiller(config.memory.vaultPath);
          const created = await distiller.distillManual(body.title, body.content, {
            source: body.source || "manual",
            sourceType: body.sourceType || "manual",
            tags: body.tags,
            relatedNotes: body.relatedNotes,
          });
          response = jsonResponse({ created }, 201, rl.headers);
        }
      }
      else if (url.pathname === "/bootstrap" && req.method === "GET") {
        const bootstrap = new AgentBootstrap(config.memory.vaultPath);
        const topic = url.searchParams.get("topic") || "";
        const depth = Number(url.searchParams.get("depth")) || 5;
        const context = await bootstrap.run({ topic, memoryDepth: depth });
        const format = url.searchParams.get("format") || "json";
        if (format === "prompt") {
          response = new Response(bootstrap.toSystemPrompt(context), {
            headers: { "Content-Type": "text/plain; charset=utf-8", ...corsHeaders() },
          });
        } else {
          response = jsonResponse(context, 200, rl.headers);
        }
      }

      // === Engines, Proxies, Stats ===
      else if (url.pathname === "/engines" && req.method === "GET") {
        response = jsonResponse({ engines: searchAggregator.listEngines() }, 200, rl.headers);
      }
      else if (url.pathname === "/proxies" && req.method === "GET") {
        response = jsonResponse({ healthy: proxyManager.getHealthyCount() }, 200, rl.headers);
      }
      else if (url.pathname === "/stats" && req.method === "GET") {
        const s = (table: string) => (db.query(`SELECT COUNT(*) as c FROM ${table}`).get() as any)?.c || 0;
        response = jsonResponse({
          searchCount: s("search_history"), crawlCount: s("crawl_results"),
          memoryCount: s("conversations"), entityCount: s("entities"),
          relationCount: s("relationships"), taskCount: s("tasks"),
          uptime: Math.floor((Date.now() - startupTime) / 1000),
          vault: vault?.stats(),
          cache: { search: searchCache.stats(), crawl: crawlCache.stats() },
        }, 200, rl.headers);
      }

      // === KG APIs ===
      else if (url.pathname === "/kg/stats" && req.method === "GET") {
        response = jsonResponse(kg.stats(), 200, rl.headers);
      }
      else if (url.pathname === "/kg/centrality" && req.method === "GET") {
        response = jsonResponse({ top: kg.centrality(Number(url.searchParams.get("limit")) || 20) }, 200, rl.headers);
      }
      else if (url.pathname === "/kg/search" && req.method === "GET") {
        const q = url.searchParams.get("q");
        if (!q) { response = jsonResponse({ error: "Missing q param" }, 400, rl.headers); }
        else { response = jsonResponse({ query: q, entities: kg.searchEntities(q, 20) }, 200, rl.headers); }
      }
      else if (url.pathname === "/kg/entities" && req.method === "GET") {
        response = jsonResponse({ entities: kg.findEntities((url.searchParams.get("type") as any) || undefined, Number(url.searchParams.get("limit")) || 100) }, 200, rl.headers);
      }
      else if (url.pathname === "/kg/entities" && req.method === "POST") {
        const body = await req.json();
        response = jsonResponse({ entity: kg.createEntity(body.name, body.type, body.properties) }, 201, rl.headers);
      }
      else if (url.pathname.startsWith("/kg/entities/") && req.method === "GET") {
        const id = Number(url.pathname.split("/").pop());
        const entity = kg.getEntity(id);
        if (!entity) { response = jsonResponse({ error: "Entity not found" }, 404, rl.headers); }
        else { response = jsonResponse({ entity, relationships: kg.getRelationships(id, "both") }, 200, rl.headers); }
      }
      else if (url.pathname === "/kg/relationships" && req.method === "POST") {
        const body = await req.json();
        response = jsonResponse({ relationship: kg.createRelationship(body.sourceId, body.targetId, body.type, body.properties) }, 201, rl.headers);
      }
      else if (url.pathname.startsWith("/kg/bfs/") && req.method === "GET") {
        const id = Number(url.pathname.split("/").pop());
        response = jsonResponse({ startId: id, depth: Number(url.searchParams.get("depth")) || 3, ...kg.bfs(id, Number(url.searchParams.get("depth")) || 3) }, 200, rl.headers);
      }
      else if (url.pathname === "/kg/path" && req.method === "GET") {
        const fromId = Number(url.searchParams.get("from"));
        const toId = Number(url.searchParams.get("to"));
        if (!fromId || !toId) { response = jsonResponse({ error: "Missing from/to params" }, 400, rl.headers); }
        else { response = jsonResponse({ fromId, toId, path: kg.shortestPath(fromId, toId, Number(url.searchParams.get("maxDepth")) || 5) }, 200, rl.headers); }
      }

      // === Recent searches, Cache ===
      else if (url.pathname === "/searches/recent" && req.method === "GET") {
        const rows = db.query("SELECT * FROM search_history ORDER BY created_at DESC LIMIT ?").all(Number(url.searchParams.get("limit")) || 20) as any[];
        response = jsonResponse({ searches: rows }, 200, rl.headers);
      }
      else if (url.pathname === "/cache/stats" && req.method === "GET") {
        response = jsonResponse({ search: searchCache.stats(), crawl: crawlCache.stats() }, 200, rl.headers);
      }

      // === Agent 状态与工具 ===
      else if (url.pathname === "/agents/status" && req.method === "GET") {
        const { checkOpenCode, OPENCODE_FREE_MODELS } = await import("./agents/opencode-agent.js");
        const { checkHermes } = await import("./agents/hermes-agent.js");
        const { checkKimiCodeApiKey, checkKimiCli, KIMI_CODE_MODEL } = await import("./agents/kimi-code-agent.js");
        const opencodeOk = await checkOpenCode();
        const hermesOk = await checkHermes();
        const kimiApiOk = checkKimiCodeApiKey();
        const kimiCliOk = await checkKimiCli();
        response = jsonResponse({
          opencode: { installed: opencodeOk, freeModels: OPENCODE_FREE_MODELS, cli: "bun run src/cli.ts code:open" },
          hermes: { installed: hermesOk, installGuide: "curl -fsSL https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh | bash" },
          kimiCode: { apiKeyConfigured: kimiApiOk, cliInstalled: kimiCliOk, model: KIMI_CODE_MODEL, cli: "bun run src/cli.ts kimi:open" },
        }, 200, rl.headers);
      }
      else if (url.pathname === "/agents/opencode/models" && req.method === "GET") {
        const { checkOpenCode, listOpenCodeModels, OPENCODE_FREE_MODELS } = await import("./agents/opencode-agent.js");
        const installed = await checkOpenCode();
        const models = installed ? await listOpenCodeModels() : [];
        response = jsonResponse({ installed, freeModels: OPENCODE_FREE_MODELS, models: models.slice(0, 50), total: models.length }, 200, rl.headers);
      }
      else if (url.pathname === "/agents/opencode/open" && req.method === "POST") {
        const body = await req.json();
        const model = body.model || "opencode/deepseek-v4-flash-free";
        const prompt = body.prompt || "";
        response = jsonResponse({
          command: `bun run src/cli.ts code:open ${prompt ? "\"" + prompt + "\" " : ""}--model=${model}`,
          note: "OpenCode 是交互式 TUI 工具，请在终端中运行上述命令。",
          model,
          prompt,
        }, 200, rl.headers);
      }

      // === Kimi Code Agent APIs ===
      else if (url.pathname === "/agents/kimi/status" && req.method === "GET") {
        const { checkKimiCodeApiKey, checkKimiCli, KIMI_CODE_MODEL } = await import("./agents/kimi-code-agent.js");
        const apiKeyOk = checkKimiCodeApiKey();
        const cliOk = await checkKimiCli();
        response = jsonResponse({
          apiKeyConfigured: apiKeyOk,
          cliInstalled: cliOk,
          model: KIMI_CODE_MODEL,
          baseUrl: process.env.KIMI_CODE_BASE_URL || "https://api.kimi.com/coding/v1",
          ready: apiKeyOk || cliOk,
        }, 200, rl.headers);
      }
      else if (url.pathname === "/agents/kimi/chat" && req.method === "POST") {
        const { kimiCodeChat, checkKimiCodeApiKey, getKimiCodeGuide, KIMI_CODE_MODEL } = await import("./agents/kimi-code-agent.js");
        const body = await req.json();
        if (!checkKimiCodeApiKey()) {
          response = jsonResponse({ error: "KIMI_CODE_API_KEY not configured", guide: getKimiCodeGuide() }, 503, rl.headers);
        } else {
          try {
            const result = await kimiCodeChat({
              messages: body.messages || [
                { role: "system", content: body.system || "You are Kimi Code, an expert programming assistant." },
                { role: "user", content: body.prompt || body.message || "" },
              ],
              temperature: body.temperature ?? 0.7,
              timeout: body.timeout ?? 60000,
            });
            response = jsonResponse({ ...result, model: KIMI_CODE_MODEL }, 200, rl.headers);
          } catch (e: any) {
            response = jsonResponse({ error: e.message }, 500, rl.headers);
          }
        }
      }
      else if (url.pathname === "/agents/kimi/open" && req.method === "POST") {
        const body = await req.json();
        const prompt = body.prompt || "";
        response = jsonResponse({
          command: `bun run src/cli.ts kimi:open ${prompt ? "\"" + prompt + "\" " : ""}`,
          note: "Kimi Code CLI 是交互式 TUI 工具，请在终端中运行上述命令。",
          prompt,
        }, 200, rl.headers);
      }
      else if (url.pathname === "/agents/hermes/task" && req.method === "POST") {
        const body = await req.json();
        const { checkHermes, runHermesTask } = await import("./agents/hermes-agent.js");
        const installed = await checkHermes();
        if (!installed) {
          response = jsonResponse({ error: "Hermes 未安装", installGuide: "curl -fsSL https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh | bash" }, 503, rl.headers);
        } else {
          const result = await runHermesTask({ prompt: body.prompt || "", cwd: body.cwd, timeoutMs: body.timeoutMs || 300_000 });
          response = jsonResponse({ success: result.success, stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode }, 200, rl.headers);
        }
      }

      // === Default ===
      else {
        response = jsonResponse({
          name: "OpenClaw AI Agent", version: "2.1.0",
          uptime: Math.floor((Date.now() - startupTime) / 1000),
          endpoints: [
            "GET  /                        — Dashboard",
            "GET  /health                  — 健康检查",
            "POST /chat                    — 模型聊天（自动意图识别，编码意图优先 Kimi Code）",
            "GET  /search?q=               — Vault 确定性记忆搜索",
            "GET  /web-search?q=           — 多引擎搜索",
            "GET  /web-fetch?url=          — 结构化抓取",
            "--- Vault 核心记忆 ---",
            "GET  /vault/stats             — Vault 统计",
            "GET  /vault/para/:category    — PARA 分类浏览",
            "GET  /vault/tags/:tag         — 标签浏览",
            "GET  /vault/network/:path     — 笔记关联网络",
            "GET  /vault/note?path=        — 读取笔记",
            "POST /vault/write             — 写入笔记",
            "POST /vault/atomic            — 原子笔记",
            "POST /vault/code-index        — 索引代码",
            "POST /vault/reload            — 重建索引",
            "--- 知识图谱 ---",
            "GET  /kg/stats                — KG 统计",
            "GET  /kg/centrality           — 中心性分析",
            "GET  /kg/search?q=            — 实体搜索",
            "GET  /kg/entities             — 实体列表",
            "POST /kg/entities             — 创建实体",
            "GET  /kg/entities/:id         — 实体详情",
            "POST /kg/relationships        — 创建关系",
            "GET  /kg/bfs/:id              — BFS 遍历",
            "GET  /kg/path?from=&to=       — 最短路径",
            "WS   /ws                      — 实时推送",
          ],
        }, 200, rl.headers);
      }

      // 请求指标收集
      const duration = (performance.now() - startTime) / 1000;
      metrics.increment("http_requests_total", 1, { method: req.method, path: url.pathname, status: String(response.status) });
      metrics.histogram("http_request_duration_seconds", duration, { method: req.method, path: url.pathname });

      await logRequest(req, response.status, Math.round(performance.now() - startTime));
      return response;
    } catch (e: any) {
      const duration = Math.round(performance.now() - startTime);
      logger.error(`Request failed: ${url.pathname}`, e, { method: req.method, duration });
      await logRequest(req, 500, duration, { error: e.message });
      metrics.increment("http_requests_total", 1, { method: req.method, path: url.pathname, status: "500" });
      return jsonResponse({ error: e.message, path: url.pathname }, 500, { ...rl.headers, ...securityHeaders });
    }
  },

  websocket: {
    open(ws) { wsManager.onOpen(ws as any); },
    message(ws, message) { wsManager.onMessage(ws as any, message as string); },
    close(ws) { wsManager.onClose(ws as any); },
  },
});

// 注册优雅关闭钩子
registerShutdownHook({
  name: "health-monitor",
  handler: () => healthMonitor.stop(),
  priority: 100,
});
registerShutdownHook({
  name: "file-watcher",
  handler: () => fileWatcher?.stop(),
  priority: 80,
});
registerShutdownHook({
  name: "vault",
  handler: () => vault?.close(),
  priority: 70,
});
registerShutdownHook({
  name: "knowledge-graph",
  handler: () => kg.close(),
  priority: 60,
});
registerShutdownHook({
  name: "database",
  handler: () => db.close(),
  priority: 50,
});
registerShutdownHook({
  name: "http-server",
  handler: () => server.stop(),
  priority: 40,
});
registerShutdownHook({
  name: "heartbeat",
  handler: () => clearInterval(heartbeatInterval),
  priority: 30,
});

// 设置优雅关闭
setupGracefulShutdown({ timeout: 30000, signals: ["SIGTERM", "SIGINT"] });

logger.info("Server started", { port, url: `http://localhost:${port}` });

console.log(`
╔══════════════════════════════════════════════════════════════╗
║     OpenClaw AI Agent v2.1 — Vault 核心记忆引擎运行中       ║
║  记忆: Obsidian Vault (确定性推理)                           ║
║  Dashboard: http://localhost:${port}/                          ║
║  WebSocket: ws://localhost:${port}/ws                          ║
║  Metrics:  http://localhost:${port}/metrics                    ║
╚══════════════════════════════════════════════════════════════╝
`);
