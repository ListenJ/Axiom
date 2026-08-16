/**
 * Chat and agent-chat routes
 */
import type { RouteContext } from "./types.js";
import { logger } from "../utils/logger.js";
import { router, type ChatMessage, type ChatStreamEvent } from "../router/model-router.js";
import { INTENT_ROUTE_TABLE, DEFAULT_ROLE } from "../router/route-table.js";
import { wsManager } from "../utils/websocket.js";
import { prepareChatContext, executeChat } from "../services/index.js";
import { applySelfThought, getDefaultSelfEvolve } from "../self-evolve/index.js";
import { buildSkillToolSurfaces, runSkillTool } from "../mcp/server/skill-tools.js";
import { toOpenAITools } from "../utils/tool-surface.js";
import { z } from "zod";
import type { ToolDef } from "../mcp/tool-registry.js";
import type { DataPipeline } from "../crawl/data-pipeline.js";
import { normalizeSessionId, persistChatMessage } from "../db/session-store.js";

export async function handleChat(ctx: RouteContext): Promise<Response | null> {
  if (ctx.url.pathname !== "/chat" || ctx.req.method !== "POST") return null;

  const body = await ctx.req.json();
  const { taskType, messages = [], intent: enableIntent = true, budget, sessionId } = body;

  const { chatMessages: preparedMessages, intentInfo, codegraphContext, tokenBudgetReport } = await prepareChatContext(
    messages,
    enableIntent,
    ctx.vault,
    { budget },
  );
  const chatMessages = await applySelfThought(
    preparedMessages,
    String(Array.isArray(messages) ? [...messages].reverse().find((m: { role?: string }) => m?.role === "user")?.content ?? "" : ""),
    getDefaultSelfEvolve(),
  );
  const roleForTools = intentInfo
    ? (INTENT_ROUTE_TABLE[intentInfo.intent]?.role ?? DEFAULT_ROLE)
    : (typeof taskType === "string" && VALID_TASK_TYPES.has(taskType) ? taskType : DEFAULT_ROLE);
  const { tools, executeTool } = buildChatToolConfig(ctx.pipeline);
  const result = await executeChat(chatMessages, intentInfo, taskType, {
    role: roleForTools,
    tools,
    executeTool,
  });

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

  const response = ctx.jsonResponse({
    ...result,
    sessionId: normalizedSessionId,
    codegraphContext: codegraphContext ? { length: codegraphContext.length } : null,
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

  return response;
}

export async function handleAgentChat(ctx: RouteContext): Promise<Response | null> {
  if (ctx.url.pathname !== "/agent-chat" || ctx.req.method !== "POST") return null;

  const body = await ctx.req.json();
  const { message, history = [], taskType, budget } = body;
  const messages: Array<{ role: string; content: string }> = [
    ...(history as Array<{ role: string; content: string }>),
    { role: "user", content: message },
  ];

  const { chatMessages: preparedMessages, intentInfo, tokenBudgetReport } = await prepareChatContext(
    messages,
    true,
    ctx.vault,
    { budget },
  );
  const chatMessages = await applySelfThought(preparedMessages, String(message ?? ""), getDefaultSelfEvolve());
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

/** 原生 function-calling 暴露给内部模型的 skill 工具（按需调用） */
/** 联网工具面：web_fetch / web_search / search_engines_list（复用 DataPipeline，结果自动写入 Vault） */
function buildWebToolSurfaces(pipeline: DataPipeline): ToolDef[] {
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
      handler: async (args) => pipeline.searchMulti(args.query as string, {
        engines: args.engines as string[], num: args.num as number,
      }),
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
function buildChatToolConfig(pipeline: DataPipeline): {
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
  const { chatMessages, intentInfo, codegraphContext, tokenBudgetReport } = await prepareChatContext(
    messages,
    enableIntent,
    ctx.vault,
    { budget },
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
              }
              safeEnqueue(sseEvent("done", {
                type: "done",
                content: ev.content,
                model: ev.model,
                provider: ev.provider,
                usage: ev.usage,
                fallbackUsed: ev.fallbackUsed,
              }));

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
