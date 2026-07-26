import { PROVIDER_CONFIG } from "./models.js";
import { getEffectiveApiKey, getEffectiveBaseURL } from "../utils/api-key-store.js";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export type StreamChunkCallback = (chunk: string) => void;

const MAX_REQUEST_BYTES = 1 * 1024 * 1024;
const MAX_CONTEXT_CHARS = 600_000;

export interface NativeStreamResult {
  content: string;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
}

export async function callProvider(
  provider: string,
  model: string,
  messages: ChatMessage[],
  timeoutMs: number,
  temperature = 0.7
): Promise<{ content: string | null; usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } }> {
  const config = PROVIDER_CONFIG[provider as keyof typeof PROVIDER_CONFIG];
  if (!config) throw new Error(`Unknown provider: ${provider}`);

  const apiKey = getEffectiveApiKey(provider, config.apiKeyEnv);
  if (!apiKey) throw new Error(`Missing API key for ${provider}: ${config.apiKeyEnv}`);

  const baseURL = getEffectiveBaseURL(provider, config.apiKeyEnv, config.baseURL);

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
      body: JSON.stringify({ model, messages, temperature }),
      signal: controller.signal,
    });

    clearTimeout(timer);

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`HTTP ${res.status}: ${errText}`);
    }

    const data = await res.json();
    return {
      content: data.choices?.[0]?.message?.content ?? null,
      usage: data.usage,
    };
  } catch (e) {
    clearTimeout(timer);
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
  signal?: AbortSignal
): Promise<NativeStreamResult> {
  const config = PROVIDER_CONFIG[provider as keyof typeof PROVIDER_CONFIG];
  if (!config) throw new Error(`Unknown provider: ${provider}`);

  const apiKey = getEffectiveApiKey(provider, config.apiKeyEnv);
  if (!apiKey) throw new Error(`Missing API key for ${provider}: ${config.apiKeyEnv}`);

  const baseURL = getEffectiveBaseURL(provider, config.apiKeyEnv, config.baseURL);

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
      body: JSON.stringify({ model, messages, temperature, stream: true }),
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
            choices?: Array<{ delta?: { content?: unknown } }>;
            usage?: NativeStreamResult["usage"];
          };
          const delta = parsed.choices?.[0]?.delta?.content;
          if (typeof delta === "string" && delta.length > 0) {
            fullContent += delta;
            onChunk(delta);
          }
          if (parsed.usage) {
            usage = parsed.usage;
          }
        } catch {
        }
      }
    }

    return { content: fullContent, usage };
  } finally {
    clearTimeout(timer);
    if (signal) {
      signal.removeEventListener("abort", onExternalAbort);
    }
  }
}
