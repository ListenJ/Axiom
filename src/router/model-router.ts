/**
 * 多平台模型路由器 v4.0 (简化版)
 *
 * 核心原则:
 *   - 单一 OpenAI 兼容 API
 *   - 静态配置表 + 简单 fallback
 *   - 无 circuit breaker, 无 protocol 适配层
 */

import { logger } from "../utils/logger.js";
import { toolPool, type ToolRole } from "./tool-pool.js";
import { assignModel, type TaskRole, type AssignmentResult, type ModelCapability } from "./model-capability-registry.js";
import { PROVIDER_CONFIG, findModelsForRole, getFallbackChain, type UnifiedModel } from "./models.js";
import { getTokenTracker } from "./token-tracker.js";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface ChatResponse {
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

// ========== 智能任务分配接口 ==========
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

export interface RoleAssignment {
  role: TaskRole;
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
}

// ========== Token 追踪辅助 ==========
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
  if (!usage || !usage.total_tokens) return; // 不追踪无 usage 的记录

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

// ========== 通用 HTTP 调用 ==========
async function callProvider(
  provider: string,
  model: string,
  messages: ChatMessage[],
  timeoutMs: number
): Promise<{ content: string | null; usage?: any }> {
  const config = PROVIDER_CONFIG[provider as keyof typeof PROVIDER_CONFIG];
  if (!config) throw new Error(`Unknown provider: ${provider}`);

  // 优先使用运行时 override，其次使用 process.env（支持前端 Settings 页面运行时设置）
  const { getEffectiveApiKey, getEffectiveBaseURL } = await import("../utils/api-key-store.js");
  const apiKey = getEffectiveApiKey(provider, config.apiKeyEnv);
  if (!apiKey) throw new Error(`Missing API key for ${provider}: ${config.apiKeyEnv}`);

  const baseURL = getEffectiveBaseURL(provider, config.apiKeyEnv, config.baseURL);

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

    const res = await fetch(`${baseURL}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify({ model, messages, temperature: 0.7 }),
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

// ========== 路由器 ==========
class MultiPlatformRouter {
  async decide(messages: ChatMessage[]): Promise<ChatResponse> {
    const result = await this.chat("decision", messages);
    return { ...result, layer: "decision" };
  }

  async architect(messages: ChatMessage[]): Promise<ChatResponse> {
    const result = await this.chat("architecture", messages);
    return { ...result, layer: "architecture" };
  }

  async tool(role: ToolRole, messages: ChatMessage[]): Promise<ChatResponse> {
    const maxAttempts = 3;
    let lastError: Error | undefined;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const model = toolPool.selectNext(role);
      if (!model) break;

      toolPool.markRequestStart(model.id);
      const startTime = Date.now();

      try {
        const response = await callProvider(model.provider, model.id, messages, 30000);
        const latencyMs = Date.now() - startTime;
        toolPool.recordLatency(model.id, latencyMs);
        toolPool.markRequestSuccess(model.id);
        const result: ChatResponse = { ...response, model: model.id, provider: model.provider, layer: "tool" };
        trackCall(model.id, model.provider, messages, { usage: response.usage, latencyMs, success: true }, { role, taskType: "tool" });
        return result;
      } catch (error: any) {
        toolPool.markRequestFailure(model.id, error.message);
        lastError = error;
        trackCall(model.id, model.provider, messages, { latencyMs: Date.now() - startTime, success: false }, { role, taskType: "tool" });
        logger.warn(`[Router] Tool ${model.id} failed (attempt ${attempt + 1})`, { error: error.message });
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

  async evaluate(messages: ChatMessage[]): Promise<ChatResponse> {
    const result = await this.chat("evaluation", messages);
    return { ...result, layer: "evaluation" };
  }

  async chat(taskType: string, messages: ChatMessage[]): Promise<ChatResponse> {
    const models = findModelsForRole(taskType as any);
    if (models.length === 0) throw new Error(`Unknown task type: ${taskType}`);

    const sortedModels = [...models].sort((a, b) => (a.priority ?? 99) - (b.priority ?? 99));

    for (const model of sortedModels) {
      const startTime = Date.now();
      try {
        const response = await callProvider(model.provider, model.model, messages, model.timeout ?? 60000);
        const latencyMs = Date.now() - startTime;
        const result: ChatResponse = { content: response.content, model: model.model, provider: model.provider, usage: response.usage, layer: "general" };
        trackCall(model.model, model.provider, messages, { usage: response.usage, latencyMs, success: true }, { role: taskType, taskType });
        return result;
      } catch (error: any) {
        logger.warn(`[Router] Route failed ${model.provider}/${model.model}`, { error: error.message });
        trackCall(model.model, model.provider, messages, { latencyMs: Date.now() - startTime, success: false }, { role: taskType, taskType });
      }
    }

    logger.error("[Router] All model routes exhausted, returning degraded response");
    return {
      content: "I'm currently experiencing high load. Please try again in a moment.",
      model: "degraded",
      provider: "local",
      layer: "general",
    };
  }

  async routeByIntent(intent: string, messages: ChatMessage[], options?: { preferTool?: boolean }): Promise<ChatResponse> {
    const DECISION_INTENTS = new Set(["strategy", "evaluation", "decision"]);
    const ARCH_INTENTS = new Set(["architecture", "system-design", "infra"]);
    const CODE_INTENTS = new Set(["engineering", "game-development", "integrations", "testing"]);
    const ENG_INTENTS = new Set(["english", "translation", "localization"]);
    const RL_INTENTS = new Set(["rl", "reasoning", "optimization"]);

    if (DECISION_INTENTS.has(intent)) return this.decide(messages);
    if (ARCH_INTENTS.has(intent)) return this.architect(messages);

    if (options?.preferTool !== false) {
      if (CODE_INTENTS.has(intent)) return this.tool("coding", messages);
      if (ENG_INTENTS.has(intent)) return this.tool("english", messages);
      if (RL_INTENTS.has(intent)) return this.tool("rl", messages);
    }

    const taskType = CODE_INTENTS.has(intent) ? "code-generation" : "general-chat";
    return this.chat(taskType, messages);
  }

  /**
   * Auto Route — 使用廉价模型做 per-turn 路由决策 (CodeWhale-inspired)
   *
   * 1. 用 deepseek-v4-flash:free 分析用户输入
   * 2. 决定: 任务类型、角色、思考强度
   * 3. 路由到适当的模型执行
   *
   * 比静态规则更准确，成本极低（flash 模型几乎免费）
   */
  async autoRoute(messages: ChatMessage[]): Promise<ChatResponse & { routing?: { role: TaskRole; thinking: string; reason: string } }> {
    const startTime = Date.now();

    // 构建路由提示词
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
      messages[messages.length - 1], // 只取最后一条用户消息做路由
    ];

    try {
      // 使用廉价 flash 模型做路由决策
      const flashResponse = await callProvider("openrouter", "deepseek/deepseek-v4-flash:free", routingMessages, 10000);
      const routing = this.parseRoutingDecision(flashResponse.content);

      logger.info("[AutoRoute] Routing decision", {
        role: routing.role,
        thinking: routing.thinking,
        reason: routing.reason,
      });

      // 跟踪路由调用
      trackCall("deepseek/deepseek-v4-flash:free", "openrouter", routingMessages, { latencyMs: Date.now() - startTime, success: true }, { role: "decision", taskType: "auto_route" });

      // 根据路由决策执行
      const result = await this.executeWithRole(routing.role as TaskRole, messages);

      return {
        content: result.content,
        model: result.model,
        provider: result.provider,
        usage: result.usage,
        layer: "general",
        routing: {
          role: routing.role as TaskRole,
          thinking: routing.thinking,
          reason: routing.reason,
        },
      };
    } catch (error) {
      logger.warn("[AutoRoute] Routing failed, falling back to general-chat", { error: (error as Error).message });
      // 路由失败时回退到通用聊天
      const fallback = await this.chat("general-chat", messages);
      return { ...fallback, routing: { role: "general-chat" as TaskRole, thinking: "none", reason: "路由失败，使用默认回退" } };
    }
  }

  private parseRoutingDecision(content: string | null): { role: string; thinking: string; reason: string } {
    const defaultResult = { role: "general-chat", thinking: "none", reason: "解析失败，使用默认值" };
    if (!content) return defaultResult;

    try {
      // 尝试提取 JSON
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        return {
          role: parsed.role || defaultResult.role,
          thinking: parsed.thinking || defaultResult.thinking,
          reason: parsed.reason || defaultResult.reason,
        };
      }
    } catch {
      // JSON 解析失败，使用关键词匹配
      const lower = content.toLowerCase();
      if (lower.includes("code") || lower.includes("编码") || lower.includes("代码")) return { role: "coding", thinking: "medium", reason: "关键词匹配: code" };
      if (lower.includes("review") || lower.includes("审查")) return { role: "review", thinking: "medium", reason: "关键词匹配: review" };
      if (lower.includes("arch") || lower.includes("架构")) return { role: "architecture", thinking: "high", reason: "关键词匹配: architecture" };
      if (lower.includes("research") || lower.includes("调研")) return { role: "research", thinking: "high", reason: "关键词匹配: research" };
    }

    return defaultResult;
  }

  async embeddings(texts: string[]): Promise<number[][]> {
    const models = findModelsForRole("embedding" as any);
    if (models.length === 0) throw new Error("No embedding route configured");
    const model = models[0];

    const config = PROVIDER_CONFIG[model.provider as keyof typeof PROVIDER_CONFIG];
    const { getEffectiveApiKey, getEffectiveBaseURL } = await import("../utils/api-key-store.js");
    const apiKey = getEffectiveApiKey(model.provider, config.apiKeyEnv);
    if (!apiKey) throw new Error(`Missing API key for embedding`);

    const baseURL = getEffectiveBaseURL(model.provider, config.apiKeyEnv, config.baseURL);

    const res = await fetch(`${baseURL}/embeddings`, {
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

  // ========== 智能任务分配 (简化版) ==========
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
      const response = await callProvider(model.provider, model.model, messages, 60000);
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

  private async executeFallback(role: TaskRole, messages: ChatMessage[], _options?: { temperature?: number; maxTokens?: number }): Promise<SmartAssignmentResponse> {
    try {
      const response = await callProvider("openrouter", "qwen/qwen3-0309-coder:free", messages, 30000);
      return {
        role,
        model: "qwen/qwen3-0309-coder:free",
        provider: "openrouter",
        endpoint: "https://openrouter.ai/api/v1",
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
