/**
 * OpenClaw AI Agent — 主入口 v2.2
 * Vault 核心记忆引擎 + 确定性推理 + Obsidian 共享记忆库
 *
 * 架构升级:
 *   - O(1) 路由引擎 (Trie + 请求缓存 + 性能分析)
 *   - 统一配置中心 (交互式配置管理)
 *   - 架构自检系统 (启动时自动健康检查)
 *   - 黑板系统 (多 Agent 状态共享)
 *   - 读取优化管道 (分层缓存 + 字段投影)
 */
import { Database } from "bun:sqlite";
import type { ServerWebSocket } from "bun";
import { VaultManager } from "./memory/vault-manager.js";
import { DataPipeline } from "./crawl/data-pipeline.js";
import { logger } from "./utils/logger.js";
import { getConfig } from "./utils/config.js";
import { wsManager } from "./utils/websocket.js";
import { VaultFileWatcher } from "./memory/file-watcher.js";
import { HealthMonitor } from "./utils/resilience.js";
import { validateEnv } from "./utils/env-validation.js";
import { registerShutdownHook, setupGracefulShutdown } from "./utils/graceful-shutdown.js";
import { createSecurityHeaders, createCorsHeaders } from "./utils/security.js";
import { createRateLimitMiddleware, apiLimiter } from "./utils/rate-limiter.js";
import { metrics } from "./utils/metrics.js";
import type { RouteContext, WebSocketData } from "./routes/types.js";
import { dispatch, defaultResponse, registerTrieRoutes } from "./routes/index.js";
import {
  initApiKeyOverridesTable,
  loadApiKeyOverrides,
} from "./utils/api-key-persistence.js";
import { loadOverrides as loadApiKeyStoreOverrides } from "./utils/api-key-store.js";

// ═══════════════════════════════════════════════════════════════
// Native Bridge — Rust 高性能核心 (v2.3)
// ═══════════════════════════════════════════════════════════════
import {
  initNativeBridge,
  stopNativeBridge,
  nativeSearch,
  nativeRouterPerf,
  nativeStats,
  isNativeReady,
  detectEdition,
} from "./native-bridge.js";

const edition = detectEdition();
logger.info(`[Edition] Detected: ${edition}`);

// 启动 Rust 核心 (sidecar)
const nativeEnabled = process.env.OPENCLAW_NATIVE !== "false";
if (nativeEnabled) {
  const nativeOk = await initNativeBridge({
    edition,
    port: 18790,
    vaultPath: process.env.OBSIDIAN_VAULT_PATH || "./openclaw-memory",
    dbPath: process.env.DATABASE_PATH || "./data/agent.db",
    databaseUrl: process.env.DATABASE_URL,
    redisUrl: process.env.REDIS_URL,
    enabled: true,
  });
  if (nativeOk) {
    logger.info("[NativeBridge] Rust core active — search/routing accelerated");
  }
}

// ═══════════════════════════════════════════════════════════════
// 核心架构组件
// ═══════════════════════════════════════════════════════════════
import { getConfigCenter } from "./core/config-center.js";
import { runHealthCheck, printHealthReport } from "./core/health-checker.js";
import { getRouterEngine } from "./core/router-engine.js";
import { initializeReadOptimizers } from "./utils/read-optimizer-init.js";

// ===== 统一配置中心 =====
const configCenter = getConfigCenter();
logger.info("[ConfigCenter] Initialized", { keys: configCenter.getAll().length });

// ===== 架构自检 =====
const healthReport = await runHealthCheck();
printHealthReport(healthReport);

if (healthReport.overall === "critical") {
  logger.error("[HealthCheck] System in critical state, please fix errors before starting");
  process.exit(1);
}

// ===== 读取优化管道初始化 =====
initializeReadOptimizers(process.cwd());

// ===== 环境验证 =====
const envValidation = validateEnv({ strict: false, exitOnError: false });
if (!envValidation.valid) {
  logger.warn("Environment validation warnings present", {
    missing: envValidation.missing,
    invalid: envValidation.invalid.map(i => i.name),
  });
}

// ===== Runtime Kernel 初始化 =====
import { initRuntime, initProjections, tickEngine, worldState, eventBus, getRuntimeStatus } from "./runtime/index.js";
import { initActors } from "./runtime/actors.js";
import { initConstraints } from "./runtime/constraint-solver.js";
import { initCapabilities } from "./runtime/capability-registry.js";
import { initRules } from "./runtime/rule-engine.js";

initRuntime();
initProjections();
initActors();
initConstraints();
initCapabilities();
initRules();

// Store startup time in world state
worldState.set("system.startTime", Date.now());
worldState.set("system.version", "2.8.2");
worldState.set("system.edition", edition);

// Start tick engine (1 second interval)
tickEngine.start(1000);

// Subscribe to runtime events for logging
eventBus.subscribe("task.completed", (evt) => {
  const data = evt.data as { name?: string; duration?: number };
  logger.debug("[Runtime] Task completed", { name: data.name, duration: data.duration });
});

eventBus.subscribe("task.failed", (evt) => {
  const data = evt.data as { name?: string; error?: string };
  logger.warn("[Runtime] Task failed", { name: data.name, error: data.error });
});

logger.info("[Runtime] Kernel initialized", getRuntimeStatus());

// ===== 初始化 =====
await Bun.write("./data/.gitkeep", "").catch(() => {});
await Bun.write("./data/logs/.gitkeep", "").catch(() => {});

const config = getConfig();
const dbPath = config.memory.databasePath;
const db = new Database(dbPath);
const startupTime = Date.now();

logger.info("OpenClaw AI Agent 启动中", {
  version: "2.3.0",
  edition,
  native: isNativeReady(),
  node: process.version,
  bun: Bun.version,
  env: process.env.NODE_ENV || "development",
});

// 系统状态
db.run(`CREATE TABLE IF NOT EXISTS system_state (key TEXT PRIMARY KEY, value TEXT, updated_at INTEGER DEFAULT (unixepoch()))`);
db.run(`INSERT OR REPLACE INTO system_state (key, value) VALUES (?, ?)`, ["last_boot", new Date().toISOString()]);

// 加载持久化的 API Key 覆盖
initApiKeyOverridesTable(db);
const persistedOverrides = loadApiKeyOverrides(db);
loadApiKeyStoreOverrides(persistedOverrides);

// Vault — 核心记忆引擎
let vault: VaultManager | null = null;
try {
  vault = new VaultManager({ vaultPath: config.memory.vaultPath });
  logger.info("VaultManager initialized", { notes: vault.stats().totalNotes });
} catch (e: unknown) {
  logger.warn("VaultManager init failed", { error: (e as Error).message });
}

// 注册 VaultManager 执行器到 ReadOptimizerFacade
if (vault) {
  const { getReadOptimizer } = await import("./utils/read-optimizer.js");
  const facade = getReadOptimizer();
  facade.registerExecutor("vault", async (req) => {
    const { action, params } = req;
    switch (action) {
      case "stats": return vault!.stats();
      case "browsePara": return vault!.browsePara(String(params.category ?? ""));
      case "browseTag": return vault!.browseTag(String(params.tag ?? ""));
      case "getNetwork": return vault!.getNetwork(String(params.notePath ?? ""), Number(params.depth ?? 1));
      case "readNote": {
        const note = vault!.readNote(String(params.notePath ?? ""));
        return note ? { path: params.notePath, ...note } : null;
      }
      case "search": {
        const query = String(params.query ?? "");
        const limit = Number(params.limit ?? 20);
        return vault!.search(query, { limit });
      }
      default:
        throw new Error(`Unknown vault action: ${action}`);
    }
  });
}

// Pipeline
const pipeline = new DataPipeline({
  maxConcurrent: config.crawler.maxConcurrent,
  requestDelay: config.crawler.requestDelay,
});
logger.info("DataPipeline initialized");

// Agent Auto-Discovery
{
  const { discoverAgentsIfNeeded, listAgentSources } = await import("./agents/agent-discovery.js");
  const sources = listAgentSources();
  for (const sourceDir of sources) {
    const result = discoverAgentsIfNeeded({ sourceDir, force: false });
    if (result) {
      logger.info("Agent index updated", {
        source: sourceDir, total: result.count, new: result.newCount, updated: result.updatedCount,
      });
    }
  }
}

// File Watcher
let fileWatcher: VaultFileWatcher | null = null;
if (vault) {
  fileWatcher = new VaultFileWatcher({
    vaultPath: config.memory.vaultPath,
    codegraphProjectPath: process.cwd(),
  });
  fileWatcher.start((event, path) => {
    wsManager.broadcast({ type: "vault_change", payload: { event, file: path }, timestamp: new Date().toISOString() });
  });
  logger.info("VaultFileWatcher started", { watchedDirs: fileWatcher.watchedCount });
}

// Cron
try { await import("./cron/scheduler.js"); logger.info("Cron scheduler started"); }
catch (e: unknown) { logger.warn("Cron scheduler not started", { error: (e as Error).message }); }

// Health Monitor
const healthMonitor = new HealthMonitor();
healthMonitor.register({ name: "database", check: async () => { try { db.query("SELECT 1").get(); return true; } catch { return false; } }, interval: 60000 });
if (vault) {
  healthMonitor.register({ name: "vault", check: async () => { try { vault!.stats(); return true; } catch { return false; } }, interval: 60000 });
}
const platformChecks: [string, string][] = [
  ["siliconflow", "SILICONFLOW_API_KEY"], ["ofoxai", "OFOXAI_API_KEY"],
  ["openrouter", "OPENROUTER_API_KEY"], ["deepseek", "DEEPSEEK_API_KEY"],
  ["kimiCode", "KIMI_CODE_API_KEY"],
  ["nvidia-nim", "NIM_API_KEY"],
];
const platformEndpoints: Record<string, string> = {
  siliconflow: "https://api.siliconflow.cn/v1/models", ofoxai: "https://api.ofox.ai/v1/models",
  openrouter: "https://openrouter.ai/api/v1/models", deepseek: "https://api.deepseek.com/v1/models",
  kimiCode: "https://api.kimi.com/coding/v1/models",
  "nvidia-nim": "https://integrate.api.nvidia.com/v1/models",
};
for (const [name, envKey] of platformChecks) {
  healthMonitor.register({
    name, interval: 120000,
    check: async () => {
      const apiKey = process.env[envKey];
      if (!apiKey) return false;
      try {       const res = await fetch(platformEndpoints[name], { headers: { Authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(3000) }); return res.ok; }
      catch { return false; }
    },
  });
}
healthMonitor.start();

// Plugin Market (插件市场)
import { initPluginRoutes } from "./routes/plugin-adapter.js";
import { initSceneRouter } from "./routes/scene-routes.js";
import { ToolRegistry } from "./mcp/tool-registry.js";
const pluginToolRegistry = new ToolRegistry();
initPluginRoutes(db, pluginToolRegistry);
initSceneRouter(pluginToolRegistry);
logger.info("Plugin market initialized");

import { TIMEOUTS } from "./constants/timeouts.js";
import { toOpenClawError, createErrorResponse } from "./utils/errors.js";

// WebSocket heartbeat
let heartbeatInterval: ReturnType<typeof setInterval> | null = null;

function startHeartbeat(): void {
  heartbeatInterval = setInterval(() => {
    wsManager.broadcast({
      type: "heartbeat",
      payload: { uptime: Date.now() - startupTime, clients: wsManager.getStats().connectedClients, vaultNotes: vault?.stats().totalNotes ?? 0 },
      timestamp: new Date().toISOString(),
    });
  }, TIMEOUTS.HEARTBEAT_INTERVAL);
}

/** 停止心跳 */
function stopHeartbeat(): void {
  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
    heartbeatInterval = null;
  }
}

// ===== 注册 Trie 路由 (启动时一次性注册) =====
const routerEngine = getRouterEngine();
registerTrieRoutes(routerEngine);
logger.info("[RouterEngine] Trie routes registered", { count: routerEngine.getRoutes().length });

// ===== HTTP 服务 =====
const securityHeaders = createSecurityHeaders({ hsts: process.env.NODE_ENV === "production", csp: true });
const rateLimitCheck = createRateLimitMiddleware(apiLimiter);
const MAX_BODY_SIZE = parseInt(process.env.MAX_BODY_SIZE || "1048576", 10);
const port = config.gateway.port;

function corsHeaders(origin?: string): Record<string, string> {
  return createCorsHeaders(origin, {
    allowedOrigins: process.env.CORS_ORIGINS?.split(",") || [`http://localhost:${port}`, `http://127.0.0.1:${port}`],
    allowedMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "X-Request-ID"],
    allowCredentials: !!process.env.CORS_CREDENTIALS,
  });
}

function jsonResponse(data: unknown, status = 200, extraHeaders?: Record<string, string>): Response {
  return Response.json(data, { status, headers: { ...securityHeaders, ...corsHeaders(), ...extraHeaders } });
}

// Static file MIME types for the public/ SPA shell
const STATIC_MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js":   "application/javascript; charset=utf-8",
  ".mjs":  "application/javascript; charset=utf-8",
  ".css":  "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png":  "image/png",
  ".jpg":  "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif":  "image/gif",
  ".svg":  "image/svg+xml",
  ".ico":  "image/x-icon",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".map":  "application/json; charset=utf-8",
  ".txt":  "text/plain; charset=utf-8",
};
const STATIC_ROOT = "./public";

/**
 * Serve a static file from ./public/ for the SPA shell.
 * Returns null if the file doesn't exist or path is unsafe (caller falls through to API).
 */
async function serveStaticFile(pathname: string): Promise<Response | null> {
  if (pathname === "/" || pathname === "") return null; // let handleDashboard serve index.html
  // Path safety: reject traversal attempts
  const safe = pathname.replace(/^\/+/, "");
  if (safe.includes("..") || safe.includes("\\")) return null;
  const ext = safe.includes(".") ? safe.slice(safe.lastIndexOf(".")) : "";
  if (!STATIC_MIME[ext]) return null; // unknown extension → not a static asset
  const filePath = `${STATIC_ROOT}/${safe}`;
  const file = Bun.file(filePath);
  if (!(await file.exists())) return null;
  return new Response(file, {
    status: 200,
    headers: { ...securityHeaders, "Content-Type": STATIC_MIME[ext], "Cache-Control": "no-cache" },
  });
}

const API_KEY = process.env.OPENCLAW_AUTH_TOKEN;

function checkApiKey(req: Request): boolean {
  // Fail-closed: if no server-side auth token is configured, deny ALL requests.
  // This protects /chat and other endpoints from open access when env is misconfigured.
  const url = new URL(req.url);
  // Allow local requests without auth (for E2E tests and local development)
  if (url.hostname === "localhost" || url.hostname === "127.0.0.1") return true;
  logger.debug("checkApiKey called", { path: url.pathname, apiKeyExists: !!API_KEY, apiKeyLength: API_KEY?.length });
  if (!API_KEY) {
    // No auth token configured: allow static assets and public paths, deny API endpoints
    const staticExt = url.pathname.includes(".") ? url.pathname.slice(url.pathname.lastIndexOf(".")) : "";
    if (STATIC_MIME[staticExt]) return true;
    const publicPaths = ["/health", "/", "/manifest.json", "/sw.js", "/icon.png", "/favicon.ico"];
    if (publicPaths.includes(url.pathname)) return true;
    if (url.pathname.startsWith("/ws")) return true;
    logger.warn("Auth check failed: OPENCLAW_AUTH_TOKEN not configured");
    return false;
  }
  const publicPaths = ["/health", "/", "/manifest.json", "/sw.js", "/icon.png", "/favicon.ico"];
  if (publicPaths.includes(url.pathname)) return true;
  // Allow all static assets (JS, CSS, images, fonts, etc.) so the SPA shell loads without auth
  const staticExt = url.pathname.includes(".") ? url.pathname.slice(url.pathname.lastIndexOf(".")) : "";
  if (STATIC_MIME[staticExt]) {
    logger.debug("Static asset allowed without auth", { path: url.pathname, ext: staticExt });
    return true;
  }
  // WebSocket: check auth in upgrade handler, not here
  if (url.pathname.startsWith("/ws")) return true;
  const auth = req.headers.get("x-api-key") || req.headers.get("authorization")?.replace("Bearer ", "");
  return auth === API_KEY;
}

console.log("[SERVER] Auth relaxed for localhost/127.0.0.1 — starting...");

const server = Bun.serve({
  port,
  hostname: process.env.HOST || "127.0.0.1",
  async fetch(req, server) {
    const startTime = performance.now();
    const url = new URL(req.url);
    const requestOrigin = req.headers.get("origin") || "";
    const baseHeaders = { ...securityHeaders, ...corsHeaders(requestOrigin) };

    if (req.method === "OPTIONS") return new Response(null, { headers: baseHeaders });

    // API Key authentication
    if (!checkApiKey(req)) {
      return jsonResponse({ error: "Unauthorized — invalid or missing API key" }, 401, baseHeaders);
    }

    // WebSocket — verify auth token before upgrade (localhost always allowed for dev)
    if (url.pathname === "/ws") {
      const isLocal = url.hostname === "localhost" || url.hostname === "127.0.0.1";
      const wsAuth = req.headers.get("x-api-key") || req.headers.get("authorization")?.replace("Bearer ", "");
      if (!isLocal && wsAuth !== API_KEY) {
        return jsonResponse({ error: "Unauthorized — invalid or missing API key" }, 401, baseHeaders);
      }
      const wsData: WebSocketData = { clientId: crypto.randomUUID() };
      const success = server.upgrade(req, { data: wsData } as unknown as Parameters<typeof server.upgrade>[1]);
      if (success) return undefined as unknown as Response;
      return jsonResponse({ error: "WebSocket upgrade failed" }, 400, baseHeaders);
    }

    // Rate limiting
    const rl = await rateLimitCheck(req);
    if (!rl.allowed) {
      logger.debug("Rate limited", { path: url.pathname });
      return jsonResponse({ error: "Rate limit exceeded" }, 429, rl.headers);
    }

    // Request body size check
    if (req.method === "POST" || req.method === "PUT" || req.method === "PATCH") {
      const contentLength = parseInt(req.headers.get("content-length") || "0", 10);
      if (contentLength > MAX_BODY_SIZE) {
        return jsonResponse({ error: `Request body too large (max ${MAX_BODY_SIZE} bytes)` }, 413, baseHeaders);
      }
    }

    try {
      // Build route context
      const ctx: RouteContext = {
        url, req, vault, db, pipeline, healthMonitor, fileWatcher,
        startupTime, baseHeaders, jsonResponse,
      };

      // Try static files first (SPA shell assets)
      let response = await serveStaticFile(url.pathname);

      // 使用高性能路由引擎 (O(1) Trie + 请求缓存 + 性能分析)
      if (!response) {
        response = await routerEngine.execute(ctx);
      }

      // 回退到传统路由系统
      if (!response) {
        response = await dispatch(ctx);
      }

      if (!response) {
        response = defaultResponse(ctx);
      }

      // Metrics
      const duration = (performance.now() - startTime) / 1000;
      metrics.increment("http_requests_total", 1, { method: req.method, path: url.pathname, status: String(response.status) });
      metrics.histogram("http_request_duration_seconds", duration, { method: req.method, path: url.pathname });

      return response;
    } catch (e) {
      const duration = Math.round(performance.now() - startTime);
      const error = toOpenClawError(e, `Request failed: ${url.pathname}`);
      logger.error(error.message, error, { method: req.method, duration, path: url.pathname });
      metrics.increment("http_requests_total", 1, { method: req.method, path: url.pathname, status: "500" });
      return jsonResponse(createErrorResponse(error), 500, { ...rl.headers, ...securityHeaders });
    }
  },

  websocket: {
    open(ws) { wsManager.onOpen(ws as unknown as ServerWebSocket<{ clientId: string }>); },
    message(ws, message) { wsManager.onMessage(ws as unknown as ServerWebSocket<{ clientId: string }>, message as string); },
    close(ws) { wsManager.onClose(ws as unknown as ServerWebSocket<{ clientId: string }>); },
  },
});

// 启动心跳
startHeartbeat();

// ===== Shutdown hooks =====
registerShutdownHook({ name: "health-monitor", handler: () => healthMonitor.stop(), priority: 100 });
registerShutdownHook({ name: "file-watcher", handler: () => fileWatcher?.stop(), priority: 80 });
registerShutdownHook({ name: "vault", handler: () => vault?.close(), priority: 70 });
registerShutdownHook({ name: "database", handler: () => db.close(), priority: 50 });
registerShutdownHook({ name: "http-server", handler: () => server.stop(), priority: 40 });
registerShutdownHook({ name: "heartbeat", handler: () => stopHeartbeat(), priority: 30 });
registerShutdownHook({ name: "plugins", handler: () => { logger.info("Plugins shutdown"); }, priority: 25 });
registerShutdownHook({ name: "native-bridge", handler: () => stopNativeBridge(), priority: 20 });

setupGracefulShutdown({ timeout: TIMEOUTS.GRACEFUL_SHUTDOWN, signals: ["SIGTERM", "SIGINT"] });

logger.info("Server started", { port, hostname: process.env.HOST || "127.0.0.1", url: `http://${process.env.HOST || "127.0.0.1"}:${port}` });

const localUrl = `http://localhost:${port}`;
import { networkInterfaces } from "os";
const nets = networkInterfaces();
let lanIp = "127.0.0.1";
for (const name of Object.keys(nets)) {
  for (const net of nets[name] || []) {
    if (net.family === "IPv4" && !net.internal) {
      lanIp = net.address;
      break;
    }
  }
  if (lanIp !== "127.0.0.1") break;
}
const lanUrl = `http://${lanIp}:${port}`;

console.log(`
╔══════════════════════════════════════════════════════════════════════╗
║     OpenClaw AI Agent v2.3 — Vault 核心记忆引擎运行中               ║
║  记忆: Obsidian Vault (确定性推理)                                   ║
║  版本:  ${(edition === "cloud" ? "☁️ Cloud" : "🏠 Local").padEnd(58)} ║
║  原生:  ${(isNativeReady() ? "🦀 Rust Core Active" : "📜 TypeScript Only").padEnd(58)} ║
║                                                                      ║
║  本地访问:  ${localUrl.padEnd(58)} ║
║  局域网:    ${lanUrl.padEnd(58)} ║
║  WebSocket: ws://${process.env.HOST || "127.0.0.1"}:${port}/ws${"".padEnd(38)} ║
║  API Key:   ${API_KEY ? "已启用 (x-api-key 鉴权)" : "未设置 (所有请求将被拒绝)"}            ║
╚══════════════════════════════════════════════════════════════════════╝
`);
