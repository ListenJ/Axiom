/**
 * Route dispatcher — delegates to route handlers by priority
 */
import type { RouteContext, RouteHandler } from "./types.js";
import { handleMetrics, handleDashboard, handleHealth, handleStats, handleCacheStats, handleEngines, handleMemoryGateStats, handleTrends, handleConfig } from "./health.js";
import { handleChat, handleAgentChat } from "./chat.js";
import { handleVaultSearch, handleWebSearch, handleEnhancedSearch, handleSearchSuggestions, handleSearchStats, handleSearchHistory, handleRecentSearches, handleWebFetch } from "./search.js";
import { handleVaultStats, handleVaultPara, handleVaultTags, handleVaultNetwork, handleVaultNote, handleVaultWrite, handleVaultAtomic, handleVaultCodeIndex, handleVaultReload, handleVaultWatchStatus, handleVaultDistill, handleBootstrap, handleCodegraphSearch, handleCodegraphInit, handleCodegraphStatus } from "./vault.js";
import { handleAgentsStatus, handleOpenCodeModels, handleOpenCodeOpen, handleOpenCodeGenerate, handleOpenCodeRefactor, handleOpenCodeReview, handleOpenCodeTest, handleKimiStatus, handleKimiChat, handleKimiOpen, handleHermesTask } from "./agents.js";
import { handleApiKeys } from "./api-keys.js";
import { handleSceneRoutes } from "./scene-routes.js";
import { handleOCRRoutes } from "./ocr-routes.js";

/** All route handlers in priority order */
const handlers: RouteHandler[] = [
  // Metrics & dashboard (check first — fast, no vault dependency)
  handleMetrics,
  handleDashboard,
  // Health & system
  handleHealth,
  handleStats,
  handleCacheStats,
  handleEngines,
  handleMemoryGateStats,
  handleTrends,
  handleConfig,
  // Chat (most common API call)
  handleChat,
  handleAgentChat,
  // Search
  handleVaultSearch,
  handleWebSearch,
  handleEnhancedSearch,
  handleSearchSuggestions,
  handleSearchStats,
  handleSearchHistory,
  handleRecentSearches,
  handleWebFetch,
  // Vault & CodeGraph
  handleVaultStats,
  handleVaultPara,
  handleVaultTags,
  handleVaultNetwork,
  handleVaultNote,
  handleVaultWrite,
  handleVaultAtomic,
  handleVaultCodeIndex,
  handleVaultReload,
  handleVaultWatchStatus,
  handleVaultDistill,
  handleBootstrap,
  handleCodegraphSearch,
  handleCodegraphInit,
  handleCodegraphStatus,
  // Agents
  handleAgentsStatus,
  handleOpenCodeModels,
  handleOpenCodeOpen,
  handleOpenCodeGenerate,
  handleOpenCodeRefactor,
  handleOpenCodeReview,
  handleOpenCodeTest,
  handleKimiStatus,
  handleKimiChat,
  handleKimiOpen,
  handleHermesTask,
  // Runtime API key management (MiniMax etc.)
  handleApiKeys,
  // Scene Router (MCP 场景驱动工具调用)
  handleSceneRoutes,
  // OCR Document Processing
  handleOCRRoutes,
];

/**
 * Dispatch a request to the first matching handler.
 * Returns the handler's Response, or null if no handler matched.
 */
export async function dispatch(ctx: RouteContext): Promise<Response | null> {
  for (const handler of handlers) {
    const result = await handler(ctx);
    if (result) return result;
  }
  return null;
}

/** Default response when no route matches */
export function defaultResponse(ctx: RouteContext): Response {
  return ctx.jsonResponse({
    name: "OpenClaw AI Agent", version: "2.1.0",
    uptime: Math.floor((Date.now() - ctx.startupTime) / 1000),
    endpoints: [
      "GET  /                        — Dashboard",
      "GET  /health                  — 健康检查",
      "POST /chat                    — 模型聊天（自动意图识别）",
      "GET  /search?q=               — Vault 确定性记忆搜索",
      "GET  /memory-gate/stats        — 记忆门控统计",
      "GET  /stats/trends?days=7      — 趋势数据",
      "GET  /config                   — 系统配置（脱敏）",
      "POST /config                   — 更新配置",
      "GET  /web-search?q=           — 多引擎搜索",
      "GET  /enhanced-search?q=      — 增强搜索",
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
      "WS   /ws                      — 实时推送",
      "--- 编码 Agent ---",
      "POST /agents/opencode/generate  — 代码生成",
      "POST /agents/opencode/refactor  — 代码重构",
      "POST /agents/opencode/review    — 代码审查",
      "POST /agents/opencode/test      — 测试生成",
      "--- Provider API Keys (运行时配置) ---",
      "GET    /api-keys                — 列出所有 provider 状态（脱敏）",
      "GET    /api-keys/:provider      — 单个 provider 状态",
      "POST   /api-keys                — 设置 runtime override { provider, apiKey, baseURL? }",
      "DELETE /api-keys/:provider      — 清除 runtime override",
    ],
  }, 200, ctx.baseHeaders);
}
