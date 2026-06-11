/**
 * 多平台模型路由器 v5.0 — 扁平化架构
 *
 * 设计原则:
 *   - 单一 OpenAI 兼容 API
 *   - 扁平路由表: intent → role 直接映射，无嵌套 if/else
 *   - 统一执行端口: 所有调用走统一的 execute() 管线
 *   - 静态配置表 + 简单 fallback
 *   - 无 circuit breaker, 无 protocol 适配层
 */

import { logger } from "../utils/logger.js";
import { proxyFetch } from "../utils/proxy-fetch.js";
import { toolPool, type ToolRole } from "./tool-pool.js";
import { assignModel, findModelsForRole, type TaskRole, type AssignmentResult, type ModelCapability } from "./model-capability-registry.js";
import { PROVIDER_CONFIG, getFallbackChain, type UnifiedModel } from "./models.js";
import { getTokenTracker } from "./token-tracker.js";
import { getEffectiveApiKey, getEffectiveBaseURL } from "../utils/api-key-store.js";
import { TIMEOUTS } from "../constants/timeouts.js";

// =============================================================================
// 端口定义 (Input / Output Ports)
// =============================================================================

/** 输入消息 */
export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/** 基础输出 */
export interface ChatResponse {
  content: string | null;
  model: string;
  provider: string;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
  layer?: "decision" | "architecture" | "tool" | "evaluation" | "general";
}

/** 智能任务分配输出 */
export interface SmartAssignmentResponse {
  role: TaskRole;
  model: string;
  provider: string;
  endpoint: string;
  content: string | null;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    cost_usd?: number;
  };
  latency_ms?: number;
  fallback_used?: boolean;
}

/** 批量任务输入 */
export interface RoleAssignment {
  role: TaskRole;
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
}

/** 路由决策元数据 */
export interface RoutingMeta {
  role: TaskRole;
  thinking: "none" | "low" | "medium" | "high";
  reason: string;
}

/** 统一执行端口输入 */
export interface ExecuteInput {
  role: TaskRole;
  messages: ChatMessage[];
  timeout?: number;
  temperature?: number;
  trackAs?: string;
}

/** 统一执行端口输出 */
export interface ExecuteOutput {
  content: string | null;
  model: string;
  provider: string;
  usage?: ChatResponse["usage"];
  latencyMs: number;
  fallbackUsed: boolean;
  routingMeta?: RoutingMeta;
}

// =============================================================================
// 扁平化路由表
// =============================================================================

/** intent 关键词 → 角色映射 (扁平化，无嵌套) */
const INTENT_ROUTE_TABLE: Record<string, { role: TaskRole; useTool: boolean }> = {
  // Decision
  strategy:     { role: "decision", useTool: false },
  evaluation:   { role: "evaluation", useTool: false },
  decision:     { role: "decision", useTool: false },

  // Architecture
  architecture:   { role: "architecture", useTool: false },
  "system-design": { role: "architecture", useTool: false },
  infra:          { role: "architecture", useTool: false },

  // Tool-based
  engineering:        { role: "coding", useTool: true },
  "game-development": { role: "coding", useTool: true },
  integrations:       { role: "coding", useTool: true },
  testing:            { role: "coding", useTool: true },
  english:            { role: "english", useTool: true },
  translation:        { role: "english", useTool: true },
  localization:       { role: "english", useTool: true },
  rl:                 { role: "rl", useTool: true },
  reasoning:          { role: "rl", useTool: true },
  optimization:       { role: "rl", useTool: true },
};

/** 默认兜底角色 */
const DEFAULT_ROLE: TaskRole = "general-chat";

// =============================================================================
// Token 追踪辅助
// =============================================================================

function trackCall(
  model: string,
  provider: string,
  messages: ChatMessage[],
  result: {
    usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
    latencyMs: number;
    success: boolean;
    fallbackUsed?: boolean;
  },
  meta?: { role?: string; taskType?: string }
) {
  const usage = result.usage;
  if (!usage || !usage.total_tokens) return;

  getTokenTracker().record({
    timestamp: Date.now(),
    model,
    provider,
    role: meta?.role,
    taskType: meta?.taskType,
    promptTokens: usage.prompt_tokens ?? 0,
    completionTokens: usage.completion_tokens ?? 0,
    totalTokens: usage.total_tokens ?? 0,
    latencyMs: result.latencyMs,
    contentLength: messages.reduce((sum, m) => sum + (m.content?.length ?? 0), 0),
    success: result.success,
    fallbackUsed: result.fallbackUsed ?? false,
  });
}

// =============================================================================
// 通用 HTTP 调用
// =============================================================================

// 输入大小限制：防止单次请求发送过大 payload (默认 1MB)
const MAX_REQUEST_BYTES = 1 * 1024 * 1024;
// 上下文 token 上限（粗略估算 1 token ≈ 3 字符）
const MAX_CONTEXT_CHARS = 600_000;
// 每个模型的默认重试次数 (ModelCapability 接口未暴露 maxRetries, 这里使用统一默认值)
const DEFAULT_RETRY_ATTEMPTS = 3;

async function callProvider(
  provider: string,
  model: string,
  messages: ChatMessage[],
  timeoutMs: number,
  temperature = 0.7
): Promise<{ content: string | null; usage?: any }> {
  const config = PROVIDER_CONFIG[provider as keyof typeof PROVIDER_CONFIG];
  if (!config) throw new Error(`Unknown provider: ${provider}`);

  const apiKey = getEffectiveApiKey(provider, config.apiKeyEnv);
  if (!apiKey) throw new Error(`Missing API key for ${provider}: ${config.apiKeyEnv}`);

  const baseURL = getEffectiveBaseURL(provider, config.apiKeyEnv, config.baseURL);

  // 输入大小校验
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
      headers["HTTP-Referer"] = "https://openclaw.ai";
      headers["X-Title"] = "OpenClaw Agent";
    }

    const res = await proxyFetch(`${baseURL}/chat/completions`, {
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

// =============================================================================
// 路由器 v5.0 — 扁平化核心
// =============================================================================

export class MultiPlatformRouter {
  // ---------------------------------------------------------------------------
  // 统一执行端口 (Unified Execution Port)
  // 所有角色调用最终都走到这里，集中处理 fallback、tracking、timeout
  // ---------------------------------------------------------------------------
  async execute(input: ExecuteInput): Promise<ExecuteOutput> {
    const { role, messages, timeout = TIMEOUTS.API_DEFAULT, temperature, trackAs } = input;
    const startTime = Date.now();

    const models = findModelsForRole(role);
    if (models.length === 0) {
      logger.warn(`[Router] No models for role: ${role}`);
      return {
        content: `[System] No models configured for role "${role}".`,
        model: "none",
        provider: "local",
        latencyMs: 0,
        fallbackUsed: true,
      };
    }

    const sortedModels = [...models].sort((a, b) => (a.priority ?? 99) - (b.priority ?? 99));

    for (const model of sortedModels) {
      // Per-model retry: default DEFAULT_RETRY_ATTEMPTS (since ModelCapability doesn't expose maxRetries)
      // Note: ModelCapability interface lacks maxRetries; we use a constant default for transient-error resilience.
      const maxRetries = Math.max(1, DEFAULT_RETRY_ATTEMPTS);
      let lastError: Error | undefined;

      for (let attempt = 0; attempt < maxRetries; attempt++) {
        const loopStart = Date.now();
        try {
          const response = await callProvider(
            model.provider,
            model.model,
            messages,
            model.timeout ?? timeout,
            temperature
          );
          const latencyMs = Date.now() - loopStart;
          trackCall(model.model, model.provider, messages, {
            usage: response.usage,
            latencyMs,
            success: true,
          }, { role: trackAs ?? role, taskType: trackAs ?? role });
          logger.info(`[Router] Execute success role=${role} model=${model.provider}/${model.model} attempts=${attempt + 1} latencyMs=${latencyMs}`);

          return {
            content: response.content,
            model: model.model,
            provider: model.provider,
            usage: response.usage,
            latencyMs,
            fallbackUsed: false,
          };
        } catch (error) {
          lastError = error instanceof Error ? error : new Error(String(error));
          const msg = lastError.message;
          logger.warn(
            `[Router] Execute failed ${model.provider}/${model.model} (attempt ${attempt + 1}/${maxRetries})`,
            { error: msg }
          );
          trackCall(model.model, model.provider, messages, {
            latencyMs: Date.now() - loopStart,
            success: false,
          }, { role: trackAs ?? role, taskType: trackAs ?? role });
          // Exponential backoff with jitter, capped at 5s
          if (attempt < maxRetries - 1) {
            const backoff = Math.min(500 * Math.pow(2, attempt) + Math.random() * 200, 5000);
            await new Promise((r) => setTimeout(r, backoff));
          }
        }
      }
      logger.warn(`[Router] Model ${model.provider}/${model.model} exhausted retries`, {
        error: lastError?.message,
      });
    }

    logger.error(`[Router] All models exhausted for role: ${role}`);
    return {
      content: "I'm currently experiencing high load. Please try again in a moment.",
      model: "degraded",
      provider: "local",
      latencyMs: Date.now() - startTime,
      fallbackUsed: true,
    };
  }

  // ---------------------------------------------------------------------------
  // 高层 API (向后兼容)
  // ---------------------------------------------------------------------------

  async decide(messages: ChatMessage[]): Promise<ChatResponse> {
    const result = await this.execute({ role: "decision", messages, trackAs: "decide" });
    return { content: result.content, model: result.model, provider: result.provider, usage: result.usage, layer: "decision" };
  }

  async architect(messages: ChatMessage[]): Promise<ChatResponse> {
    const result = await this.execute({ role: "architecture", messages, trackAs: "architect" });
    return { content: result.content, model: result.model, provider: result.provider, usage: result.usage, layer: "architecture" };
  }

  async evaluate(messages: ChatMessage[]): Promise<ChatResponse> {
    const result = await this.execute({ role: "evaluation", messages, trackAs: "evaluate" });
    return { content: result.content, model: result.model, provider: result.provider, usage: result.usage, layer: "evaluation" };
  }

  async chat(taskType: TaskRole | string, messages: ChatMessage[]): Promise<ChatResponse> {
    const result = await this.execute({ role: taskType as TaskRole, messages, trackAs: "chat" });
    return { content: result.content, model: result.model, provider: result.provider, usage: result.usage, layer: "general" };
  }

  // ---------------------------------------------------------------------------
  // Tool Pool (独立端口，保持与之前相同的重试逻辑)
  // ---------------------------------------------------------------------------

  async tool(role: ToolRole, messages: ChatMessage[]): Promise<ChatResponse> {
    const maxAttempts = 3;
    let lastError: Error | undefined;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const model = toolPool.selectNext(role);
      if (!model) break;

      toolPool.markRequestStart(model.id);
      const startTime = Date.now();

      try {
        const response = await callProvider(model.provider, model.id, messages, TIMEOUTS.API_DEFAULT);
        const latencyMs = Date.now() - startTime;
        toolPool.recordLatency(model.id, latencyMs);
        toolPool.markRequestSuccess(model.id);
        const result: ChatResponse = { ...response, model: model.id, provider: model.provider, layer: "tool" };
        trackCall(model.id, model.provider, messages, { usage: response.usage, latencyMs, success: true }, { role, taskType: "tool" });
        return result;
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        toolPool.markRequestFailure(model.id, msg);
        lastError = error instanceof Error ? error : new Error(String(error));
        trackCall(model.id, model.provider, messages, { latencyMs: Date.now() - startTime, success: false }, { role, taskType: "tool" });
        logger.warn(`[Router] Tool ${model.id} failed (attempt ${attempt + 1})`, { error: msg });
        await this.delay(Math.min(1000 * Math.pow(2, attempt), 5000));
      }
    }

    logger.error(`[Router] All tool models exhausted for role: ${role}`);
    return {
      content: `Tool execution failed for ${role}. Please retry or check model availability.`,
      model: "degraded",
      provider: "local",
      layer: "tool",
    };
  }

  // ---------------------------------------------------------------------------
  // 扁平化意图路由
  // ---------------------------------------------------------------------------

  async routeByIntent(intent: string, messages: ChatMessage[], options?: { preferTool?: boolean }): Promise<ChatResponse> {
    const route = INTENT_ROUTE_TABLE[intent];

    if (route) {
      if (route.useTool && options?.preferTool !== false) {
        return this.tool(route.role as ToolRole, messages);
      }
      return this.chat(route.role, messages);
    }

    // 未匹配到任何意图，走默认
    return this.chat(DEFAULT_ROLE, messages);
  }

  // ---------------------------------------------------------------------------
  // Auto Route — 使用廉价模型做 per-turn 路由决策
  // ---------------------------------------------------------------------------

  async autoRoute(messages: ChatMessage[]): Promise<ChatResponse & { routing?: RoutingMeta }> {
    const startTime = Date.now();

    const routingModel = assignModel("decision");
    if (!routingModel) {
      logger.warn("[AutoRoute] No decision model configured, falling back to general-chat");
      const fallback = await this.chat("general-chat", messages);
      return { ...fallback, routing: { role: "general-chat", thinking: "none", reason: "无决策模型配置" } };
    }

    const routingMessages: ChatMessage[] = [
      {
        role: "system",
        content: `你是一个任务路由专家。分析用户请求，输出 JSON 格式的路由决策。

可用角色:
- coding: 代码生成、重构、调试
- review: 代码审查、质量评估
- research: 技术研究、知识查询
- architecture: 架构设计、系统规划
- decision: 决策分析、方案比较
- general-chat: 一般对话、解释说明

思考强度:
- none: 简单任务，直接回答
- low: 标准思考，平衡速度和质量
- medium: 复杂任务，需要多步推理
- high: 非常困难的任务，深度分析

输出格式:
{
  "role": "角色名称",
  "thinking": "none/low/medium/high",
  "reason": "简要说明选择理由"
}`,
      },
      messages[messages.length - 1],
    ];

    try {
      const model = routingModel.model;
      const flashResponse = await callProvider(model.provider, model.model, routingMessages, 10000);
      const routing = this.parseRoutingDecision(flashResponse.content);

      logger.info("[AutoRoute] Routing decision", {
        role: routing.role,
        thinking: routing.thinking,
        reason: routing.reason,
        model: model.id,
      });

      trackCall(model.id, model.provider, routingMessages, { latencyMs: Date.now() - startTime, success: true }, { role: "decision", taskType: "auto_route" });

      const result = await this.executeWithRole(routing.role, messages);

      return {
        content: result.content,
        model: result.model,
        provider: result.provider,
        usage: result.usage,
        layer: "general",
        routing: {
          role: routing.role,
          thinking: routing.thinking,
          reason: routing.reason,
        },
      };
    } catch (error) {
      logger.warn("[AutoRoute] Routing failed, falling back to general-chat", { error: (error as Error).message });
      const fallback = await this.chat("general-chat", messages);
      return { ...fallback, routing: { role: "general-chat", thinking: "none", reason: "路由失败，使用默认回退" } };
    }
  }

  parseRoutingDecision(content: string | null): RoutingMeta {
    const defaultResult: RoutingMeta = { role: "general-chat", thinking: "none", reason: "解析失败，使用默认值" };
    if (!content) {
      logger.warn("[AutoRoute] Empty content from decision model, using default route");
      return defaultResult;
    }

    try {
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        try {
          const parsed = JSON.parse(jsonMatch[0]);
          return {
            role: (parsed.role as TaskRole) || defaultResult.role,
            thinking: parsed.thinking || defaultResult.thinking,
            reason: parsed.reason || defaultResult.reason,
          };
        } catch (jsonErr) {
          logger.warn("[AutoRoute] JSON.parse failed on extracted block", {
            snippet: jsonMatch[0].slice(0, 200),
            error: (jsonErr as Error).message,
          });
        }
      } else {
        logger.warn("[AutoRoute] No JSON block found in decision model output", {
          snippet: content.slice(0, 200),
        });
      }
    } catch {
      const lower = content.toLowerCase();
      if (lower.includes("code") || lower.includes("编码") || lower.includes("代码")) return { role: "coding", thinking: "medium", reason: "关键词匹配: code" };
      if (lower.includes("review") || lower.includes("审查")) return { role: "review", thinking: "medium", reason: "关键词匹配: review" };
      if (lower.includes("arch") || lower.includes("架构")) return { role: "architecture", thinking: "high", reason: "关键词匹配: architecture" };
      if (lower.includes("research") || lower.includes("调研")) return { role: "research", thinking: "high", reason: "关键词匹配: research" };
    }

    return defaultResult;
  }

  // ---------------------------------------------------------------------------
  // Embeddings
  // ---------------------------------------------------------------------------

  async embeddings(texts: string[]): Promise<number[][]> {
    const models = findModelsForRole("embedding");
    if (models.length === 0) throw new Error("No embedding route configured");
    const model = models[0];

    const config = PROVIDER_CONFIG[model.provider as keyof typeof PROVIDER_CONFIG];
    const apiKey = getEffectiveApiKey(model.provider, config.apiKeyEnv);
    if (!apiKey) throw new Error(`Missing API key for embedding`);

    const baseURL = getEffectiveBaseURL(model.provider, config.apiKeyEnv, config.baseURL);

    const res = await proxyFetch(`${baseURL}/embeddings`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ model: model.model, input: texts }),
    });

    if (!res.ok) throw new Error(`Embedding request failed: ${res.status}`);
    const data = await res.json();
    return data.data?.map((d: any) => d.embedding) ?? [];
  }

  // ---------------------------------------------------------------------------
  // 智能任务分配
  // ---------------------------------------------------------------------------

  assign(role: TaskRole, opts?: { excludeModels?: string[] }): AssignmentResult {
    const result = assignModel(role, { excludeModels: opts?.excludeModels });
    if (!result) throw new Error(`No model found for role: ${role}`);
    return result;
  }

  async executeWithRole(role: TaskRole, messages: ChatMessage[], options?: { temperature?: number; maxTokens?: number; excludeModels?: string[] }): Promise<SmartAssignmentResponse> {
    const startTime = Date.now();
    const assignment = this.assign(role, { excludeModels: options?.excludeModels });
    const model = assignment.model;

    const config = PROVIDER_CONFIG[model.provider as keyof typeof PROVIDER_CONFIG];
    try {
      const response = await callProvider(model.provider, model.model, messages, 60000, options?.temperature);
      const latencyMs = Date.now() - startTime;
      const result: SmartAssignmentResponse = {
        role,
        model: model.id,
        provider: model.provider,
        endpoint: config?.baseURL ?? "",
        content: response.content,
        usage: response.usage,
        latency_ms: latencyMs,
        fallback_used: false,
      };
      trackCall(model.id, model.provider, messages, { usage: response.usage, latencyMs, success: true }, { role, taskType: role });
      return result;
    } catch (error) {
      const fallbackResult = await this.executeFallback(role, messages, options);
      const latencyMs = Date.now() - startTime;
      trackCall(model.id, model.provider, messages, { latencyMs, success: false, fallbackUsed: true }, { role, taskType: role });
      return { ...fallbackResult, latency_ms: latencyMs, fallback_used: true };
    }
  }

  async batchExecute(assignments: RoleAssignment[], opts?: { preventDuplicateModels?: boolean }): Promise<SmartAssignmentResponse[]> {
    const usedModels: string[] = [];
    const promises = assignments.map((a) => {
      const exclude = opts?.preventDuplicateModels ? [...usedModels] : undefined;
      return this.executeWithRole(a.role, a.messages, {
        temperature: a.temperature,
        maxTokens: a.maxTokens,
        excludeModels: exclude,
      }).then((res) => {
        if (opts?.preventDuplicateModels) usedModels.push(res.model);
        return res;
      }).catch((err) => ({
        role: a.role,
        model: "error",
        provider: "error",
        endpoint: "",
        content: `Error: ${err.message}`,
        latency_ms: 0,
        fallback_used: true,
      }));
    });
    return Promise.all(promises);
  }

  async executeFallback(role: TaskRole, messages: ChatMessage[], _options?: { temperature?: number; maxTokens?: number }): Promise<SmartAssignmentResponse> {
    try {
      const fallbackModels = findModelsForRole(role);
      if (fallbackModels.length === 0) {
        throw new Error(`No models available for role: ${role}`);
      }
      const fallbackModel = fallbackModels[0];
      const config = PROVIDER_CONFIG[fallbackModel.provider as keyof typeof PROVIDER_CONFIG];
      const response = await callProvider(fallbackModel.provider, fallbackModel.model, messages, TIMEOUTS.API_DEFAULT);
      return {
        role,
        model: fallbackModel.id,
        provider: fallbackModel.provider,
        endpoint: config?.baseURL ?? "",
        content: response.content,
        latency_ms: 0,
        fallback_used: true,
      };
    } catch {
      return {
        role,
        model: "local",
        provider: "local",
        endpoint: "",
        content: `[System] All models for role "${role}" are unavailable. Please try again later.`,
        latency_ms: 0,
        fallback_used: true,
      };
    }
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

export const router = new MultiPlatformRouter();
export { toolPool, type ToolRole };
