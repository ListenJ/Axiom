/**
 * Chat and agent-chat routes
 */
import type { RouteContext } from "./types.js";
import { logger } from "../utils/logger.js";
import { router, type ChatMessage, type ChatStreamEvent } from "../router/model-router.js";
import { INTENT_ROUTE_TABLE, DEFAULT_ROLE } from "../router/route-table.js";
import { wsManager } from "../utils/websocket.js";
import { prepareChatContext, executeChat } from "../services/index.js";
import { defaultPreflightDeps } from "../services/chat-preflight.js";
import { getEdgeClient, isEdgeEnabled } from "../local-llm/edge-client.js";
import { startSelfThought, attachSelfThought, getDefaultSelfEvolve } from "../self-evolve/index.js";
import { buildSkillToolSurfaces, runSkillTool } from "../mcp/server/skill-tools.js";
import { toOpenAITools } from "../utils/tool-surface.js";
import { z } from "zod";
import type { ToolDef } from "../mcp/tool-registry.js";
import type { DataPipeline } from "../crawl/data-pipeline.js";
import type { Database } from "bun:sqlite";
import type { VaultManager } from "../memory/vault-manager.js";
import type { SignificanceContext } from "../memory/memory-gate.js";
import { normalizeSessionId, persistChatMessage, getSessionMessages } from "../db/session-store.js";
import { assessStatement } from "../memory/hallucination-detector.js";
import { recordHallucinationVerdict } from "../db/hallucination-verdicts.js";

/**
 * M11（2026-08-28 审计）：/chat 请求体校验。
 * 必填最小集：messages 数组，元素须含 string role/content（与 /chat/stream 的
 * isValidChatMessage 校验对齐；passthrough 保留 name/多模态等扩展字段，不改变
 * 合法请求行为）。可选字段按 handleChat 实际解构清单逐一声明，未知字段剥离。
 * 注意：仍非完备——工具调用/提示注入等内容级风险由下游 HardFloor 与风险复核兜底。
 */
const chatMessageSchema = z.object({ role: z.string(), content: z.string() }).passthrough();

export const chatRequestSchema = z.object({
  messages: z.array(chatMessageSchema),
  taskType: z.string().optional(),
  intent: z.boolean().optional(),
  budget: z.union([z.number(), z.object({ maxTokens: z.number(), preserveRecent: z.number().optional() }).passthrough()]).optional(),
  sessionId: z.string().optional(),
});

export async function handleChat(ctx: RouteContext): Promise<Response | null> {
  if (ctx.url.pathname !== "/chat" || ctx.req.method !== "POST") return null;

  const chatStartedAt = Date.now();
  let rawBody: unknown;
  try {
    rawBody = await ctx.req.json();
  } catch {
    return ctx.jsonResponse({ error: "Invalid JSON body" }, 400, ctx.baseHeaders);
  }
  const parsed = chatRequestSchema.safeParse(rawBody);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const detail = issue ? `${issue.path.join(".") || "(root)"}: ${issue.message}` : "validation failed";
    return ctx.jsonResponse({ error: `Invalid request body — ${detail}` }, 400, ctx.baseHeaders);
  }
  const body = parsed.data;
  const { taskType, messages, intent: enableIntent = true, budget, sessionId } = body;
  // P0-B：仅显式提供 sessionId 的请求参与会话召回（bootstrap 注入）
  const recallSessionId = typeof sessionId === "string" && sessionId.trim() ? sessionId.trim() : undefined;

  // P0-A（2026-08-29）：selfThink 只依赖原始输入，与 prepareChatContext
  // （optimize→intent 链）无数据依赖 → 提前并发发起，主模型前总延迟从
  // T(prepare)+T(selfThink) 降为 max(两者)；失败/空输入静默跳过（语义不变）。
  const rawUserInput = String(Array.isArray(messages) ? [...messages].reverse().find((m: { role?: string }) => m?.role === "user")?.content ?? "" : "");
  const selfThoughtPromise = startSelfThought(rawUserInput, getDefaultSelfEvolve());
  const { chatMessages: preparedMessages, intentInfo, codegraphContext, evidence, tokenBudgetReport } = await prepareChatContext(
    messages,
    enableIntent,
    ctx.vault,
    {
      budget,
      sessionId: recallSessionId,
      // P0-A 组合根注入：生产边缘客户端（services 层不 import local-llm，架构扇出约束）
      preflightDeps: {
        ...defaultPreflightDeps(),
        edge: { enabled: () => isEdgeEnabled("EDGE_PROMPT_OPTIMIZER"), client: getEdgeClient() },
      },
    },
  );
  const chatMessages = await attachSelfThought(preparedMessages, selfThoughtPromise);
  const roleForTools = intentInfo
    ? (INTENT_ROUTE_TABLE[intentInfo.intent]?.role ?? DEFAULT_ROLE)
    : (typeof taskType === "string" && VALID_TASK_TYPES.has(taskType) ? taskType : DEFAULT_ROLE);
  const { tools, executeTool } = buildChatToolConfig(ctx.pipeline);
  const result = await executeChat(chatMessages, intentInfo, taskType, {
    role: roleForTools,
    tools,
    executeTool,
  });

  // P0-C（2026-08-29）：幻觉防线接火 —— 响应正文过请求级 factBase 校验（缝①）。
  // 请求级隔离：assessStatement 每次用传入 evidence 建独立 detector，不碰 main.ts
  // 全局单例；无证据/空响应返回 null（可观测优先，不阻断响应，不改返回结构）。
  const _hallucination = assessStatement(evidence, result.content ?? "");

  // S5（2026-08-29）：verdict 落库（routes→db 直调，方向与 session-store 既有依赖一致；
  // recordHallucinationVerdict 内部吞错，不阻塞响应；_hallucination 为 null = 无证据未判定）
  if (_hallucination) {
    recordHallucinationVerdict(ctx.db, {
      statement: result.content ?? "",
      evidenceTexts: evidence.map((f) => f.text),
      pValue: _hallucination.pValue,
      verdict: _hallucination.verdict,
      isAccepted: _hallucination.isAccepted,
      seam: "chat",
    });
  }

  const normalizedSessionId = normalizeSessionId(sessionId);
  const messageList = Array.isArray(messages) ? messages as Array<{ role: string; content: string }> : [];
  const lastUser = [...messageList].reverse().find((m) => m.role === "user");
  if (lastUser) {
    persistChatMessage(ctx.db, { sessionId: normalizedSessionId, role: "user", content: lastUser.content });
  }
  if (result.content) {
    persistChatMessage(ctx.db, {
      sessionId: normalizedSessionId,
      role: "assistant",
      content: result.content,
      tokensUsed: result.usage?.total_tokens ?? 0,
    });
  }
  // P0-B：会话自动归档（非阻塞 fire-and-forget；MemoryGate 约束；失败静默）
  if (result.content && result.content.trim().length > 0) {
    void archiveExchangeToVault(ctx.vault, ctx.db, normalizedSessionId, {
      userContent: lastUser?.content ?? "",
      assistantContent: result.content,
      gateTaskType: mapIntentToGateTaskType(intentInfo?.intent ?? taskType),
    });
  }

  const response = ctx.jsonResponse({
    ...result,
    sessionId: normalizedSessionId,
    codegraphContext: codegraphContext ? { length: codegraphContext.length } : null,
    tokenBudget: tokenBudgetReport ?? null,
    // P0-C：响应元数据（null = 本次无检索证据，校验未运行）
    _hallucination,
    intent: intentInfo
      ? {
          name: intentInfo.agentName,
          category: intentInfo.intent,
          confidence: intentInfo.confidence,
        }
      : null,
  }, 200, ctx.baseHeaders);

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

  // Real Usage 采集（非阻塞，深模块：仅追加一行 JSONL，不影响主流程延迟）
  try {
    const lastPrompt = String(lastUser?.content ?? messages[messages.length - 1]?.content ?? "").slice(0, 4000);
    // 成功判定用精确字段：ChatResponse.content 非空即成功（路由失败路径要么抛错、要么
    // content 为 null）。不做 includes("error") 子串嗅探——合法回答里含 "error" 一词会被误判。
    const success = Boolean(result.content && result.content.trim().length > 0);
    const latencyMs = Date.now() - chatStartedAt;
    const { captureRealUsageTrace } = await import("../agent-evals/real-usage.js");
    void captureRealUsageTrace({
      id: `chat-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      task: lastPrompt || "chat",
      success,
      model: String(result.model ?? result.provider ?? ""),
      latencyMs,
      source: "chat",
      feedback: success ? "auto-success" : "auto-fail",
    }).catch((err) => logger.warn("[chat] usage-trace capture failed", { error: err instanceof Error ? err.message : String(err) }));
    // 自动 evolve 学习侧触发（fire-and-forget，默认 OFF；失败不阻断响应）
    const { maybeAutoEvolve } = await import("../agent-evals/auto-evolve.js");
    void maybeAutoEvolve().catch((err) => logger.warn("[chat] auto-evolve check failed", { error: err instanceof Error ? err.message : String(err) }));
    // 同步指标到 ResourceBudget 便于后续调度感知真实延迟
    try {
      const { getResourceBudgetManager } = await import("../dre/system-resource.js");
      // 不直接改 availableMemory，仅记录 latency 供未来自适应（预留）
      logger.debug("[RealUsage] chat latency", { latencyMs, model: result.model, intent: intentInfo?.intent });
    } catch {}
  } catch {}

  return response;
}

export async function handleAgentChat(ctx: RouteContext): Promise<Response | null> {
  if (ctx.url.pathname !== "/agent-chat" || ctx.req.method !== "POST") return null;

  const agentChatStartedAt = Date.now();
  const body = await ctx.req.json();
  const { message, history = [], taskType, budget } = body;
  const messages: Array<{ role: string; content: string }> = [
    ...(history as Array<{ role: string; content: string }>),
    { role: "user", content: message },
  ];

  // P0-A（2026-08-29）：selfThink 提前并发发起（与 prepareChatContext 并行），见 handleChat 注释。
  const selfThoughtPromise = startSelfThought(String(message ?? ""), getDefaultSelfEvolve());
  const { chatMessages: preparedMessages, intentInfo, tokenBudgetReport } = await prepareChatContext(
    messages,
    true,
    ctx.vault,
    { budget },
  );
  const chatMessages = await attachSelfThought(preparedMessages, selfThoughtPromise);
  const roleForTools = intentInfo
    ? (INTENT_ROUTE_TABLE[intentInfo.intent]?.role ?? DEFAULT_ROLE)
    : (typeof taskType === "string" && VALID_TASK_TYPES.has(taskType) ? taskType : DEFAULT_ROLE);
  const { tools, executeTool } = buildChatToolConfig(ctx.pipeline);
  const result = await executeChat(chatMessages, intentInfo, taskType, {
    role: roleForTools,
    tools,
    executeTool,
  });

  const response = ctx.jsonResponse({
    ...result,
    tokenBudget: tokenBudgetReport ?? null,
    intent: intentInfo
      ? {
          name: intentInfo.agentName,
          category: intentInfo.intent,
          confidence: intentInfo.confidence,
        }
      : null,
  }, 200, ctx.baseHeaders);

  wsManager.broadcast({
    type: "agent.intent",
    payload: { intent: intentInfo?.agentName || "general", confidence: intentInfo?.confidence || 0, layer: result.layer },
    timestamp: new Date().toISOString(),
  });

  // Real Usage 采集（agent-chat）
  try {
    const success = Boolean(result.content && result.content.trim().length > 0);
    const { captureRealUsageTrace } = await import("../agent-evals/real-usage.js");
    void captureRealUsageTrace({
      id: `agent-chat-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      task: String(message ?? "").slice(0, 4000),
      success,
      model: String(result.model ?? result.provider ?? ""),
      latencyMs: Date.now() - agentChatStartedAt,
      source: "agent-chat",
      feedback: success ? "auto-success" : "auto-fail",
    }).catch((err) => logger.warn("[chat] usage-trace capture failed", { error: err instanceof Error ? err.message : String(err) }));
    // 自动 evolve 学习侧触发（fire-and-forget，默认 OFF；失败不阻断响应）
    const { maybeAutoEvolve } = await import("../agent-evals/auto-evolve.js");
    void maybeAutoEvolve().catch((err) => logger.warn("[chat] auto-evolve check failed", { error: err instanceof Error ? err.message : String(err) }));
  } catch {}

  return response;
}

/**
 * SSE 辅助：构造 text/event-stream 响应头。
 */
function sseHeaders(baseHeaders: Record<string, string>): Record<string, string> {
  return {
    ...baseHeaders,
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no", // disable nginx buffering when behind a proxy
  };
}

/**
 * SSE 辅助：把任意 JSON-safe payload 编码为一条 SSE `data:` 行。
 * SSE 规范：data 行必须以 `\n` 分隔每条消息（即 `\n\n` 结束一条消息）。
 */
function sseData(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

/**
 * SSE 辅助：发送一条同时包含 `event:` 和 `data:` 的标准 SSE 事件。
 * `data:` 行仍是合法 JSON，所以只读 data: 的前端（包括老的 EventSource 包装器）
 * 也能解析；只读 event: 的前端可拿到事件类型。
 *   event: token
 *   data: {"type":"token","content":"hello"}
 *
 * （空行结束一条消息，符合 SSE 规范）
 */
function sseEvent(eventType: string, payload: unknown): string {
  return `event: ${eventType}\ndata: ${JSON.stringify(payload)}\n\n`;
}

/**
 * SSE 辅助：发送一条注释行（以 `:` 开头）。客户端会忽略，但能作为 keep-alive 心跳。
 */
function sseComment(text: string): string {
  return `: ${text}\n\n`;
}

/**
 * Valid taskType values for chat routing. Mirrors `TaskRole` from
 * `src/router/models.ts`; used to sanitize user input and fall back to
 * 'general-chat' when an unknown taskType is supplied.
 */
const VALID_TASK_TYPES: ReadonlySet<string> = new Set([
  "decision",
  "architecture",
  "evaluation",
  "general-chat",
  "code-generation",
  "code-review",
  "embedding",
  "english",
  "rl",
  "general-tool",
  "coding",
  "research",
  "memory",
  "deep_research",
  "math",
  "review",
  "main_coding",
  "computer-use",
]);

// ── P0-B（2026-08-29）会话自动归档 ──────────────────────────────────
// 审计断链修复：主 HTTP 聊天此前零归档 → curator 断供。非空响应后经既有
// writeConversationLog 落盘 04-Conversations；受 MemoryGate 既有去重+限流
// 约束（经 gateContext → writeNote 既有机制，20/h、100/day）；vault 不可用
// 或写入失败时静默跳过，绝不影响响应（调用方 fire-and-forget）。

/** 意图 → MemoryGate 任务类型（高价值任务加权，闲聊按既有低价值语义处理） */
function mapIntentToGateTaskType(intent: string | undefined): SignificanceContext["taskType"] {
  switch (intent) {
    case "code": return "coding";
    case "research": return "research";
    case "write": return "writing";
    case "plan": return "planning";
    default: return "chat";
  }
}

/** 从本次交换构建显著性上下文（与 hermes/pi-code 既有 gateContext 构造同型） */
function buildConversationGateContext(
  userContent: string,
  assistantContent: string,
  taskType: SignificanceContext["taskType"],
  isFirstTurn: boolean,
): SignificanceContext {
  return {
    agentRole: "chat",
    taskType,
    responseLength: assistantContent.length,
    hasCode: assistantContent.includes("```"),
    hasCitations: assistantContent.includes("http"),
    hasErrors: false,
    userMessageLength: userContent.length,
    isFirstTurn,
    hasStructuredData: assistantContent.includes("## "),
    hasTechnicalTerms: /\b(API|SDK|function|class|database|server|model|framework|数据库|接口|函数|服务器)\b/i.test(assistantContent),
  };
}

/**
 * 将当前会话（db 全量历史）经 writeConversationLog 归档到 Vault。
 * 语义与既有手动归档端点（POST /chat/sessions/:id/archive）一致：全量读取重建，
 * 幂等覆盖；区别在于写入决策受 MemoryGate 显著性+限流约束。
 * 任何失败只 debug，不向调用方抛出。
 */
export async function archiveExchangeToVault(
  vault: VaultManager | null,
  db: Database,
  sessionId: string,
  exchange: { userContent: string; assistantContent: string; gateTaskType: SignificanceContext["taskType"] },
): Promise<void> {
  if (!vault || !exchange.assistantContent || !exchange.assistantContent.trim()) return;
  try {
    const rows = getSessionMessages(db, sessionId, 1000, 0);
    if (rows.length === 0) return;
    const userRowCount = rows.filter((r) => r.role === "user").length;
    await vault.writeConversationLog(
      sessionId,
      rows.map((r) => ({
        role: r.role,
        content: r.content,
        timestamp: new Date(r.created_at * 1000).toISOString(),
      })),
      buildConversationGateContext(
        exchange.userContent,
        exchange.assistantContent,
        exchange.gateTaskType,
        userRowCount <= 1,
      ),
    );
  } catch (err) {
    logger.debug("[chat] conversation auto-archive skipped", {
      sessionId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

import { sanitizeSearchResultsForContext } from "../crawl/search-engines.js";

/** 原生 function-calling 暴露给内部模型的 skill 工具（按需调用） */
/** 联网工具面：web_fetch / web_search / search_engines_list（复用 DataPipeline，结果自动写入 Vault） */
export function buildWebToolSurfaces(pipeline: DataPipeline): ToolDef[] {
  return [
    {
      name: "web_fetch",
      description: "抓取网页并提取结构化数据（自动写入 Vault 记忆库）",
      inputSchema: { url: z.string().url().describe("目标 URL") },
      handler: async (args) => {
        const result = await pipeline.crawlStructured(args.url as string);
        if (!result) return { error: "Failed to fetch URL" };
        return {
          url: result.url, title: result.title, description: result.description,
          content: (result.markdown ?? "").slice(0, 8000), // 供模型阅读页面正文
          headings: result.headings.length, tables: result.tables.length,
          codeBlocks: result.codeBlocks.length, images: result.images.length, savedToVault: true,
        };
      },
    },
    {
      name: "web_search",
      description: "多引擎联网搜索（结果自动写入 Vault）",
      inputSchema: {
        query: z.string().describe("搜索关键词"),
        engines: z.array(z.string()).optional().describe("引擎列表"),
        num: z.number().optional().default(10).describe("每个引擎数量"),
      },
      handler: async (args) => {
        // M6 审计修复：结果进入上下文前钳制条数与单条长度
        const results = await pipeline.searchMulti(args.query as string, {
          engines: args.engines as string[], num: args.num as number,
        });
        return sanitizeSearchResultsForContext(results);
      },
    },
    {
      name: "search_engines_list",
      description: "列出可用搜索引擎",
      inputSchema: {},
      handler: async () => {
        const { searchAggregator } = await import("../crawl/search-engines.js");
        return searchAggregator.listEngines();
      },
    },
  ];
}

/** Chat 工具配置：skill_run/skill_list + 联网工具（web_fetch/web_search/search_engines_list），统一调度。 */
export function buildChatToolConfig(pipeline: DataPipeline): {
  tools: ReturnType<typeof toOpenAITools>;
  executeTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
} {
  const skillTools = buildSkillToolSurfaces().filter((t) => t.name === "skill_run" || t.name === "skill_list");
  const webTools = buildWebToolSurfaces(pipeline);
  return {
    tools: toOpenAITools([...skillTools, ...webTools]),
    executeTool: async (name, args) => {
      const web = webTools.find((t) => t.name === name);
      if (web) return web.handler(args);
      return runSkillTool(name, args);
    },
  };
}

function isValidChatMessage(m: unknown): m is { role: string; content: string } {
  if (m === null || typeof m !== "object") return false;
  const obj = m as Record<string, unknown>;
  return typeof obj.role === "string" && typeof obj.content === "string";
}

/**
 * POST /chat/stream — Server-Sent Events 聊天流式端点。
 *
 * 请求体与 POST /chat 完全一致（向后兼容）：
 *   {
 *     messages?: Array<{role, content}>,
 *     taskType?: string,
 *     intent?: boolean,
 *     preferNativeStream?: boolean  // 可选：是否尝试原生 fetch 流式（默认 true）
 *   }
 *
 * 响应：text/event-stream，事件序列：
 *   event: start  → data: { type:"start", model, provider, role, intent? }
 *   event: token  → data: { type:"token", content:"..." }
 *   event: done   → data: { type:"done", content, model, provider, usage, fallbackUsed }
 *   event: error  → data: { type:"error", message:"..." }
 *
 * 兼容：若 proxyFetch 已缓冲，则流式退化为“整段一次性 token 推送”，仍满足 SSE 协议。
 *       原生 fetch 流式通过 ReadableStream 实现真实增量（progressive enhancement）。
 */
export async function handleChatHistory(ctx: RouteContext): Promise<Response | null> {
  if (ctx.url.pathname !== "/chat/history" || ctx.req.method !== "GET") return null;
  const limit = parseInt(ctx.url.searchParams.get("limit") || "50", 10);
  const sessions = ctx.db.query(
    `SELECT c.session_id as id, COALESCE(s.title, '') as title,
            MIN(c.created_at) as createdAt, MAX(c.created_at) as updatedAt
     FROM conversations c
     LEFT JOIN chat_sessions s ON s.session_id = c.session_id
     GROUP BY c.session_id, s.title
     ORDER BY updatedAt DESC LIMIT ?`
  ).all(limit);
  return ctx.jsonResponse({ sessions, total: sessions.length }, 200, ctx.baseHeaders);
}

export async function handleChatStream(ctx: RouteContext): Promise<Response | null> {
  if (!(ctx.url.pathname === "/chat/stream" && ctx.req.method === "POST")) {
    return null;
  }

  // 解析请求体
  let body: {
    taskType?: unknown;
    messages?: unknown;
    intent?: unknown;
    preferNativeStream?: unknown;
    reasoningEffort?: unknown;
    budget?: unknown;
    sessionId?: unknown;
  };
  try {
    body = (await ctx.req.json()) as typeof body;
  } catch (e) {
    return ctx.jsonResponse({ error: "Invalid JSON body" }, 400, ctx.baseHeaders);
  }

  // 轻量校验：messages 必须是非空 {role, content} 数组
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return ctx.jsonResponse(
      { error: "messages must be a non-empty array" },
      400,
      ctx.baseHeaders,
    );
  }
  if (!body.messages.every(isValidChatMessage)) {
    return ctx.jsonResponse(
      { error: "Each message must be an object with string 'role' and 'content'" },
      400,
      ctx.baseHeaders,
    );
  }
  const messages = body.messages as Array<{ role: string; content: string }>;
  const sessionId = normalizeSessionId(body.sessionId);
  // P0-B：仅显式提供 sessionId 的请求参与会话召回（bootstrap 注入）
  const recallSessionId = typeof body.sessionId === "string" && body.sessionId.trim() ? body.sessionId.trim() : undefined;
  const streamStartedAt = Date.now();
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  if (lastUser) {
    persistChatMessage(ctx.db, { sessionId, role: "user", content: lastUser.content });
  }

  // taskType 缺失或非法时回退到 'general-chat'
  let taskType: string = "general-chat";
  if (typeof body.taskType === "string" && VALID_TASK_TYPES.has(body.taskType)) {
    taskType = body.taskType;
  }

  const enableIntent = body.intent !== false; // 默认为 true
  const preferNativeStream: boolean | undefined =
    typeof body.preferNativeStream === "boolean" ? body.preferNativeStream : undefined;
  const reasoningEffort: string | undefined =
    typeof body.reasoningEffort === "string" ? body.reasoningEffort : undefined;
  const budget: number | undefined =
    typeof body.budget === "number" ? body.budget : undefined;

  // 复用 handleChat 的消息构建逻辑（包含 intent + codegraph + knowledge context）
  const { chatMessages, intentInfo, codegraphContext, evidence, tokenBudgetReport } = await prepareChatContext(
    messages,
    enableIntent,
    ctx.vault,
    { budget, sessionId: recallSessionId },
  );

  // 选择路由（与 handleChat 保持一致：intent > taskType）
  // taskType 已经在上面规范化过，缺失/非法时默认 'general-chat'
  // intent 值（code/research/knowledge/write/plan/chat）不是合法 TaskRole，
  // 必须经 INTENT_ROUTE_TABLE 映射为角色，否则 findModelsForRole 返回空
  const roleForStream: string = intentInfo
    ? (INTENT_ROUTE_TABLE[intentInfo.intent]?.role ?? DEFAULT_ROLE)
    : taskType;

  // 心跳定时器：避免长时间 LLM 响应被中间代理超时切断
  const encoder = new TextEncoder();
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let closed = false;
  // 上游生成器句柄提到外层作用域：cancel()（客户端断开）时需要它来停止生成
  let streamIter: AsyncGenerator<ChatStreamEvent> | null = null;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const safeEnqueue = (chunk: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          closed = true;
        }
      };

      // 初始 keep-alive 注释（立即发送，让客户端知道连接已建立）
      safeEnqueue(sseComment("axiom chat stream connected"));

      // 30 秒一发心跳
      heartbeat = setInterval(() => {
        safeEnqueue(sseComment(`hb ${Date.now()}`));
      }, 30000);

      try {
        const { tools, executeTool } = buildChatToolConfig(ctx.pipeline);
        streamIter = router.chatStream(roleForStream, chatMessages, {
          ...(preferNativeStream !== undefined ? { preferNativeStream } : {}),
          ...(intentInfo?.intent ? { intent: intentInfo.intent } : {}),
          ...(reasoningEffort ? { reasoningEffort } : {}),
          tools,
          executeTool,
          maxToolIterations: 4,
        });

        for await (const ev of streamIter) {
          if (closed) break;
          switch (ev.type) {
            case "start":
              safeEnqueue(sseEvent("start", {
                type: "start",
                sessionId,
                model: ev.model,
                provider: ev.provider,
                role: ev.role,
                layer: ev.layer,
                intent: ev.intent,
                codegraphContext: codegraphContext ? { length: codegraphContext.length } : null,
                tokenBudget: tokenBudgetReport ?? null,
                intentInfo: intentInfo
                  ? {
                      name: intentInfo.agentName,
                      category: intentInfo.intent,
                      confidence: intentInfo.confidence,
                    }
                  : null,
              }));
              break;
            case "token":
              safeEnqueue(sseEvent("token", { type: "token", content: ev.content }));
              break;
            case "done":
              if (ev.content) {
                persistChatMessage(ctx.db, {
                  sessionId,
                  role: "assistant",
                  content: ev.content,
                  tokensUsed: ev.usage?.total_tokens ?? 0,
                  latencyMs: Date.now() - streamStartedAt,
                });
                // P0-B：会话自动归档（非阻塞 fire-and-forget；MemoryGate 约束；失败静默）
                if (ev.content.trim().length > 0) {
                  void archiveExchangeToVault(ctx.vault, ctx.db, sessionId, {
                    userContent: lastUser?.content ?? "",
                    assistantContent: ev.content,
                    gateTaskType: mapIntentToGateTaskType(intentInfo?.intent ?? taskType),
                  });
                }
              }
              // P0-C（2026-08-29）：缝①（流式）—— done 帧正文过请求级 factBase 校验，
              // 结论随 done 事件下发（null = 无检索证据，校验未运行；可观测不阻断）。
              const streamHallucination = assessStatement(evidence, ev.content ?? "");
              // S5（2026-08-29）：缝①（流式）verdict 落库（与上方非流式同策略，吞错不阻塞 SSE）
              if (streamHallucination) {
                recordHallucinationVerdict(ctx.db, {
                  statement: ev.content ?? "",
                  evidenceTexts: evidence.map((f) => f.text),
                  pValue: streamHallucination.pValue,
                  verdict: streamHallucination.verdict,
                  isAccepted: streamHallucination.isAccepted,
                  seam: "chat",
                });
              }
              safeEnqueue(sseEvent("done", {
                type: "done",
                content: ev.content,
                model: ev.model,
                provider: ev.provider,
                usage: ev.usage,
                fallbackUsed: ev.fallbackUsed,
                _hallucination: streamHallucination,
              }));

              // Real Usage 采集（stream done）
              try {
                const lastPrompt = String(lastUser?.content ?? messages[messages.length - 1]?.content ?? "").slice(0, 4000);
                const success = Boolean(ev.content && ev.content.trim().length > 0);
                const { captureRealUsageTrace } = await import("../agent-evals/real-usage.js");
                void captureRealUsageTrace({
                  id: `chat-stream-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
                  task: lastPrompt || "chat-stream",
                  success,
                  model: String(ev.model ?? ev.provider ?? ""),
                  latencyMs: Date.now() - streamStartedAt,
                  source: "chat-stream",
                  feedback: success ? "auto-success" : "auto-fail",
                }).catch((err) => logger.warn("[chat] usage-trace capture failed", { error: err instanceof Error ? err.message : String(err) }));
                // 自动 evolve 学习侧触发（fire-and-forget，默认 OFF；失败不阻断响应）
                const { maybeAutoEvolve } = await import("../agent-evals/auto-evolve.js");
                void maybeAutoEvolve().catch((err) => logger.warn("[chat] auto-evolve check failed", { error: err instanceof Error ? err.message : String(err) }));
              } catch {}

              // 完成后广播一次 usage 给 WebSocket 订阅者
              try {
                wsManager.broadcast({
                  type: "model.usage",
                  payload: {
                    layer: ev.fallbackUsed ? "general" : "general",
                    taskType: taskType || "auto",
                    provider: ev.provider,
                  },
                  timestamp: new Date().toISOString(),
                });
                if (intentInfo) {
                  wsManager.broadcast({
                    type: "agent.intent",
                    payload: {
                      intent: intentInfo.agentName,
                      confidence: intentInfo.confidence,
                      layer: "general",
                    },
                    timestamp: new Date().toISOString(),
                  });
                }
              } catch {
                /* ignore WS broadcast errors */
              }
              break;
            case "error":
              safeEnqueue(sseEvent("error", { type: "error", message: ev.message }));
              break;
          }
        }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        logger.error("[chatStream] handler error", err instanceof Error ? err : new Error(errMsg));
        safeEnqueue(sseEvent("error", { type: "error", message: errMsg }));
      } finally {
        if (heartbeat) {
          clearInterval(heartbeat);
          heartbeat = null;
        }
        if (!closed) {
          try {
            controller.close();
          } catch {
            /* already closed */
          }
          closed = true;
        }
      }
    },
    cancel() {
      closed = true;
      if (heartbeat) {
        clearInterval(heartbeat);
        heartbeat = null;
      }
      // 客户端断开（abort）：停止上游 LLM 生成，避免请求继续空转
      if (streamIter) {
        void streamIter.return(undefined).catch(() => {});
        streamIter = null;
      }
    },
  });

  return new Response(stream, {
    status: 200,
    headers: sseHeaders(ctx.baseHeaders),
  });
}
