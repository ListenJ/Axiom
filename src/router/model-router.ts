/**
 * 多平台分层模型路由器 v3.0
 *
 * 架构分层:
 *   L1 Decision    - 主力决策模型: DeepSeek-V4 Pro
 *   L2 Architecture- 系统架构设计: Kimi-2.6
 *   L3 Tool Pool   - 免费工具模型池（编码/英文/RL/通用），带限流和熔断
 *   L4 Evaluation  - 评估层: Tencent hy3-preview ($5额度) + DeepSeek 联合评估
 *
 * 网关支持:
 *   - OpenRouter: https://openrouter.ai/api/v1 (免费模型主力平台)
 *   - DeepSeek:   https://api.deepseek.com/v1 (官方 DeepSeek-V4 Pro)
 *   - SiliconFlow: https://api.siliconflow.cn/v1
 *   - OfoxAI:      https://api.ofox.ai/v1
 *   - OpenCode:    https://api.opencode.ai/v1
 *   - Kimi Code:   https://api.kimi.com/coding/v1
 */

import { logger } from "../utils/logger.js";
import { toolPool, type ToolRole } from "./tool-pool.js";
import { getCircuitBreaker, withFallback, withRetry, isRetryableError } from "../utils/resilience.js";
import { assignModel, type TaskRole, type AssignmentResult, type ModelCapability } from "./model-capability-registry.js";
import { claudeCode } from "../utils/claude-code-adapter.js";
import { kimiCode } from "../utils/kimi-code-adapter.js";

interface ModelRoute {
  provider: string;
  model: string;
  priority: number;
  maxRetries: number;
  timeout: number;
}

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

// ========== 静态路由配置表 ==========
const MODEL_ROUTES: Record<string, ModelRoute[]> = {
  // L1 决策层 - 主力决策模型
  decision: [
    {
      provider: "deepseek",
      model: "deepseek-v4-pro",
      priority: 1,
      maxRetries: 2,
      timeout: 60000,
    },
  ],

  // L2 架构层 - 系统架构设计
  architecture: [
    {
      provider: "openrouter",
      model: "moonshotai/kimi-k2.6",
      priority: 0,
      maxRetries: 2,
      timeout: 60000,
    },
    {
      provider: "openrouter",
      model: "moonshotai/kimi-k2.6:free",
      priority: 1,
      maxRetries: 2,
      timeout: 60000,
    },
  ],

  // L4 评估层 - 付费评估 + 联合决策
  evaluation: [
    {
      provider: "openrouter",
      model: "tencent/hy3-preview",
      priority: 0,
      maxRetries: 1,
      timeout: 60000,
    },
    {
      provider: "deepseek",
      model: "deepseek-v4-pro",
      priority: 1,
      maxRetries: 2,
      timeout: 60000,
    },
  ],

  // 向后兼容路由
  "general-chat": [
    {
      provider: "openrouter",
      model: "deepseek/deepseek-v4-flash:free",
      priority: 0,
      maxRetries: 2,
      timeout: 20000,
    },
    {
      provider: "ofoxai",
      model: "z-ai/glm-4.7-flash:free",
      priority: 1,
      maxRetries: 2,
      timeout: 15000,
    },
    {
      provider: "siliconflow",
      model: "Qwen/Qwen2-7B-Instruct",
      priority: 2,
      maxRetries: 2,
      timeout: 10000,
    },
  ],

  "code-generation": [
    {
      provider: "kimi",
      model: "kimi-for-coding",
      priority: 0,
      maxRetries: 2,
      timeout: 60000,
    },
    {
      provider: "openrouter",
      model: "deepseek/deepseek-v4-flash:free",
      priority: 1,
      maxRetries: 2,
      timeout: 30000,
    },
    {
      provider: "openrouter",
      model: "qwen/qwen3-coder-480b-a35b-instruct-turbo:free",
      priority: 2,
      maxRetries: 2,
      timeout: 25000,
    },
    {
      provider: "deepseek",
      model: "deepseek-v4-flash",
      priority: 3,
      maxRetries: 2,
      timeout: 30000,
    },
  ],

  embedding: [
    {
      provider: "siliconflow",
      model: "BAAI/bge-large-zh",
      priority: 0,
      maxRetries: 2,
      timeout: 10000,
    },
  ],
};

// ========== 平台配置 ==========
const PROVIDER_CONFIG: Record<
  string,
  { baseURL: string; apiKeyEnv: string; protocol?: "openai" | "anthropic" | "gemini" }
> = {
  siliconflow: {
    baseURL: process.env.SILICONFLOW_BASE_URL || "https://api.siliconflow.cn/v1",
    apiKeyEnv: "SILICONFLOW_API_KEY",
  },
  ofoxai: {
    baseURL: process.env.OFOXAI_BASE_URL || "https://api.ofox.ai/v1",
    apiKeyEnv: "OFOXAI_API_KEY",
    protocol: "openai",
  },
  "ofoxai-anthropic": {
    baseURL: process.env.OFOXAI_ANTHROPIC_BASE_URL || "https://api.ofox.ai/anthropic",
    apiKeyEnv: "OFOXAI_API_KEY",
    protocol: "anthropic",
  },
  "ofoxai-gemini": {
    baseURL: process.env.OFOXAI_GEMINI_BASE_URL || "https://api.ofox.ai/gemini",
    apiKeyEnv: "OFOXAI_API_KEY",
    protocol: "gemini",
  },
  openrouter: {
    baseURL: process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1",
    apiKeyEnv: "OPENROUTER_API_KEY",
  },
  deepseek: {
    baseURL: process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com/v1",
    apiKeyEnv: "DEEPSEEK_API_KEY",
  },
  opencode: {
    baseURL: process.env.OPENCODE_BASE_URL || "https://api.opencode.ai/v1",
    apiKeyEnv: "OPENCODE_API_KEY",
  },
  kimi: {
    baseURL: process.env.KIMI_CODE_BASE_URL || "https://api.kimi.com/coding/v1",
    apiKeyEnv: "KIMI_CODE_API_KEY",
    protocol: "openai",
  },
};

// ========== 分层路由器 ==========
class MultiPlatformRouter {
  // ---- L1 决策层 ----
  async decide(messages: ChatMessage[]): Promise<ChatResponse> {
    const result = await this.chat("decision", messages);
    return { ...result, layer: "decision" };
  }

  // ---- L2 架构层 ----
  async architect(messages: ChatMessage[]): Promise<ChatResponse> {
    const result = await this.chat("architecture", messages);
    return { ...result, layer: "architecture" };
  }

  // ---- L3 工具层（免费模型池，带限流 + 熔断） ----
  async tool(role: ToolRole, messages: ChatMessage[]): Promise<ChatResponse> {
    const maxAttempts = 3;
    let lastError: Error | undefined;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const model = toolPool.selectNext(role);
      if (!model) {
        logger.warn(`[Router] No available tool model for role ${role}, attempt ${attempt + 1}`);
        break;
      }

      const cb = getCircuitBreaker(`${model.provider}:${model.id}`, {
        failureThreshold: 3,
        resetTimeout: 20000,
      });

      toolPool.markRequestStart(model.id);
      logger.info(`[Router] Tool call ${role}`, {
        model: model.id,
        attempt: attempt + 1,
      });

      try {
        const response = await cb.execute(() =>
          this.callProvider(model.provider, model.id, messages, 30000)
        );
        toolPool.markRequestSuccess(model.id);
        return {
          ...response,
          model: model.id,
          provider: model.provider,
          layer: "tool",
        };
      } catch (error: any) {
        toolPool.markRequestFailure(model.id, error.message);
        lastError = error;
        logger.warn(
          `[Router] Tool model ${model.id} failed (attempt ${attempt + 1})`,
          { error: error.message }
        );
        // 指数退避
        await this.delay(Math.min(1000 * Math.pow(2, attempt), 5000));
      }
    }

    // 降级：返回静态响应
    logger.error(`[Router] All tool models exhausted for role: ${role}, returning degraded response`);
    return {
      content: `Tool execution failed for ${role}. Please retry or check model availability.`,
      model: "degraded",
      provider: "local",
      layer: "tool",
    };
  }

  // ---- L4 评估层 ----
  async evaluate(messages: ChatMessage[]): Promise<ChatResponse> {
    const result = await this.chat("evaluation", messages);
    return { ...result, layer: "evaluation" };
  }

  // ---- 通用聊天（向后兼容） ----
  async chat(taskType: string, messages: ChatMessage[]): Promise<ChatResponse> {
    const routes = MODEL_ROUTES[taskType];
    if (!routes) throw new Error(`Unknown task type: ${taskType}`);

    const sortedRoutes = routes.sort((a, b) => a.priority - b.priority);

    for (const route of sortedRoutes) {
      const cb = getCircuitBreaker(route.provider, {
        failureThreshold: 3,
        resetTimeout: 30000,
      });

      try {
        const response = await cb.execute(() =>
          withRetry(
            () => this.callProvider(route.provider, route.model, messages, route.timeout),
            {
              maxAttempts: route.maxRetries + 1,
              baseDelay: 1000,
              maxDelay: 10000,
              retryable: isRetryableError,
              onRetry: (err, attempt) => {
                logger.warn(`[Router] Retry ${attempt} for ${route.provider}/${route.model}`, {
                  error: err.message,
                });
              },
            }
          )
        );
        return {
          content: response.content,
          model: route.model,
          provider: route.provider,
          usage: response.usage,
          layer: "general",
        };
      } catch (error: any) {
        if (error.name === "CircuitOpenError") {
          logger.warn(`[Router] Circuit open for ${route.provider}, skipping`);
        } else {
          logger.warn(`[Router] Route failed ${route.provider}/${route.model}`, { error: error.message });
        }
      }
    }

    // 降级：返回本地缓存或静态响应
    logger.error("[Router] All model routes exhausted, returning degraded response");
    return {
      content: "I'm currently experiencing high load. Please try again in a moment.",
      model: "degraded",
      provider: "local",
      layer: "general",
    };
  }

  // ---- 按意图自动路由到对应层级 ----
  async routeByIntent(
    intent: string,
    messages: ChatMessage[],
    options?: { preferTool?: boolean }
  ): Promise<ChatResponse> {
    // L1: 需要深度决策的意图
    if (["strategy", "evaluation", "decision"].includes(intent)) {
      return this.decide(messages);
    }

    // L2: 架构设计类意图
    if (["architecture", "system-design", "infra"].includes(intent)) {
      return this.architect(messages);
    }

    // L3: 工具层（编码/英文/RL）
    if (options?.preferTool !== false) {
      if (["engineering", "game-development", "integrations", "testing"].includes(intent)) {
        return this.tool("coding", messages);
      }
      if (["english", "translation", "localization"].includes(intent)) {
        return this.tool("english", messages);
      }
      if (["rl", "reasoning", "optimization"].includes(intent)) {
        return this.tool("rl", messages);
      }
    }

    // 默认走通用层
    const taskType = ["engineering", "game-development", "integrations", "testing"].includes(
      intent
    )
      ? "code-generation"
      : "general-chat";
    return this.chat(taskType, messages);
  }

  // ---- 内部调用实现 ----
  private async callProvider(
    provider: string,
    model: string,
    messages: ChatMessage[],
    timeoutMs: number
  ): Promise<{ content: string | null; usage?: any }> {
    const config = PROVIDER_CONFIG[provider];
    if (!config) throw new Error(`Unknown provider: ${provider}`);

    const apiKey = process.env[config.apiKeyEnv];
    if (!apiKey) throw new Error(`Missing API key for ${provider}: ${config.apiKeyEnv}`);

    const protocol = config.protocol || "openai";

    if (protocol === "anthropic") {
      return this.callAnthropic(config.baseURL, apiKey, model, messages, timeoutMs);
    }
    if (protocol === "gemini") {
      return this.callGemini(config.baseURL, apiKey, model, messages, timeoutMs);
    }
    return this.callOpenAICompatible(config.baseURL, apiKey, model, messages, timeoutMs, provider);
  }

  private async callOpenAICompatible(
    baseURL: string,
    apiKey: string,
    model: string,
    messages: ChatMessage[],
    timeoutMs: number,
    provider: string
  ): Promise<{ content: string | null; usage?: any }> {
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
        body: JSON.stringify({
          model,
          messages,
          temperature: 0.7,
        }),
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

  private async callAnthropic(
    baseURL: string,
    apiKey: string,
    model: string,
    messages: ChatMessage[],
    timeoutMs: number
  ): Promise<{ content: string | null; usage?: any }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const systemMsg = messages.find((m) => m.role === "system")?.content || "";
      const chatMessages = messages
        .filter((m) => m.role !== "system")
        .map((m) => ({ role: m.role, content: m.content }));

      const res = await fetch(`${baseURL}/v1/messages`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model,
          max_tokens: 4096,
          system: systemMsg,
          messages: chatMessages,
        }),
        signal: controller.signal,
      });

      clearTimeout(timer);

      if (!res.ok) {
        const errText = await res.text();
        throw new Error(`HTTP ${res.status}: ${errText}`);
      }

      const data = await res.json();
      return {
        content: data.content?.[0]?.text ?? null,
        usage: data.usage,
      };
    } catch (e) {
      clearTimeout(timer);
      throw e;
    }
  }

  private async callGemini(
    baseURL: string,
    apiKey: string,
    model: string,
    messages: ChatMessage[],
    timeoutMs: number
  ): Promise<{ content: string | null; usage?: any }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const contents = messages.map((m) => ({
        role: m.role === "assistant" ? "model" : "user",
        parts: [{ text: m.content }],
      }));

      const res = await fetch(
        `${baseURL}/v1beta/models/${model}:generateContent?key=${apiKey}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ contents }),
          signal: controller.signal,
        }
      );

      clearTimeout(timer);

      if (!res.ok) {
        const errText = await res.text();
        throw new Error(`HTTP ${res.status}: ${errText}`);
      }

      const data = await res.json();
      return {
        content: data.candidates?.[0]?.content?.parts?.[0]?.text ?? null,
        usage: data.usageMetadata,
      };
    } catch (e) {
      clearTimeout(timer);
      throw e;
    }
  }

  async embeddings(texts: string[]): Promise<number[][]> {
    const route = MODEL_ROUTES["embedding"]?.[0];
    if (!route) throw new Error("No embedding route configured");

    const config = PROVIDER_CONFIG[route.provider];
    const apiKey = process.env[config.apiKeyEnv];
    if (!apiKey) throw new Error(`Missing API key for embedding`);

    const res = await fetch(`${config.baseURL}/embeddings`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: route.model,
        input: texts,
      }),
    });

    if (!res.ok) throw new Error(`Embedding request failed: ${res.status}`);
    const data = await res.json();
    return data.data?.map((d: any) => d.embedding) ?? [];
  }

  // ========== 智能任务分配 (v4.0) ==========
  /**
   * 为指定角色智能分配最优模型
   * @param role - 任务角色
   * @returns 分配结果（模型信息 + 端点）
   */
  assign(role: TaskRole): AssignmentResult {
    const result = assignModel(role);
    if (!result) {
      throw new Error(`No model found for role: ${role}`);
    }
    return result;
  }

  /**
   * 使用指定角色执行对话
   * @param role - 任务角色
   * @param messages - 对话消息
   * @param options - 可选参数 (temperature, maxTokens)
   * @returns 智能分配响应
   */
  async executeWithRole(
    role: TaskRole,
    messages: ChatMessage[],
    options?: { temperature?: number; maxTokens?: number }
  ): Promise<SmartAssignmentResponse> {
    const startTime = Date.now();
    const assignment = this.assign(role);

    const model = assignment.model;

    // 特殊处理：Claude Code 通过 CLI
    if (model.provider === "claude-code") {
      try {
        const result = await claudeCode.execute(
          messages[messages.length - 1]?.content ?? "",
          { outputFormat: "text" }
        );
        return {
          role,
          model: model.id,
          provider: model.provider,
          endpoint: "local-cli",
          content: result.content,
          latency_ms: Date.now() - startTime,
          fallback_used: false,
        };
      } catch (error) {
        // 降级到 DeepSeek Pro
        const fallback = this.callProvider("deepseek", "deepseek-v4-pro", messages, 60000);
        const response = await fallback;
        return {
          role,
          model: "deepseek-v4-pro",
          provider: "deepseek",
          endpoint: "https://api.deepseek.com/v1",
          content: response.content,
          latency_ms: Date.now() - startTime,
          fallback_used: true,
        };
      }
    }

    // 特殊处理：Kimi Code 通过 API
    if (model.provider === "kimi-code") {
      try {
        const result = await kimiCode.chat(
          messages.map((m) => ({ role: m.role, content: m.content })),
          { temperature: options?.temperature ?? 0.6, maxTokens: options?.maxTokens ?? 4096 }
        );
        return {
          role,
          model: model.id,
          provider: model.provider,
          endpoint: "https://api.kimi.com/coding/v1",
          content: result.content,
          usage: result.usage,
          latency_ms: Date.now() - startTime,
          fallback_used: false,
        };
      } catch (error) {
        const fallback = this.callProvider("openrouter", "qwen/qwen3-0309-coder:free", messages, 30000);
        const response = await fallback;
        return {
          role,
          model: "qwen/qwen3-0309-coder:free",
          provider: "openrouter",
          endpoint: "https://openrouter.ai/api/v1",
          content: response.content,
          latency_ms: Date.now() - startTime,
          fallback_used: true,
        };
      }
    }

    // 标准 HTTP 调用
    try {
      const response = await withRetry(
        () => this.callProvider(model.provider, model.id, messages, 60000),
        {
          maxAttempts: 3,
          baseDelay: 1000,
          retryable: (err: any) => isRetryableError(err),
        }
      );
      return {
        role,
        model: model.id,
        provider: model.provider,
        endpoint: model.provider === "openrouter" ? "https://openrouter.ai/api/v1" : model.provider === "deepseek" ? "https://api.deepseek.com/v1" : "https://api.siliconflow.cn/v1",
        content: response.content,
        usage: response.usage,
        latency_ms: Date.now() - startTime,
        fallback_used: false,
      };
    } catch (error) {
      // 使用能力注册表的降级链
      const fallbackResult = await this.executeFallback(role, messages, options);
      return {
        ...fallbackResult,
        latency_ms: Date.now() - startTime,
        fallback_used: true,
      };
    }
  }

  /**
   * 批量并行执行多角色任务
   * @param assignments - 角色分配列表
   * @returns 并行执行结果
   */
  async batchExecute(
    assignments: RoleAssignment[]
  ): Promise<SmartAssignmentResponse[]> {
    const promises = assignments.map((a) =>
      this.executeWithRole(a.role, a.messages, {
        temperature: a.temperature,
        maxTokens: a.maxTokens,
      }).catch((err) => ({
        role: a.role,
        model: "error",
        provider: "error",
        endpoint: "",
        content: `Error: ${err.message}`,
        latency_ms: 0,
        fallback_used: true,
      }))
    );
    return Promise.all(promises);
  }

  /**
   * 降级执行
   */
  private async executeFallback(
    role: TaskRole,
    messages: ChatMessage[],
    options?: { temperature?: number; maxTokens?: number }
  ): Promise<SmartAssignmentResponse> {
    // 通用降级到 openrouter 免费模型
    try {
      const response = await this.callProvider(
        "openrouter",
        "qwen/qwen3-0309-coder:free",
        messages,
        30000
      );
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
