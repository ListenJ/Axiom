/**
 * OpenAI 兼容端点 — POST /v1/chat/completions
 *
 * 让 OpenAI SDK / 生态工具可直接接入内部 chat 管线：
 *   请求  { model, messages, stream? }  →  prepareChatContext + executeChat / router.chatStream
 *   响应  非流式: chat.completion JSON；流式: chat.completion.chunk SSE + data: [DONE]
 *
 * model 字段仅透传回显，路由仍由内部意图/taskType 决定（与其他 chat 端点一致）。
 * 鉴权：沿用 main.ts 全局 checkApiKey（x-api-key 或 Authorization: Bearer，
 * OpenAI SDK 默认发送后者），本 handler 不做二次校验。
 */
import type { RouteContext } from "./types.js";
import { logger } from "../utils/logger.js";
import { router } from "../router/model-router.js";
import { prepareChatContext, executeChat } from "../services/chat.js";
import { applySelfThought, getDefaultSelfEvolve } from "../self-evolve/index.js";
import { INTENT_ROUTE_TABLE, DEFAULT_ROLE } from "../router/route-table.js";
import { buildSkillToolSurfaces, runSkillTool } from "../mcp/server/skill-tools.js";
import { toOpenAITools } from "../utils/tool-surface.js";

interface OpenAIChatMessage {
  role: string;
  content: string;
}

function isValidMessage(m: unknown): m is OpenAIChatMessage {
  if (m === null || typeof m !== "object") return false;
  const obj = m as Record<string, unknown>;
  return typeof obj.role === "string" && typeof obj.content === "string";
}

/** OpenAI 风格的错误响应体 */
function openaiError(
  ctx: RouteContext,
  message: string,
  status: number,
  type = "invalid_request_error",
): Response {
  return ctx.jsonResponse(
    { error: { message, type, param: null, code: null } },
    status,
    ctx.baseHeaders,
  );
}

function sseHeaders(baseHeaders: Record<string, string>): Record<string, string> {
  return {
    ...baseHeaders,
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
  };
}

function sseData(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

/** 原生 function-calling 暴露给 v1/* 非流式调用的 skill 工具 */
const NATIVE_SKILL_TOOLS = toOpenAITools(
  buildSkillToolSurfaces().filter((t) => t.name === "skill_run" || t.name === "skill_list"),
);

/** 内部 chat 管线依赖（测试注入 fake 的接缝；生产默认真实实现） */
export interface OpenAICompatDeps {
  prepareChatContext: typeof prepareChatContext;
  executeChat: typeof executeChat;
  chatStream: typeof router.chatStream;
}

const defaultDeps: OpenAICompatDeps = {
  prepareChatContext: async (messages, enableIntent, vault, options) => {
    const prepared = await prepareChatContext(messages, enableIntent, vault, options);
    const lastUser = [...messages].reverse().find((m) => m.role === "user");
    if (lastUser?.content) {
      prepared.chatMessages = await applySelfThought(
        prepared.chatMessages,
        lastUser.content,
        getDefaultSelfEvolve(),
      );
    }
    return prepared;
  },
  executeChat: async (messages, intentInfo, taskType) => {
    const role = intentInfo
      ? (INTENT_ROUTE_TABLE[intentInfo.intent]?.role ?? DEFAULT_ROLE)
      : (taskType ?? DEFAULT_ROLE);
    return executeChat(messages, intentInfo, taskType, {
      role,
      tools: NATIVE_SKILL_TOOLS,
      executeTool: runSkillTool,
    });
  },
  chatStream: (role, messages, opts) => router.chatStream(role, messages, opts),
};

export function createOpenAICompatHandler(deps: OpenAICompatDeps = defaultDeps) {
  return async function handleOpenAIChatCompletions(ctx: RouteContext): Promise<Response | null> {
  if (ctx.url.pathname !== "/v1/chat/completions" || ctx.req.method !== "POST") return null;

  let body: { model?: unknown; messages?: unknown; stream?: unknown };
  try {
    body = (await ctx.req.json()) as typeof body;
  } catch {
    return openaiError(ctx, "Invalid JSON body", 400);
  }

  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return openaiError(ctx, "messages must be a non-empty array", 400);
  }
  if (!body.messages.every(isValidMessage)) {
    return openaiError(ctx, "Each message must be an object with string 'role' and 'content'", 400);
  }
  const messages = body.messages as OpenAIChatMessage[];
  const requestedModel = typeof body.model === "string" ? body.model : "axiom-auto";
  const isStream = body.stream === true;

  // 映射到内部 chat 管线（与 /chat、/chat/stream 相同）
  const { chatMessages, intentInfo } = await deps.prepareChatContext(messages, true, ctx.vault);

  const id = `chatcmpl-${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;
  const created = Math.floor(Date.now() / 1000);

  if (!isStream) {
    const result = await deps.executeChat(chatMessages, intentInfo, undefined);
    return ctx.jsonResponse({
      id,
      object: "chat.completion",
      created,
      model: requestedModel,
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: result.content ?? "" },
          finish_reason: "stop",
        },
      ],
      usage: {
        prompt_tokens: result.usage?.prompt_tokens ?? 0,
        completion_tokens: result.usage?.completion_tokens ?? 0,
        total_tokens: result.usage?.total_tokens ?? 0,
      },
    }, 200, ctx.baseHeaders);
  }

  // ── 流式：OpenAI 风格 SSE（chat.completion.chunk + [DONE]）──
  const roleForStream: string = intentInfo ? intentInfo.intent : "general-chat";
  const encoder = new TextEncoder();
  let closed = false;

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
      const chunkBase = { id, object: "chat.completion.chunk", created, model: requestedModel };

      try {
        const streamIter = deps.chatStream(roleForStream, chatMessages, {
          ...(intentInfo?.intent ? { intent: intentInfo.intent } : {}),
        });

        // 首帧：role delta（OpenAI SDK 期望的流起始形态）
        safeEnqueue(sseData({
          ...chunkBase,
          choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
        }));

        for await (const ev of streamIter) {
          if (closed) break;
          switch (ev.type) {
            case "start":
              // 路由元数据已在非流式不可见；流式下模型名以请求值为准，跳过
              break;
            case "token":
              safeEnqueue(sseData({
                ...chunkBase,
                choices: [{ index: 0, delta: { content: ev.content }, finish_reason: null }],
              }));
              break;
            case "done":
              safeEnqueue(sseData({
                ...chunkBase,
                choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
                ...(ev.usage ? { usage: ev.usage } : {}),
              }));
              break;
            case "error":
              safeEnqueue(sseData({ error: { message: ev.message, type: "server_error", param: null, code: null } }));
              break;
          }
        }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        logger.error("[openaiCompat] stream error", err instanceof Error ? err : new Error(errMsg));
        safeEnqueue(sseData({ error: { message: errMsg, type: "server_error", param: null, code: null } }));
      } finally {
        safeEnqueue("data: [DONE]\n\n");
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
    },
  });

  return new Response(stream, {
    status: 200,
    headers: sseHeaders(ctx.baseHeaders),
  });
  };
}

/** 生产 handler（routes/index.ts 注册用，默认真实管线） */
export const handleOpenAIChatCompletions = createOpenAICompatHandler();
