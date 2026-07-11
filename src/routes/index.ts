/**
 * Route dispatcher — delegates to route handlers by priority
 */
import type { RouteContext, RouteHandler } from "./types.js";
import { handleMetrics, handleDashboard, handleHealth, handleStats as handleHealthStats, handleCacheStats, handleEngines, handleMemoryGateStats, handleTrends, handleConfig } from "./health.js";
import { handleStats } from "./stats.js";
import { handleChat, handleAgentChat, handleChatStream } from "./chat.js";
import { handleVaultSearch, handleWebSearch, handleEnhancedSearch, handleSearchSuggestions, handleSearchStats, handleSearchHistory, handleRecentSearches, handleWebFetch, handleLightpandaStatus, handleDirectSearch, handleQueryDecompose } from "./search.js";
import { handleVaultStats, handleVaultPara, handleVaultTags, handleVaultNetwork, handleVaultNote, handleVaultWrite, handleVaultAtomic, handleVaultCodeIndex, handleVaultReload, handleVaultWatchStatus, handleVaultDistill, handleBootstrap, handleCodegraphSearch, handleCodegraphInit, handleCodegraphStatus } from "./vault.js";
import { handleAgentsStatus, handleOpenCodeModels, handleOpenCodeOpen, handleOpenCodeGenerate, handleOpenCodeRefactor, handleOpenCodeReview, handleOpenCodeTest, handleKimiStatus, handleKimiChat, handleKimiOpen, handleHermesTask, handleComputerUse } from "./agents.js";
import { handleApiKeys } from "./api-keys.js";
import { handleSceneRoutes } from "./scene-routes.js";
import { handleOCRRoutes } from "./ocr-routes.js";
import { handleConsciousness } from "./consciousness.js";
import {
  handleEvalStats,
  handleEvalResults,
  handleEvalModel,
  handleEvalTrend,
  handleEvalModels,
  handleEvalRun,
  handleEvalAssign,
  handleEvalAssignments,
  handleEvalAssignReport,
} from "./eval-routes.js";
import { handleProxies } from "./proxies.js";
import { handleNativeSearch, handleNativeRouterPerf, handleNativeStats, handleNativeProxy } from "./native-routes.js";
import { handlePluginRoutes } from "./plugin-adapter.js";
import {
  handleKGStats,
  handleKGEntities,
  handleKGEntityDetail,
  handleKGTraverse,
  handleKGBuild,
  handleKGSearch,
  handleKGGraph,
  handleAdvisorRecommend,
  handleAdvisorFreeModels,
  handleAdvisorEvolve,
  handleAdvisorStatus,
  handleResearchRun,
} from "./knowledge-graph.js";
import {
  handleSaveConversation,
  handleGetConversations,
  handleListSessions,
  handleKnowledgeSearch,
  handleKnowledgePendingReview,
  handleKnowledgeReviewAction,
  handleListTasks,
  handleModelUsage,
} from "./memory-api.js";

/** All route handlers in priority order */
const handlers: RouteHandler[] = [
  // Metrics & dashboard (check first — fast, no vault dependency)
  handleMetrics,
  handleDashboard,
  // Health & system
  handleHealth,
  handleHealthStats,
  handleCacheStats,
  handleEngines,
  handleProxies,
  handleMemoryGateStats,
  handleTrends,
  handleConfig,
  // Chat (most common API call)
  handleChat,
  handleChatStream,
  handleAgentChat,
  // Native Bridge (Rust core)
  handleNativeSearch,
  handleNativeRouterPerf,
  handleNativeStats,
  handleNativeProxy,

  // Search
  handleVaultSearch,
  handleWebSearch,
  handleEnhancedSearch,
  handleSearchSuggestions,
  handleSearchStats,
  handleSearchHistory,
  handleRecentSearches,
  handleWebFetch,
  // Lightpanda browser integration
  handleLightpandaStatus,
  handleDirectSearch,
  // Query decomposition (MeMo-style multi-stage retrieval)
  handleQueryDecompose,
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
  handleComputerUse,
  handleKimiStatus,
  handleKimiChat,
  handleKimiOpen,
  handleHermesTask,
  // Runtime API key management (MiniMax etc.)
  handleApiKeys,
  // Plugin Market (插件市场)
  handlePluginRoutes,
  // Scene Router (MCP 场景驱动工具调用)
  handleSceneRoutes,
  // OCR Document Processing
  handleOCRRoutes,
  // Model Evaluation & Dynamic Assignment (模型评估与动态分配)
  handleEvalStats,
  handleEvalResults,
  handleEvalModel,
  handleEvalTrend,
  handleEvalModels,
  handleEvalRun,
  handleEvalAssign,
  handleEvalAssignments,
  handleEvalAssignReport,
  // Memory API (跨会话记忆)
  handleSaveConversation,
  handleGetConversations,
  handleListSessions,
  handleKnowledgeSearch,
  handleKnowledgePendingReview,
  handleKnowledgeReviewAction,
  handleListTasks,
  handleModelUsage,
  // Knowledge Graph & Model Advisor (知识图谱 + 模型顾问)
  handleKGStats,
  handleKGEntities,
  handleKGEntityDetail,
  handleKGTraverse,
  handleKGBuild,
  handleKGSearch,
  handleKGGraph,
  handleAdvisorRecommend,
  handleAdvisorFreeModels,
  handleAdvisorEvolve,
  handleAdvisorStatus,
  // Research (KG 增强的深度研究)
  handleResearchRun,
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

// ═══════════════════════════════════════════════════════════════
// Trie 路由注册 — 将简单路由注册到高性能路由引擎
// ═══════════════════════════════════════════════════════════════

import { HttpRouter, type RouteRecord } from "../core/http-router.js";

export function registerTrieRoutes(engine: HttpRouter): void {
  const routes: RouteRecord[] = [
    // Health & system
    { method: "GET", path: "/health", handler: handleHealth },
    { method: "GET", path: "/metrics", handler: handleMetrics },
    { method: "GET", path: "/", handler: handleDashboard },
    { method: "GET", path: "/index.html", handler: handleDashboard },
    { method: "GET", path: "/stats", handler: handleHealthStats },
    { method: "GET", path: "/api/stats", handler: handleStats },
    { method: "GET", path: "/cache/stats", handler: handleCacheStats },
    { method: "GET", path: "/engines", handler: handleEngines },
    { method: "GET", path: "/memory-gate/stats", handler: handleMemoryGateStats },
    { method: "GET", path: "/stats/trends", handler: handleTrends },
    { method: "GET", path: "/config", handler: handleConfig },
    { method: "POST", path: "/config", handler: handleConfig },
    { method: "GET", path: "/consciousness/status", handler: handleConsciousness },
    { method: "POST", path: "/consciousness/reflect", handler: handleConsciousness },
    { method: "GET", path: "/proxies", handler: handleProxies },

    // Chat
    { method: "POST", path: "/chat", handler: handleChat },
    { method: "POST", path: "/chat/stream", handler: handleChatStream },
    { method: "POST", path: "/agent-chat", handler: handleAgentChat },

    // Search
    { method: "GET", path: "/search", handler: handleVaultSearch },
    { method: "GET", path: "/web-search", handler: handleWebSearch },
    { method: "GET", path: "/enhanced-search", handler: handleEnhancedSearch },
    { method: "GET", path: "/search/suggestions", handler: handleSearchSuggestions },
    { method: "GET", path: "/search/stats", handler: handleSearchStats },
    { method: "GET", path: "/search/history", handler: handleSearchHistory },
    { method: "GET", path: "/searches/recent", handler: handleRecentSearches },
    { method: "GET", path: "/web-fetch", handler: handleWebFetch },
    { method: "GET", path: "/lightpanda/status", handler: handleLightpandaStatus },
    { method: "GET", path: "/direct-search", handler: handleDirectSearch },
    { method: "POST", path: "/search/decompose", handler: handleQueryDecompose },

    // Vault
    { method: "GET", path: "/vault/stats", handler: handleVaultStats },
    { method: "GET", path: "/vault/para/:category", handler: handleVaultPara },
    { method: "GET", path: "/vault/tags/:tag", handler: handleVaultTags },
    { method: "GET", path: "/vault/network/:path", handler: handleVaultNetwork },
    { method: "GET", path: "/vault/note", handler: handleVaultNote },
    { method: "POST", path: "/vault/write", handler: handleVaultWrite },
    { method: "POST", path: "/vault/atomic", handler: handleVaultAtomic },
    { method: "POST", path: "/vault/code-index", handler: handleVaultCodeIndex },
    { method: "POST", path: "/vault/reload", handler: handleVaultReload },
    { method: "GET", path: "/vault/watch-status", handler: handleVaultWatchStatus },
    { method: "POST", path: "/vault/distill", handler: handleVaultDistill },
    { method: "GET", path: "/bootstrap", handler: handleBootstrap },
    { method: "GET", path: "/codegraph/search", handler: handleCodegraphSearch },
    { method: "POST", path: "/codegraph/init", handler: handleCodegraphInit },
    { method: "GET", path: "/codegraph/status", handler: handleCodegraphStatus },

    // Agents
    { method: "GET", path: "/agents/status", handler: handleAgentsStatus },
    { method: "GET", path: "/agents/opencode/models", handler: handleOpenCodeModels },
    { method: "POST", path: "/agents/opencode/open", handler: handleOpenCodeOpen },
    { method: "GET", path: "/agents/kimi/status", handler: handleKimiStatus },
    { method: "POST", path: "/agents/kimi/chat", handler: handleKimiChat },
    { method: "POST", path: "/agents/kimi/open", handler: handleKimiOpen },
    { method: "POST", path: "/agents/hermes/task", handler: handleHermesTask },
    { method: "POST", path: "/agents/opencode/generate", handler: handleOpenCodeGenerate },
    { method: "POST", path: "/agents/opencode/refactor", handler: handleOpenCodeRefactor },
    { method: "POST", path: "/agents/opencode/review", handler: handleOpenCodeReview },
    { method: "POST", path: "/agents/opencode/test", handler: handleOpenCodeTest },
    { method: "POST", path: "/agents/computer-use", handler: handleComputerUse },
    { method: "GET", path: "/agents/computer-use/models", handler: handleComputerUse },
    { method: "POST", path: "/agents/computer-use/screenshot", handler: handleComputerUse },
    { method: "POST", path: "/agents/computer-use/elements", handler: handleComputerUse },
    { method: "POST", path: "/agents/computer-use/execute", handler: handleComputerUse },
    { method: "POST", path: "/agents/computer-use/task", handler: handleComputerUse },

    // Eval
    { method: "GET", path: "/eval/stats", handler: handleEvalStats },
    { method: "GET", path: "/eval/results", handler: handleEvalResults },
    { method: "GET", path: "/eval/model/:id", handler: handleEvalModel },
    { method: "GET", path: "/eval/trend/:id", handler: handleEvalTrend },
    { method: "GET", path: "/eval/models", handler: handleEvalModels },
    { method: "POST", path: "/eval/run", handler: handleEvalRun },
    { method: "POST", path: "/eval/assign", handler: handleEvalAssign },
    { method: "GET", path: "/eval/assignments", handler: handleEvalAssignments },
    { method: "GET", path: "/eval/assign/report", handler: handleEvalAssignReport },

    // Knowledge Graph
    { method: "GET", path: "/kg/stats", handler: handleKGStats },
    { method: "GET", path: "/kg/entities", handler: handleKGEntities },
    { method: "GET", path: "/kg/entity/:name", handler: handleKGEntityDetail },
    { method: "GET", path: "/kg/traverse/:name", handler: handleKGTraverse },
    { method: "POST", path: "/kg/build", handler: handleKGBuild },
    { method: "POST", path: "/kg/search", handler: handleKGSearch },
    { method: "GET", path: "/kg/graph", handler: handleKGGraph },
    { method: "GET", path: "/advisor/recommend", handler: handleAdvisorRecommend },
    { method: "GET", path: "/advisor/free-models", handler: handleAdvisorFreeModels },
    { method: "POST", path: "/advisor/evolve", handler: handleAdvisorEvolve },
    { method: "GET", path: "/advisor/status", handler: handleAdvisorStatus },
    { method: "POST", path: "/research/run", handler: handleResearchRun },

    // Memory API
    { method: "POST", path: "/memory/conversations", handler: handleSaveConversation },
    { method: "GET", path: "/memory/conversations", handler: handleGetConversations },
    { method: "GET", path: "/memory/sessions", handler: handleListSessions },
    { method: "GET", path: "/memory/knowledge", handler: handleKnowledgeSearch },
    { method: "GET", path: "/knowledge/pending-review", handler: handleKnowledgePendingReview },
    { method: "POST", path: "/knowledge/pending-review/action", handler: handleKnowledgeReviewAction },
    { method: "GET", path: "/memory/tasks", handler: handleListTasks },
    { method: "GET", path: "/memory/usage", handler: handleModelUsage },

    // API Keys (通配 fallback — 内部做多路径匹配)
    { method: "GET", path: "/api-keys", handler: handleApiKeys },
    { method: "POST", path: "/api-keys", handler: handleApiKeys },
    { method: "GET", path: "/api-keys/**", handler: handleApiKeys },
    { method: "DELETE", path: "/api-keys/**", handler: handleApiKeys },

    // Plugins (通配 fallback — 内部做多路径匹配)
    { method: "GET", path: "/plugins", handler: handlePluginRoutes },
    { method: "GET", path: "/plugins/available", handler: handlePluginRoutes },
    { method: "GET", path: "/plugins/active-tools", handler: handlePluginRoutes },
    { method: "POST", path: "/plugins/install", handler: handlePluginRoutes },
    { method: "GET", path: "/plugins/**", handler: handlePluginRoutes },
    { method: "POST", path: "/plugins/**", handler: handlePluginRoutes },

    // MCP Scene Router
    { method: "GET", path: "/mcp/scenes", handler: handleSceneRoutes },
    { method: "POST", path: "/mcp/scene", handler: handleSceneRoutes },
    { method: "GET", path: "/mcp/scenes/:id", handler: handleSceneRoutes },
    { method: "GET", path: "/mcp/**", handler: handleSceneRoutes },
    { method: "POST", path: "/mcp/**", handler: handleSceneRoutes },

    // OCR
    { method: "GET", path: "/ocr/status", handler: handleOCRRoutes },
    { method: "POST", path: "/ocr/scan", handler: handleOCRRoutes },
    { method: "POST", path: "/ocr/export", handler: handleOCRRoutes },
    { method: "GET", path: "/ocr/**", handler: handleOCRRoutes },
    { method: "POST", path: "/ocr/**", handler: handleOCRRoutes },

    // Native Bridge (Rust core)
    { method: "POST", path: "/native/search", handler: handleNativeSearch },
    { method: "GET", path: "/native/router/perf", handler: handleNativeRouterPerf },
    { method: "GET", path: "/native/stats", handler: handleNativeStats },
    { method: "GET", path: "/native/**", handler: handleNativeProxy },
    { method: "POST", path: "/native/**", handler: handleNativeProxy },
  ];

  engine.registerBatch(routes);
}

/** Default response when no route matches */
export function defaultResponse(ctx: RouteContext): Response {
  return ctx.jsonResponse({
    name: "Axiom Runtime", version: "4.0.0",
    uptime: Math.floor((Date.now() - ctx.startupTime) / 1000),
    endpoints: [
      "GET  /                        — Dashboard",
      "GET  /health                  — 健康检查",
      "POST /chat                    — 模型聊天（自动意图识别）",
      "POST /chat/stream             — SSE 流式聊天（text/event-stream）",
      "GET  /search?q=               — Vault 确定性记忆搜索",
      "GET  /memory-gate/stats        — 记忆门控统计",
      "GET  /stats/trends?days=7      — 趋势数据",
      "GET  /config                   — 系统配置（脱敏）",
      "POST /config                   — 更新配置",
      "GET  /consciousness/status      — 意识模块状态",
      "POST /consciousness/reflect     — 手动触发反思",
      "GET  /web-search?q=           — 多引擎搜索",
      "GET  /enhanced-search?q=      — 增强搜索",
      "GET  /web-fetch?url=          — 结构化抓取",
      "GET  /lightpanda/status       — Lightpanda 浏览器状态",
      "GET  /direct-search?q=        — 直连搜索 (无需 API Key)",
      "POST /search/decompose        — 查询分解 (MeMo 式多阶段检索)",
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
      "--- Plugin Market (插件市场) ---",
      "GET    /plugins                   — 列出已安装插件",
      "GET    /plugins/available         — 列出可用插件",
      "GET    /plugins/:id               — 获取插件详情",
      "POST   /plugins/install           — 安装插件",
      "POST   /plugins/:id/uninstall     — 卸载插件",
      "POST   /plugins/:id/enable        — 启用插件",
      "POST   /plugins/:id/disable       — 禁用插件",
      "POST   /plugins/:id/config        — 配置插件",
      "GET    /plugins/active-tools      — 获取活跃工具",
      "--- Model Evaluation (模型评估) ---",
      "GET    /eval/stats                — 评估统计摘要",
      "GET    /eval/results              — 查询评估结果",
      "GET    /eval/model/:id            — 模型评估详情",
      "GET    /eval/trend/:id            — 模型评估趋势",
      "GET    /eval/models               — OpenRouter 模型列表",
      "POST   /eval/run                  — 触发模型评估",
      "POST   /eval/assign               — 触发动态分配",
      "GET    /eval/assignments          — 查看动态分配",
      "GET    /eval/assign/report        — 分配报告",
      "--- Memory API (跨会话记忆) ---",
      "POST   /memory/conversations      — 保存对话消息",
      "GET    /memory/conversations       — 获取对话历史",
      "GET    /memory/sessions            — 列出所有会话",
      "GET    /memory/knowledge           — 跨表知识搜索",
      "GET    /memory/tasks               — 列出任务",
      "GET    /memory/usage               — 模型用量统计",
      "GET    /knowledge/pending-review    — 待审核知识库笔记",
      "POST   /knowledge/pending-review/action — 审核操作 (approve/reject)",
      "--- Knowledge Graph (知识图谱) ---",
      "GET    /kg/stats                  — 知识图谱统计",
      "GET    /kg/entities               — 列出实体",
      "GET    /kg/entity/:name           — 实体详情",
      "GET    /kg/traverse/:name         — 图谱遍历",
      "POST   /kg/build                  — 构建知识图谱",
      "POST   /kg/search                 — 知识图谱搜索",
      "--- Model Advisor (模型顾问) ---",
      "GET    /advisor/recommend         — 模型推荐",
      "GET    /advisor/free-models       — 发现免费模型",
      "POST   /advisor/evolve            — 触发进化周期",
      "GET    /advisor/status            — 顾问状态",
      "--- Research (深度研究) ---",
      "POST   /research/run              — KG增强深度研究",
    ],
  }, 200, ctx.baseHeaders);
}
