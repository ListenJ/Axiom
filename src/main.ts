/**
 * OpenClaw AI Agent — 主入口 v2.2
 * Vault 核心记忆引擎 + 确定性推理 + Obsidian 共享记忆库
 *
 * Routes 拆分到 src/routes/ 模块，main.ts 只负责初始化和服务器启动
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
import { dispatch, defaultResponse } from "./routes/index.js";
import {
  initApiKeyOverridesTable,
  loadApiKeyOverrides,
} from "./utils/api-key-persistence.js";
import { loadOverrides as loadApiKeyStoreOverrides } from "./utils/api-key-store.js";

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
  version: "2.2.0",
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
];
for (const [name, envKey] of platformChecks) {
  const endpoints: Record<string, string> = {
    siliconflow: "https://api.siliconflow.cn/v1/models", ofoxai: "https://api.ofox.ai/v1/models",
    openrouter: "https://openrouter.ai/api/v1/models", deepseek: "https://api.deepseek.com/v1/models",
    kimiCode: "https://api.kimi.com/coding/v1/models",
  };
  healthMonitor.register({
    name, interval: 120000,
    check: async () => {
      const apiKey = process.env[envKey];
      if (!apiKey) return false;
      try { const res = await fetch(endpoints[name], { headers: { Authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(3000) }); return res.ok; }
      catch { return false; }
    },
  });
}
healthMonitor.start();

// Plugin Market (插件市场)
import { initPluginRoutes } from "./routes/plugin-adapter.js";
import { ToolRegistry } from "./mcp/tool-registry.js";
const pluginToolRegistry = new ToolRegistry();
initPluginRoutes(db, pluginToolRegistry);
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
export function stopHeartbeat(): void {
  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
    heartbeatInterval = null;
  }
}

// ===== HTTP 服务 =====
const securityHeaders = createSecurityHeaders({ hsts: process.env.NODE_ENV === "production", csp: false });
const rateLimitCheck = createRateLimitMiddleware(apiLimiter);
const MAX_BODY_SIZE = parseInt(process.env.MAX_BODY_SIZE || "1048576", 10);
const port = config.gateway.port;

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
  logger.debug("checkApiKey called", { path: url.pathname, apiKeyExists: !!API_KEY, apiKeyLength: API_KEY?.length });
  if (!API_KEY) {
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

const server = Bun.serve({
  port,
  hostname: "0.0.0.0",
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

    // WebSocket — verify auth token before upgrade
    if (url.pathname === "/ws") {
      const wsAuth = req.headers.get("x-api-key") || req.headers.get("authorization")?.replace("Bearer ", "");
      if (wsAuth !== API_KEY) {
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

      // Dispatch to route handlers
      let response = await dispatch(ctx);
      if (!response) {
        // Try to serve a static file from public/ before falling back to JSON default
        const staticResp = await serveStaticFile(url.pathname);
        response = staticResp ?? defaultResponse(ctx);
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

setupGracefulShutdown({ timeout: TIMEOUTS.GRACEFUL_SHUTDOWN, signals: ["SIGTERM", "SIGINT"] });

logger.info("Server started", { port, hostname: "0.0.0.0", url: `http://0.0.0.0:${port}` });

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
║     OpenClaw AI Agent v2.2 — Vault 核心记忆引擎运行中               ║
║  记忆: Obsidian Vault (确定性推理)                                   ║
║                                                                      ║
║  本地访问:  ${localUrl.padEnd(58)} ║
║  局域网:    ${lanUrl.padEnd(58)} ║
║  WebSocket: ws://0.0.0.0:${port}/ws${"".padEnd(38)} ║
║  API Key:   ${API_KEY ? "已启用 (x-api-key 鉴权)" : "未设置 (所有请求将被拒绝)"}            ║
╚══════════════════════════════════════════════════════════════════════╝
`);
