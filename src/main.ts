/**
 * Axiom AI Agent — 主入口 v2.2
 * Vault 核心记忆引擎 + 确定性推理 + Obsidian 共享记忆
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
import { getConfig, getConfigCenter } from "./core/config-center.js";
import { wsManager } from "./utils/websocket.js";
import { checkWsUpgradeAuth, WS_AUTH_SUBPROTOCOL } from "./utils/ws-auth.js";
import { VaultFileWatcher } from "./memory/file-watcher.js";
import { HealthMonitor } from "./utils/resilience.js";
import { validateEnv, readString, readInt, readBool } from "./utils/env.js";
import { registerShutdownHook, setupGracefulShutdown } from "./utils/graceful-shutdown.js";
import { createSecurityHeaders } from "./utils/security.js";
import { createRateLimitMiddleware, apiLimiter } from "./utils/rate-limiter.js";
import { isLocalAddress, checkApiKey } from "./utils/auth-check.js";
import { auditLogger } from "./utils/audit-logger.js";
import { getTrafficClassifier, type TrafficFeatures } from "./utils/traffic-classifier.js";
import { metrics } from "./utils/metrics.js";
import type { RouteContext, WebSocketData } from "./routes/types.js";
import { dispatch, defaultResponse, registerTrieRoutes } from "./routes/index.js";
import {
  initApiKeyOverridesTable,
  loadApiKeyOverrides,
} from "./utils/api-key-persistence.js";
import { loadOverrides as loadApiKeyStoreOverrides } from "./utils/api-key-store.js";

// ════════════════════════════════════════════════════════════════
// Native Bridge — Rust 高性能核心 (v2.3)
// ════════════════════════════════════════════════════════════════
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
const nativeEnabled = readBool("AXIOM_NATIVE", true);
if (nativeEnabled) {
  const nativeOk = await initNativeBridge({
    edition,
    port: 18790,
    vaultPath: readString("OBSIDIAN_VAULT_PATH", "./axiom-memory"),
    dbPath: readString("DATABASE_PATH", "./data/agent.db"),
    databaseUrl: readString("DATABASE_URL"),
    redisUrl: readString("REDIS_URL"),
    enabled: true,
  });
  if (nativeOk) {
    logger.info("[NativeBridge] Rust core active — search/routing accelerated");
  }
}

// ════════════════════════════════════════════════════════════════
// 核心架构组件
// ════════════════════════════════════════════════════════════════
import { runHealthCheck, printHealthReport } from "./core/health-checker.js";
import { getHttpRouter } from "./core/http-router.js";
import { getGlobalBlackboard } from "./memory/blackboard.js";
import { getReadOptimizer } from "./utils/read-optimizer.js";
import { initializeReadOptimizers } from "./utils/read-optimizer-init.js";
import {
  searchSymbols,
  searchFiles,
  buildContext,
  getCallers,
  getCallees,
  getImpact,
  getStatus,
} from "./memory/codegraph-index.js";
import { PiCodeToolsAdapter } from "./pi-agent/pi-code-tools.js";
import { getConsciousness } from "./agents/consciousness/index.js";

// ════════════════════════════════════════════════════════════════
// 数学突破模型 (Math Breakthroughs)
// ════════════════════════════════════════════════════════════════
import { VIBCompressor } from "./memory/vib-compressor.js";
import { ConformalRetriever } from "./memory/conformal-retriever.js";
import { ConformalHallucinationDetector } from "./memory/hallucination-detector.js";
import { createThompsonRouter } from "./router/thompson-router.js";
import { RateDistortionCompressor } from "./context/rate-distortion-compressor.js";
import { ConsensusEngine } from "./agents/consensus-engine.js";
import { MathEnhancedMemory } from "./memory/math-enhanced-memory.js";

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
getReadOptimizer().setBlackboard(getGlobalBlackboard());
initializeReadOptimizers(process.cwd(), {
  searchSymbols,
  searchFiles,
  buildContext,
  getCallers,
  getCallees,
  getImpact,
  getStatus,
  PiCodeToolsAdapter,
});

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

logger.info("Axiom AI Agent 启动", {
  version: "2.3.0",
  edition,
  native: isNativeReady(),
  node: process.version,
  bun: Bun.version,
  env: readString("NODE_ENV", "development"),
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

// Math breakthrough modules
const mathContext = {
  vibCompressor: new VIBCompressor({ beta: 1.5, capacity: 100 }),
  conformalRetriever: new ConformalRetriever<unknown>({ alpha: 0.1 }),
  hallucinationDetector: new ConformalHallucinationDetector({ alpha: 0.05, factBase: [] }),
  thompsonRouter: createThompsonRouter({ arms: [], minSamples: 5, inMemory: true }),
  rateDistortionCompressor: new RateDistortionCompressor({ maxDistortion: 0.3, minRate: 0.1 }),
  consensusEngine: new ConsensusEngine({ agents: [], beta: 0.5, mode: "wma" }),
  enhancedMemory: null as MathEnhancedMemory | null,
};
if (vault) {
  mathContext.enhancedMemory = new MathEnhancedMemory({
    vaultPath: config.memory.vaultPath,
    vibConfig: { beta: 1.5, capacity: 50 },
    conformalConfig: { alpha: 0.1 },
    hallucinationConfig: { alpha: 0.05 },
  });
}
logger.info("[MathBreakthroughs] All 6 modules initialized");

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

// HITL 审批闭环（2026-07-26 前端审查修复 H1）：
// 执行层强制审批 → ApprovalBridge → WS 广播 approval.requested，
// 客户端经 POST /approvals/:id/resolve 提交决定（REST 兜底，WS 仅通知）
try {
  const { getApprovalBridge } = await import("./utils/approval-bridge.js");
  getApprovalBridge().onRequest((req) => {
    wsManager.broadcast({
      type: "approval.requested",
      payload: {
        id: req.id,
        tool: req.tool,
        args: req.args as Record<string, unknown>,
        risk: req.risk,
        requestedAt: req.requestedAt,
        timeoutMs: req.timeoutMs,
      },
      timestamp: new Date().toISOString(),
    });
    logger.info("[ApprovalBridge] broadcast approval.requested", { id: req.id, tool: req.tool });
  });
  logger.info("ApprovalBridge subscribed (HITL loop active)");
} catch (e: unknown) { logger.warn("ApprovalBridge subscribe failed", { error: (e as Error).message }); }

// Cron
try { await import("./cron/scheduler.js"); logger.info("Cron scheduler started"); }
catch (e: unknown) { logger.warn("Cron scheduler not started", { error: (e as Error).message }); }

// Consciousness (self-reflection module)
try {
  await getConsciousness().start({ enabled: readBool("CONSCIOUSNESS_ENABLED", true) });
  logger.info("[Consciousness] started");
} catch (e: unknown) {
  logger.warn("[Consciousness] failed to start", { error: (e as Error).message });
}

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

// 外部 MCP server 客户端连接 (R-015)：连接失败仅降级跳过，不影响启动
try {
  const { connectExternalMcpServers } = await import("./mcp/client-connector.js");
  const mcpSummary = await connectExternalMcpServers(pluginToolRegistry);
  logger.info("External MCP clients initialized", {
    connected: mcpSummary.connected.length,
    failed: mcpSummary.failed.length,
    tools: mcpSummary.toolsRegistered,
  });
} catch (e: unknown) { logger.warn("External MCP clients not started", { error: (e as Error).message }); }

import { TIMEOUTS } from "./constants/timeouts.js";
import { toAxiomError, createErrorResponse } from "./utils/errors.js";

// WebSocket heartbeat
let heartbeatInterval: ReturnType<typeof setInterval> | null = null;

function startHeartbeat(): void {
  // Phase P1-6: vault?.stats() is replaced with the async-refreshed cache.
  // The heartbeat must NEVER block the event loop, even briefly — the
  // cache runs in its own microtask, the heartbeat tick just reads.
  void (async () => {
    const { vaultStatsCache } = await import("./utils/vault-stats-cache.js");
    if (vault) vaultStatsCache.init(vault);
  })();
  heartbeatInterval = setInterval(() => {
    void (async () => {
      const { vaultStatsCache } = await import("./utils/vault-stats-cache.js");
      const vStats = vaultStatsCache.read();
      wsManager.broadcast({
        type: "heartbeat",
        payload: {
          uptime: Date.now() - startupTime,
          clients: wsManager.getStats().connectedClients,
          vaultNotes: vStats?.totalNotes ?? 0,
        },
        timestamp: new Date().toISOString(),
      });
    })();
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
const httpRouter = getHttpRouter();
registerTrieRoutes(httpRouter);
logger.info("[HttpRouter] Trie routes registered", { count: httpRouter.getRoutes().length });

// ===== HTTP 服务 =====
const securityHeaders = createSecurityHeaders({ hsts: readString("NODE_ENV") === "production", csp: true });
const rateLimitCheck = createRateLimitMiddleware(apiLimiter);
const MAX_BODY_SIZE = readInt("MAX_BODY_SIZE", 1048576);
const port = config.gateway.port;

// ═══════════════════════════════════════════════════════════════
// CORS 预计算 — 原 corsHeaders() 每请求都 readString("CORS_ORIGINS") +
// split + readBool + 分配 options/result 对象，且 jsonResponse 会二次调用。
// 现将所有不随请求变化的部分提至模块级，per-request 仅做 Set.has(origin) 判定。
// ═══════════════════════════════════════════════════════════════
const CORS_ALLOWED_ORIGINS_STR = readString("CORS_ORIGINS");
const CORS_ALLOWED_ORIGINS = CORS_ALLOWED_ORIGINS_STR
  ? CORS_ALLOWED_ORIGINS_STR.split(",")
  : [`http://localhost:${port}`, `http://127.0.0.1:${port}`];
const CORS_ALLOW_CREDENTIALS = readBool("CORS_CREDENTIALS");
const CORS_ALLOWED_ORIGINS_SET = new Set(CORS_ALLOWED_ORIGINS);
const CORS_ALLOW_ALL = CORS_ALLOWED_ORIGINS.includes("*");

// 静态 CORS 头（不随 origin 变化）—— credentials 仅在具体 origin 命中时附加，
// 与 createCorsHeaders 原行为保持一致。
const CORS_STATIC_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Request-ID",
  "Access-Control-Max-Age": "86400",
};
// 无 origin 或 origin 未匹配时的预计算结果（jsonResponse 路径复用此对象）
const CORS_NO_ORIGIN_HEADERS: Record<string, string> = CORS_ALLOW_ALL
  ? { ...CORS_STATIC_HEADERS, "Access-Control-Allow-Origin": "*" }
  : { ...CORS_STATIC_HEADERS };

function corsHeaders(origin?: string): Record<string, string> {
  if (CORS_ALLOW_ALL) return CORS_NO_ORIGIN_HEADERS;
  const reqOrigin = origin || "";
  if (reqOrigin && CORS_ALLOWED_ORIGINS_SET.has(reqOrigin)) {
    return CORS_ALLOW_CREDENTIALS
      ? { ...CORS_STATIC_HEADERS, "Access-Control-Allow-Origin": reqOrigin, "Access-Control-Allow-Credentials": "true" }
      : { ...CORS_STATIC_HEADERS, "Access-Control-Allow-Origin": reqOrigin };
  }
  return CORS_NO_ORIGIN_HEADERS;
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

// ── 静态资源压缩与缓存（2026-08-06 性能优化） ──────────────────────────
// 文本类资源 gzip 传输（内存缓存，构建产物不变则缓存命中），
// /assets/ 下带内容 hash 的文件给 immutable 长缓存（二次加载零协商）。
import { gzipSync } from "node:zlib";
const COMPRESSIBLE_EXT = new Set([".js", ".css", ".html", ".svg", ".json", ".txt", ".map"]);
const gzipCache = new Map<string, ArrayBuffer>();
const GZIP_MIN_BYTES = 1024;

/**
 * Serve a static file from ./public/ for the SPA shell.
 * Returns null if the file doesn't exist or path is unsafe (caller falls through to API).
 */
async function serveStaticFile(pathname: string, req: Request): Promise<Response | null> {
  if (pathname === "/" || pathname === "") return null; // let handleDashboard serve index.html
  // Path safety: reject traversal attempts
  const safe = pathname.replace(/^\/+/, "");
  if (safe.includes("..") || safe.includes("\\")) return null;
  const ext = safe.includes(".") ? safe.slice(safe.lastIndexOf(".")) : "";
  if (!STATIC_MIME[ext]) return null; // unknown extension — not a static asset
  const filePath = `${STATIC_ROOT}/${safe}`;
  const file = Bun.file(filePath);
  if (!(await file.exists())) return null;

  // /assets/ 为内容 hash 文件名 → immutable 长缓存；其余（index.html 等）每次校验
  const isHashedAsset = pathname.startsWith("/assets/");
  const cacheControl = isHashedAsset
    ? "public, max-age=31536000, immutable"
    : "no-cache";

  // gzip：仅文本类 + 超过阈值 + 客户端声明支持；压缩结果内存缓存
  const acceptsGzip = (req.headers.get("accept-encoding") ?? "").includes("gzip");
  if (acceptsGzip && COMPRESSIBLE_EXT.has(ext)) {
    const size = file.size;
    if (size > GZIP_MIN_BYTES) {
      let gz = gzipCache.get(filePath);
      if (!gz) {
        const raw = await file.arrayBuffer();
        gz = gzipSync(Buffer.from(raw)).buffer as ArrayBuffer;
        if (gzipCache.size > 128) gzipCache.clear();
        gzipCache.set(filePath, gz);
      }
      return new Response(gz, {
        status: 200,
        headers: {
          ...securityHeaders,
          "Content-Type": STATIC_MIME[ext],
          "Content-Encoding": "gzip",
          "Vary": "Accept-Encoding",
          "Cache-Control": cacheControl,
        },
      });
    }
  }

  return new Response(file, {
    status: 200,
    headers: { ...securityHeaders, "Content-Type": STATIC_MIME[ext], "Cache-Control": cacheControl },
  });
}

/**
 * 判断路径是否为 SPA 静态资源（供限流豁免预判使用）。
 * 与 serveStaticFile 同一判定口径：已知扩展名且文件存在于 STATIC_ROOT 下。
 */
async function isStaticAsset(pathname: string): Promise<boolean> {
  if (pathname === "/" || pathname === "") return false;
  const safe = pathname.replace(/^\/+/, "");
  if (safe.includes("..") || safe.includes("\\")) return false;
  const ext = safe.includes(".") ? safe.slice(safe.lastIndexOf(".")) : "";
  if (!STATIC_MIME[ext]) return false;
  return Bun.file(`${STATIC_ROOT}/${safe}`).exists();
}

const API_KEY = readString("AXIOM_AUTH_TOKEN");

// Local (loopback) requests skip auth for E2E tests and local development.
// Set AXIOM_ALLOW_LOCAL_BYPASS=0 when a reverse proxy runs on the same host,
// otherwise all proxied traffic appears to originate from 127.0.0.1.
const ALLOW_LOCAL_BYPASS = readBool("AXIOM_ALLOW_LOCAL_BYPASS", true);

logger.info("[SERVER] Auth relaxed for localhost/127.0.0.1 — starting...");

// SPA route whitelist — module-level Set avoids per-request allocation.
const SPA_ROUTES = new Set([
  "/chat", "/search", "/code", "/agents", "/router", "/vault", "/kg",
  "/sessions", "/eval", "/plugins", "/trends", "/ocr", "/research",
  "/knowledge", "/proxies", "/providers", "/tokens", "/perf", "/git", "/settings", "/login",
]);

// Pre-resolve SPA index.html file reference (Bun.file is lazy, no I/O at init)
const SPA_INDEX_FILE = Bun.file(`${STATIC_ROOT}/index.html`);

const server = Bun.serve({
  port,
  hostname: readString("HOST", "127.0.0.1"),
  async fetch(req, server) {
    const startTime = performance.now();
    const url = new URL(req.url);
    const requestOrigin = req.headers.get("origin") || "";
    const baseHeaders = { ...securityHeaders, ...corsHeaders(requestOrigin) };

    if (req.method === "OPTIONS") return new Response(null, { headers: baseHeaders });

    // Loopback detection via socket peer address (spoof-proof, unlike Host header)
    const remoteAddress = server.requestIP(req)?.address;
    const isLocal = ALLOW_LOCAL_BYPASS && isLocalAddress(remoteAddress);

    // SPA navigation routes — serve index.html before auth check so frontend
    // loads even when AXIOM_AUTH_TOKEN is configured. API endpoints (which use
    // multi-segment paths like /agents/status, /chat/stream, /system/state) are
    // NOT in this whitelist and still require auth.
    if (req.method === "GET" && SPA_ROUTES.has(url.pathname)) {
      if (await SPA_INDEX_FILE.exists()) {
        return new Response(SPA_INDEX_FILE, {
          status: 200,
          headers: { ...securityHeaders, "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" },
        });
      }
    }

    // API Key authentication
    if (!checkApiKey(req, isLocal, API_KEY, url.pathname)) {
      auditLogger.log({
        event: "auth.failure",
        actor: remoteAddress ?? "unknown",
        outcome: "denied",
        reason: "invalid or missing API key",
        resource: url.pathname,
      });
      return jsonResponse({ error: "Unauthorized - invalid or missing API key" }, 401, baseHeaders);
    }

    // WebSocket — verify auth token before upgrade (localhost always allowed for dev)
    if (url.pathname === "/ws") {
      const wsAuth = checkWsUpgradeAuth({
        headerAuth: req.headers.get("x-api-key") || req.headers.get("authorization")?.replace("Bearer ", "") || null,
        protocolHeader: req.headers.get("sec-websocket-protocol") ?? null,
        queryToken: url.searchParams.get("token") ?? null,
        isLocal,
        apiKey: API_KEY,
      });
      if (!wsAuth.ok) {
        auditLogger.log({
          event: "auth.failure",
          actor: remoteAddress ?? "unknown",
          outcome: "denied",
          reason: wsAuth.reason,
          resource: "/ws",
        });
        return jsonResponse({ error: "Unauthorized - invalid or missing API key" }, 401, baseHeaders);
      }
      const wsData: WebSocketData = { clientId: crypto.randomUUID() };
      // 客户端以 Sec-WebSocket-Protocol 携带凭证时回显 WS_AUTH_SUBPROTOCOL 完成握手；
      // 未提供子协议（header/query 鉴权）则不要求协商。
      const offered = (req.headers.get("sec-websocket-protocol") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
      const upgradeOpts = offered.length > 0
        ? { data: wsData, protocols: [WS_AUTH_SUBPROTOCOL] }
        : { data: wsData };
      const success = server.upgrade(req, upgradeOpts as unknown as Parameters<typeof server.upgrade>[1]);
      if (success) return undefined as unknown as Response;
      return jsonResponse({ error: "WebSocket upgrade failed" }, 400, baseHeaders);
    }

    // Rate limiting (keyed on the socket peer address, not spoofable headers)
    // 静态资源（SPA 的 JS/CSS/图片/字体）豁免 API 限流：单页 50+ 资源请求会把
    // 默认 100 次/min 配额耗尽导致页面白屏（2026-08-06 视觉审核 P0-3）。
    const isStaticAssetReq = await isStaticAsset(url.pathname);
    const rl = isStaticAssetReq
      ? { allowed: true, headers: {} as Record<string, string> }
      : await rateLimitCheck(req, remoteAddress, url.pathname);
    if (!rl.allowed) {
      auditLogger.log({
        event: "rate_limit.exceeded",
        actor: remoteAddress ?? "unknown",
        outcome: "denied",
        reason: "rate limit exceeded",
        resource: url.pathname,
      });
      return jsonResponse({ error: "Rate limit exceeded" }, 429, rl.headers);
    }

    // 智能流量分类 — 多维度特征识别，区分合法 agent 流量与攻击流量
    const trafficClassifier = getTrafficClassifier();
    const trafficFeatures: TrafficFeatures = {
      method: req.method,
      path: url.pathname,
      userAgent: req.headers.get("user-agent") ?? "",
      contentType: req.headers.get("content-type") ?? "",
      payloadSize: parseInt(req.headers.get("content-length") ?? "0", 10),
      query: url.search,
      remoteAddress: remoteAddress ?? "unknown",
    };
    const trafficResult = trafficClassifier.classify(trafficFeatures);
    if (trafficResult.classification === "malicious") {
      auditLogger.log({
        event: "traffic.malicious",
        actor: remoteAddress ?? "unknown",
        outcome: "denied",
        reason: trafficResult.reasons.join(", "),
        resource: url.pathname,
        metadata: { score: trafficResult.score },
      });
      return jsonResponse(
        { error: "Request blocked by traffic classifier", reasons: trafficResult.reasons },
        403,
        baseHeaders
      );
    }
    if (trafficResult.classification === "suspicious") {
      auditLogger.log({
        event: "traffic.suspicious",
        actor: remoteAddress ?? "unknown",
        outcome: "allowed",
        reason: trafficResult.reasons.join(", "),
        resource: url.pathname,
        metadata: { score: trafficResult.score },
      });
    }

    // Request body size check
    if (req.method === "POST" || req.method === "PUT" || req.method === "PATCH") {
      const contentLength = parseInt(req.headers.get("content-length") || "0", 10);
      if (contentLength > MAX_BODY_SIZE) {
        return jsonResponse({ error: `Request body too large (max ${MAX_BODY_SIZE} bytes)` }, 413, baseHeaders);
      }
    }

    try {
      // /traffic/stats — 流量分类统计 dashboard 数据
      if (url.pathname === "/traffic/stats" && req.method === "GET") {
        return jsonResponse(getTrafficClassifier().stats(), 200, baseHeaders);
      }

      // Build route context
      const ctx: RouteContext = {
        url, req, vault, db, pipeline, healthMonitor, fileWatcher,
        startupTime, baseHeaders, jsonResponse,
      };

      // Try static files first (SPA shell assets)
      let response = await serveStaticFile(url.pathname, req);

      // 使用高性能路由引擎 (O(1) Trie + 请求缓存 + 性能分析)
      if (!response) {
        response = await httpRouter.execute(ctx);
      }

      // 回退到传统路由系统
      if (!response) {
        response = await dispatch(ctx);
      }

      // SPA 回退（2026-07-26 前端审查修复 H4）：
      // 非 API 的 GET 请求且无文件扩展名 → 返回 SPA 入口，
      // 修复刷新/深链 /chat、/providers 等返回 JSON 端点列表的问题
      // 复用模块级 SPA_INDEX_FILE（避免每请求 Bun.file 分配）
      if (!response && req.method === "GET" && !url.pathname.includes(".") && !url.pathname.startsWith("/api")) {
        if (await SPA_INDEX_FILE.exists()) {
          response = new Response(SPA_INDEX_FILE, {
            status: 200,
            headers: { ...securityHeaders, "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" },
          });
        }
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
      const error = toAxiomError(e, `Request failed: ${url.pathname}`);
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
registerShutdownHook({ name: "consciousness", handler: () => getConsciousness().stop(), priority: 75 });
registerShutdownHook({ name: "vault", handler: () => vault?.close(), priority: 70 });
registerShutdownHook({ name: "database", handler: () => db.close(), priority: 50 });
registerShutdownHook({ name: "http-server", handler: () => server.stop(), priority: 40 });
registerShutdownHook({ name: "heartbeat", handler: () => stopHeartbeat(), priority: 30 });
registerShutdownHook({ name: "plugins", handler: () => { logger.info("Plugins shutdown"); }, priority: 25 });
registerShutdownHook({ name: "native-bridge", handler: () => stopNativeBridge(), priority: 20 });
registerShutdownHook({ name: "mcp-clients", handler: async () => { const { closeExternalMcpClients } = await import("./mcp/client-connector.js"); await closeExternalMcpClients(); }, priority: 65 });
registerShutdownHook({ name: "pty-sessions", handler: async () => { const { closeAllSessions } = await import("./terminal/pty-session.js"); await closeAllSessions(); }, priority: 64 });

setupGracefulShutdown({ timeout: TIMEOUTS.GRACEFUL_SHUTDOWN, signals: ["SIGTERM", "SIGINT"] });

logger.info("Server started", { port, hostname: readString("HOST", "127.0.0.1"), url: `http://${readString("HOST", "127.0.0.1")}:${port}` });

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

logger.info(`╔══════════════════════════════════════════════════════════════════════╗
║     Axiom Runtime v4.0 — Vault 核心记忆引擎运行中              ║
║ 记忆: Obsidian Vault (确定性推理)                                   ║
║ 版本:  ${(edition === "cloud" ? "☁️ Cloud" : "🏠 Local").padEnd(58)} ║
║ 原生:  ${(isNativeReady() ? "🦀 Rust Core Active" : "📜 TypeScript Only").padEnd(58)} ║
║                                                                     ║
║ 本地访问:  ${localUrl.padEnd(58)} ║
║ 局域网:    ${lanUrl.padEnd(58)} ║
║ WebSocket: ws://${readString("HOST", "127.0.0.1")}:${port}/ws${"".padEnd(38)} ║
║ API Key:   ${API_KEY ? "已启用 (x-api-key 鉴权)" : "未设置 (所有请求将被拒绝)"}            ║
╚══════════════════════════════════════════════════════════════════════╝
`);
