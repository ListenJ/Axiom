import { PROVIDER_CONFIG } from "./models.js";
import type { ToolCall, ToolCallDef } from "../utils/tool-surface.js";
import { getEffectiveApiKey, getEffectiveBaseURL } from "../utils/api-key-store.js";
import { buildReasoningParams } from "./reasoning-effort.js";
import { logger } from "../utils/logger.js";

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  /** assistant 消息附带的工具调用（function calling） */
  tool_calls?: ToolCall[];
  /** tool 消息回填的调用 id */
  tool_call_id?: string;
  /** DeepSeek 思考模式：工具轮次必须回传的思维链（官方 400 约束） */
  reasoning_content?: string;
}

export type StreamChunkCallback = (chunk: string) => void;

const MAX_REQUEST_BYTES = 1 * 1024 * 1024;
const MAX_CONTEXT_CHARS = 600_000;

/**
 * 仅 DeepSeek 识别 reasoning_content 扩展字段；发送给其他 OpenAI 兼容供应商前剥离，
 * 避免未知字段被上游拒绝/污染上下文。
 */
function sanitizeMessages(provider: string, messages: ChatMessage[]): ChatMessage[] {
  if (provider === "deepseek") return messages;
  return messages.map((m) => {
    if (!m.reasoning_content) return m;
    const { reasoning_content: _drop, ...rest } = m;
    return rest;
  });
}

export interface NativeStreamResult {
  content: string;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  toolCalls?: ToolCall[];
  /** DeepSeek/GLM 等思考模型经 reasoning_content 返回的思维链片段 */
  thinking?: string[];
}

export async function callProvider(
  provider: string,
  model: string,
  messages: ChatMessage[],
  timeoutMs: number,
  temperature = 0.7,
  reasoningEffort?: string,
  tools?: ToolCallDef[],
  override?: { baseURL?: string; apiKey?: string; thinking?: boolean },
  maxTokens?: number,
  signal?: AbortSignal
): Promise<{
  content: string | null;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  toolCalls?: ToolCall[];
  thinking?: string[];
}> {
  const config = PROVIDER_CONFIG[provider as keyof typeof PROVIDER_CONFIG];
  if (!config && !override?.apiKey) throw new Error(`Unknown provider: ${provider}`);

  const apiKey = override?.apiKey ?? (config ? getEffectiveApiKey(provider, config.apiKeyEnv) : undefined);
  if (!apiKey) throw new Error(`Missing API key for ${provider}: ${config?.apiKeyEnv ?? "override"}`);

  const baseURL = override?.baseURL ?? getEffectiveBaseURL(provider, config?.apiKeyEnv ?? "", config?.baseURL ?? "");

  if (!Array.isArray(messages) || messages.length === 0) {
    throw new Error("messages must be a non-empty array");
  }
  const totalChars = messages.reduce((sum, m) => sum + (typeof m?.content === "string" ? m.content.length : 0), 0);
  if (totalChars > MAX_CONTEXT_CHARS) {
    throw new Error(
      `Message content too large: ${totalChars} chars (max ${MAX_CONTEXT_CHARS}). Please trim context.`,
    );
  }
  const payloadSize = JSON.stringify({ model, messages, temperature }).length;
  if (payloadSize > MAX_REQUEST_BYTES) {
    throw new Error(
      `Request payload too large: ${payloadSize} bytes (max ${MAX_REQUEST_BYTES}). Reduce message count or size.`,
    );
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onExternalAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener("abort", onExternalAbort, { once: true });
  }

  try {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    };

    if (provider === "openrouter") {
      headers["HTTP-Referer"] = "https://axiom-runtime.ai";
      headers["X-Title"] = "Axiom Agent";
    }

    const res = await fetch(`${baseURL}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model,
        messages: sanitizeMessages(provider, messages),
        temperature,
        ...(maxTokens ? { max_tokens: maxTokens } : {}),
        ...buildReasoningParams(provider, reasoningEffort, { thinking: override?.thinking }),
        ...(tools && tools.length > 0 ? { tools } : {}),
      }),
      signal: controller.signal,
    });

    clearTimeout(timer);
    signal?.removeEventListener("abort", onExternalAbort);

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`HTTP ${res.status}: ${errText}`);
    }

    const data = await res.json();
    const msg = data.choices?.[0]?.message;
    return {
      content: msg?.content ?? null,
      usage: data.usage,
      toolCalls: msg?.tool_calls ?? undefined,
      thinking:
        typeof msg?.reasoning_content === "string" && msg.reasoning_content.length > 0
          ? [msg.reasoning_content]
          : undefined,
    };
  } catch (e) {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onExternalAbort);
    throw e;
  }
}

export async function callProviderNativeStream(
  provider: string,
  model: string,
  messages: ChatMessage[],
  timeoutMs: number,
  temperature = 0.7,
  onChunk: StreamChunkCallback,
  signal?: AbortSignal,
  reasoningEffort?: string,
  tools?: ToolCallDef[],
  override?: { baseURL?: string; apiKey?: string; thinking?: boolean }
): Promise<NativeStreamResult> {
  const config = PROVIDER_CONFIG[provider as keyof typeof PROVIDER_CONFIG];
  if (!config && !override?.apiKey) throw new Error(`Unknown provider: ${provider}`);

  const apiKey = override?.apiKey ?? (config ? getEffectiveApiKey(provider, config.apiKeyEnv) : undefined);
  if (!apiKey) throw new Error(`Missing API key for ${provider}: ${config?.apiKeyEnv ?? "override"}`);

  const baseURL = override?.baseURL ?? getEffectiveBaseURL(provider, config?.apiKeyEnv ?? "", config?.baseURL ?? "");

  if (!Array.isArray(messages) || messages.length === 0) {
    throw new Error("messages must be a non-empty array");
  }
  const totalChars = messages.reduce(
    (sum, m) => sum + (typeof m?.content === "string" ? m.content.length : 0),
    0,
  );
  if (totalChars > MAX_CONTEXT_CHARS) {
    throw new Error(
      `Message content too large: ${totalChars} chars (max ${MAX_CONTEXT_CHARS}). Please trim context.`,
    );
  }
  const payloadSize = JSON.stringify({ model, messages, temperature, stream: true }).length;
  if (payloadSize > MAX_REQUEST_BYTES) {
    throw new Error(
      `Request payload too large: ${payloadSize} bytes (max ${MAX_REQUEST_BYTES}). Reduce message count or size.`,
    );
  }

  const fetchFn = (typeof globalThis.fetch === "function" ? globalThis.fetch : null);
  if (!fetchFn) {
    throw new Error("Global fetch is not available in this runtime");
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`,
    Accept: "text/event-stream",
  };

  if (provider === "openrouter") {
    headers["HTTP-Referer"] = "https://axiom-runtime.ai";
    headers["X-Title"] = "Axiom Agent";
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const onExternalAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) {
      controller.abort();
    } else {
      signal.addEventListener("abort", onExternalAbort, { once: true });
    }
  }

  try {
    const res = await fetchFn(`${baseURL}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model,
        messages: sanitizeMessages(provider, messages),
        temperature,
        stream: true,
        ...buildReasoningParams(provider, reasoningEffort, { thinking: override?.thinking }),
        ...(tools && tools.length > 0 ? { tools } : {}),
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw new Error(`HTTP ${res.status}: ${errText}`);
    }

    if (!res.body || typeof res.body.getReader !== "function") {
      throw new Error("Response body is not readable");
    }

    const body = res.body as ReadableStream<Uint8Array>;
    const reader = body.getReader();
    const decoder = new TextDecoder("utf-8");
    let buffer = "";
    let fullContent = "";
    let usage: NativeStreamResult["usage"];
    const thinkingChunks: string[] = [];
    const toolCallAcc = new Map<number, ToolCall>();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith("data: ")) continue;
        const payload = trimmed.slice(6);
        if (payload === "[DONE]") continue;
        try {
          const parsed = JSON.parse(payload) as {
            choices?: Array<{
              delta?: {
                content?: unknown;
                reasoning_content?: unknown;
                tool_calls?: Array<{
                  index?: number;
                  id?: string;
                  type?: string;
                  function?: { name?: string; arguments?: string };
                }>;
              };
            }>;
            usage?: NativeStreamResult["usage"];
          };
          const delta = parsed.choices?.[0]?.delta?.content;
          if (typeof delta === "string" && delta.length > 0) {
            fullContent += delta;
            onChunk(delta);
          }
          // DeepSeek 思考模式：思维链经 delta.reasoning_content 流式返回。
          // 封装为 _axon thinking 事件透传给前端（ThinkingPanel 渲染），避免 CoT 被丢弃。
          const reasoningDelta = parsed.choices?.[0]?.delta?.reasoning_content;
          if (typeof reasoningDelta === "string" && reasoningDelta.length > 0) {
            thinkingChunks.push(reasoningDelta);
            onChunk(JSON.stringify({ _axon: "thinking", content: reasoningDelta }));
          }
          const rawCalls = parsed.choices?.[0]?.delta?.tool_calls;
          if (Array.isArray(rawCalls)) {
            for (const rc of rawCalls) {
              const idx = rc.index ?? 0;
              const existing = toolCallAcc.get(idx) ?? {
                id: rc.id ?? "",
                type: "function" as const,
                function: { name: "", arguments: "" },
              };
              if (rc.id) existing.id = rc.id;
              if (rc.function?.name) existing.function.name += rc.function.name;
              if (rc.function?.arguments) existing.function.arguments += rc.function.arguments;
              toolCallAcc.set(idx, existing);
            }
          }
          if (parsed.usage) {
            usage = parsed.usage;
          }
        } catch (e) {
          // SSE 流中可能包含非 JSON 行（keep-alive 注释、不完整 chunk），
          // 跳过即可；但记录 debug 日志便于排查上游协议异常。
          logger.debug("[ProviderCaller] SSE chunk parse skipped", {
            payload: payload.slice(0, 80),
            error: (e as Error).message,
          });
        }
      }
    }

    return {
      content: fullContent,
      usage,
      toolCalls: toolCallAcc.size > 0 ? Array.from(toolCallAcc.values()) : undefined,
      thinking: thinkingChunks.length > 0 ? thinkingChunks : undefined,
    };
  } finally {
    clearTimeout(timer);
    if (signal) {
      signal.removeEventListener("abort", onExternalAbort);
    }
  }
}

import type { DreCloudCaller } from "../dre/ports/cloud-caller.js";

/**
 * L1 适配器：DRE 云端口 → 具体 provider 调用。
 * provider 语义内聚于此（baseUrl 存在时按自定义 OpenAI 兼容端点处理，
 * 消除旧实现硬编码 "deepseek" 的语义错位 —— 审计 M10）。
 * 超时由入参 timeoutMs 经 callProvider 内 AbortController 控（默认 5s）；
 * 本适配器补重试 1 次与降级 fallback：瞬时网络/5xx 后重试一次，仍失败则
 * 返回空串由调用方判定走本地 deterministic fallback（vault.search +
 * hallucinationDetector 保守放行），不抛异常中断 DRE 管线。
 */
export function createDreCloudAdapter(fb: {
  baseUrl?: string;
  apiKey?: string;
  model?: string;
}): DreCloudCaller {
  return {
    async call(input) {
      const doCall = () =>
        callProvider(
          fb.baseUrl ? "custom-openai" : "deepseek",
          fb.model ?? "deepseek-v4-flash",
          [
            { role: "system", content: input.system },
            { role: "user", content: input.user },
          ],
          input.timeoutMs,
          input.temperature,
          undefined,
          undefined,
          { baseURL: fb.baseUrl, apiKey: fb.apiKey },
        );
      try {
        const result = await doCall();
        return { content: result.content ?? "" };
      } catch (e) {
        logger.warn("[DRE] cloud adapter retry after first failure", {
          error: e instanceof Error ? e.message : String(e),
          baseUrl: fb.baseUrl ?? "(default)",
        });
        try {
          const retryResult = await doCall();
          return { content: retryResult.content ?? "" };
        } catch (e2) {
          logger.warn("[DRE] cloud adapter fallback to local deterministic", {
            error: e2 instanceof Error ? e2.message : String(e2),
            baseUrl: fb.baseUrl ?? "(default)",
          });
          // fallback: return empty string, caller判定空串 → 本地 vault.search + conservative
          return { content: "" };
        }
      }
    },
  };
}