---
id: code-main
type: code-index
source: main.ts
lang: typescript
created: 2026-05-25
updated: 2026-05-25
word_count: 2233
tags: [code, auto-indexed]
imports: ["bun:sqlite", "memory-vault-manager.js", "crawl-data-pipeline.js", "crawl-search-engines.js", "crawl-proxy-manager.js", "utils-logger.js", "utils-cache.js", "utils-rate-limiter.js", "utils-config.js", "kg-graph.js", "utils-websocket.js"]
---

# main

## 元信息

- **源文件**: `main.ts`
- **模块**: `main`
- **行数**: 436
- **索引时间**: 2026-05-25T05:11:12.533Z

## 依赖

- [[bun:sqlite]]
- [[memory-vault-manager.js]]
- [[crawl-data-pipeline.js]]
- [[crawl-search-engines.js]]
- [[crawl-proxy-manager.js]]
- [[utils-logger.js]]
- [[utils-cache.js]]
- [[utils-rate-limiter.js]]
- [[utils-config.js]]
- [[kg-graph.js]]
- [[utils-websocket.js]]

## 代码

```typescript
/**
 * Axiom AI Agent — 主入口 v2.1
 * Vault 核心记忆引擎 + 确定性推理 + Obsidian 共享记忆库
 */
import { Database } from "bun:sqlite";
import { VaultManager } from "./memory/vault-manager.js";
import { DataPipeline } from "./crawl/data-pipeline.js";
import { searchAggregator } from "./crawl/search-engines.js";
import { proxyManager } from "./crawl/proxy-manager.js";
import { logger } from "./utils/logger.js";
import { searchCache, crawlCache } from "./utils/cache.js";
import { apiLimiter, createRateLimitMiddleware } from "./utils/rate-limiter.js";
import { getConfig } from "./utils/config.js";
import { KnowledgeGraph } from "./kg/graph.js";
import { wsManager } from "./utils/websocket.js";

// ===== 初始化 =====

await Bun.write("./data/.gitkeep", "").catch(() => {});
await Bun.write("./data/logs/.gitkeep", "").catch(() => {});

const config = getConfig();
const dbPath = config.memory.databasePath;
const db = new Database(dbPath);
const startupTime = Date.now();

logger.info("Axiom AI Agent 启动中", {
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

// Cron
try { await import("./cron/scheduler.js"); logger.info("Cron scheduler started"); }
catch (e: any) { logger.warn("Cron scheduler not started", { error: e.message }); }

// ===== 辅助函数 =====

async function checkPlatform(name: string, apiKey?: string): Promise<boolean> {
  if (!apiKey) return false;
  const endpoints: Record<string, string> = {
    siliconflow: "https://api.siliconflow.cn/v1/models",
    ofoxai: "https://api.ofox.ai/v1/models",
    openrouter: "https://openrouter.ai/api/v1/models",
    deepseek: "https://api.deepseek.com/v1/models",
  };
  try { const res = await fetch(endpoints[name], { headers: { Authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(3000) }); return res.ok; }
  catch { return false; }
}

function corsHeaders(): Record<string, string> {
  return { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS", "Access-Control-Allow-Headers": "Content-Type, Authorization" };
}

function jsonResponse(data: unknown, status = 200, extraHeaders?: Record<string, string>): Response {
  return Response.json(data, { status, headers: { ...corsHeaders(), ...extraHeaders } });
}

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

    if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders() });

    // WebSocket
    if (url.pathname === "/ws") {
      const success = server.upgrade(req, { data: { clientId: crypto.randomUUID() } } as any);
      if (success) return undefined as any;
      return jsonResponse({ error: "WebSocket upgrade failed" }, 400);
    }

    const rl = await rateLimitCheck(req);
    if (!rl.allowed) {
      await logRequest(req, 429, Math.round(performance.now() - startTime), { rateLimited: true });
      return jsonResponse({ error: "Rate limit exceeded" }, 429, rl.headers);
    }

    try {
      let response: Response;

      // === Dashboard ===
      if (url.pathname === "/" || url.pathname === "/index.html") {
        const file = Bun.file("./public/index.html");
        response = await file.exists()
          ? new Response(file, { headers: { "Content-Type": "text/html", ...corsHeaders() } })
          : jsonResponse({ error: "Dashboard not found" }, 404);
      }

      // === Health ===
      else if (url.pathname === "/health") {
        const checks: Record<string, boolean> = {};
        checks.database = (() => { try { db.query("SELECT 1").get(); return true; } catch { return false; } })();
        const [sf, ofx, or, ds] = await Promise.all([
          checkPlatform("siliconflow", process.env.SILICONFLOW_API_KEY),
          checkPlatform("ofoxai", process.env.OFOXAI_API_KEY),
          checkPlatform("openrouter", process.env.OPENROUTER_API_KEY),
          checkPlatform("deepseek", process.env.DEEPSEEK_API_KEY),
        ]);
        checks.siliconflow = sf; checks.ofoxai = ofx; checks.openrouter = or; checks.deepseek = ds;
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

      // === Chat ===
      else if (url.pathname === "/chat" && req.method === "POST") {
        const body = await req.json();
        const { taskType = "general-chat", messages = [] } = body;
        const { router } = await import("./router/model-router.js");
        const result = await router.chat(taskType, messages);
        response = jsonResponse(result, 200, rl.headers);
        wsManager.broadcast({ type: "model.usage", payload: { taskType, provider: result.provider }, timestamp: new Date().toISOString() });
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
      else if (url.pathname === "/vault/reload" && req.method === "POST") {
        if (!vault) { response = jsonResponse({ error: "Vault not initialized" }, 503, rl.headers); }
        else { vault.reload(); response = jsonResponse({ ok: true }, 200, rl.headers); }
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

      // === Default ===
      else {
        response = jsonResponse({
          name: "Axiom AI Agent", version: "2.1.0",
          uptime: Math.floor((Date.now() - startupTime) / 1000),
          endpoints: [
            "GET  /                        — Dashboard",
            "GET  /health                  — 健康检查",
            "POST /chat                    — 模型聊天",
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

      await logRequest(req, response.status, Math.round(performance.now() - startTime));
      return response;
    } catch (e: any) {
      const duration = Math.round(performance.now() - startTime);
      logger.error(`Request failed: ${url.pathname}`, e, { method: req.method, duration });
      await logRequest(req, 500, duration, { error: e.message });
      return jsonResponse({ error: e.message, path: url.pathname }, 500, rl.headers);
    }
  },

  websocket: {
    open(ws) { wsManager.onOpen(ws as any); },
    message(ws, message) { wsManager.onMessage(ws as any, message as string); },
    close(ws) { wsManager.onClose(ws as any); },
  },
});

logger.info("Server started", { port, url: `http://localhost:${port}` });

console.log(`
╔══════════════════════════════════════════════════════════════╗
║     Axiom AI Agent v2.1 — Vault 核心记忆引擎运行中       ║
║  记忆: Obsidian Vault (确定性推理)                           ║
║  Dashboard: http://localhost:${port}/                          ║
║  WebSocket: ws://localhost:${port}/ws                          ║
╚══════════════════════════════════════════════════════════════╝
`);

process.on("SIGINT", () => {
  logger.info("Shutting down...");
  db.close(); vault?.close(); kg.close(); server.stop(); process.exit(0);
});

```