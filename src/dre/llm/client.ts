/**
 * DRE LLM 客户端
 *
 * 特性:
 * - 强约束生成 (JSON Schema + logits bias)
 * - 拒绝采样 (n 次取众数)
 * - 温度=0 保证确定性
 * - 固定种子保证回放
 * - 支持 llama.cpp HTTP API
 */

import { logger } from "../../utils/logger.js";
import { getModelOutputStore } from "../../utils/model-output-store.js";
import { llmCache, llmCacheKey } from "../../utils/cache.js";
import { clampMaxTokens, getResourceBudgetManager } from "../system-resource.js";
import { DRELLMError } from "../errors.js";

/** 重试配置 */
export interface RetryConfig {
  maxRetries: number;             // 最大重试次数 (不含首次), 默认 2
  baseDelayMs: number;            // 初始退避延迟, 默认 200ms
  maxDelayMs: number;             // 最大退避延迟, 默认 2000ms
  retryableStatusCodes: Set<number>; // 可重试的 HTTP 状态码
}

/** 熔断器配置 */
export interface CircuitBreakerConfig {
  failureThreshold: number;       // 连续失败阈值, 默认 5
  cooldownMs: number;             // 熔断后冷却时间, 默认 30000ms
}

/** 熔断器状态 */
export type CircuitState = "closed" | "open" | "half-open";

/** LLM 调用统计 */
export interface LLMStats {
  totalCalls: number;
  successCount: number;
  failureCount: number;
  retryCount: number;
  circuitState: CircuitState;
  consecutiveFailures: number;
}

/** LLM 配置 */
export interface LLMConfig {
  baseUrl: string;          // llama.cpp server URL
  model: string;            // 模型名称
  apiKey?: string;          // API Key (可选)
  temperature?: number;     // 默认 0.0
  topK?: number;            // 默认 1
  seed?: number;            // 默认 42
  maxTokens?: number;       // 默认 512
  timeout?: number;         // 默认 120000ms
  retry?: Partial<RetryConfig>;     // 重试配置
  circuitBreaker?: Partial<CircuitBreakerConfig>; // 熔断器配置
  chatTemplateKwargs?: Record<string, unknown>; // 透传 llama.cpp chat_template_kwargs (如 { enable_thinking: false })
  transport?: "chat" | "completion"; // 默认 "chat"; "completion" 走 llama.cpp 原生 /completion (绕过 chat template, 用于思考无法关闭的模型)
}

/** LLM 响应 */
export interface LLMResponse {
  content: string;
  model: string;
  usage: {
    promptTokens: number;
    completionTokens: number;
  };
  finishReason: string;
}

/** 约束生成选项 */
export interface ConstrainedGenerationOptions {
  schema: Record<string, unknown>;
  maxTokens?: number;
  n?: number;               // 拒绝采样次数
  seed?: number;
}

const DEFAULT_RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

/**
 * LLM 客户端
 *
 * 内置:
 * - 指数退避重试 (仅对瞬时故障: 网络错误, 429, 5xx)
 * - 熔断器 (连续失败 N 次后断开, 冷却期内快速失败)
 * - 调用统计 (用于可观测性)
 */
export class LLMClient {
  private config: LLMConfig;
  private retryConfig: RetryConfig;
  private breakerConfig: CircuitBreakerConfig;

  // 熔断器状态
  private circuitState: CircuitState = "closed";
  private consecutiveFailures = 0;
  private lastFailureTime = 0;

  // 调用统计
  private stats = {
    totalCalls: 0,
    successCount: 0,
    failureCount: 0,
    retryCount: 0,
  };

  constructor(config: LLMConfig) {
    this.config = {
      temperature: 0.0,
      topK: 1,
      seed: 42,
      maxTokens: 512,
      timeout: 120000,
      ...config,
    };
    this.retryConfig = {
      maxRetries: config.retry?.maxRetries ?? 2,
      baseDelayMs: config.retry?.baseDelayMs ?? 200,
      maxDelayMs: config.retry?.maxDelayMs ?? 2000,
      retryableStatusCodes: config.retry?.retryableStatusCodes ?? DEFAULT_RETRYABLE_STATUS,
    };
    this.breakerConfig = {
      failureThreshold: config.circuitBreaker?.failureThreshold ?? 5,
      cooldownMs: config.circuitBreaker?.cooldownMs ?? 30000,
    };
  }

  /** 获取熔断器状态 */
  getCircuitState(): CircuitState {
    if (this.circuitState === "open" && Date.now() - this.lastFailureTime > this.breakerConfig.cooldownMs) {
      this.circuitState = "half-open";
    }
    return this.circuitState;
  }

  /** 获取调用统计 */
  getStats(): LLMStats {
    return {
      ...this.stats,
      circuitState: this.getCircuitState(),
      consecutiveFailures: this.consecutiveFailures,
    };
  }

  /** 手动重置熔断器 (用于运维干预) */
  resetCircuit(): void {
    this.circuitState = "closed";
    this.consecutiveFailures = 0;
    logger.info("[LLM] Circuit breaker manually reset");
  }

  /** 熔断器检查: 是否允许发起请求 */
  private canExecute(): boolean {
    return this.getCircuitState() !== "open";
  }

  /**
   * 审计 H-3（2026-08-24）：所有 LLM 调用的 maxTokens 唯一钳制点。
   * 此前 recommendedMaxTokens 只写日志、各调用方硬编码 maxTokens，
   * 请求可超 llama.cpp --ctx-size。预算不可用时原样放行（不臆造上限）。
   */
  private effectiveMaxTokens(requested: number | undefined): number {
    const req = requested ?? this.config.maxTokens ?? 1024;
    try {
      const rec = getResourceBudgetManager().getStatus().recommendedMaxTokens;
      return clampMaxTokens(req, rec > 0 ? rec : undefined);
    } catch {
      return req;
    }
  }

  /** 记录成功 */
  private recordSuccess(): void {
    this.stats.successCount++;
    if (this.consecutiveFailures > 0 || this.circuitState === "half-open") {
      logger.info("[LLM] Circuit breaker recovered", {
        previousState: this.circuitState,
        consecutiveFailures: this.consecutiveFailures,
      });
    }
    this.consecutiveFailures = 0;
    this.circuitState = "closed";
  }

  /** 记录失败 */
  private recordFailure(): void {
    this.stats.failureCount++;
    this.consecutiveFailures++;
    this.lastFailureTime = Date.now();
    if (this.consecutiveFailures >= this.breakerConfig.failureThreshold) {
      if (this.circuitState !== "open") {
        logger.warn("[LLM] Circuit breaker tripped to OPEN", {
          consecutiveFailures: this.consecutiveFailures,
          threshold: this.breakerConfig.failureThreshold,
          cooldownMs: this.breakerConfig.cooldownMs,
        });
      }
      this.circuitState = "open";
    }
  }

  /** 指数退避延迟 (含 jitter) */
  private async backoff(attempt: number): Promise<void> {
    const expDelay = this.retryConfig.baseDelayMs * Math.pow(2, attempt);
    const cappedDelay = Math.min(expDelay, this.retryConfig.maxDelayMs);
    const jitter = Math.random() * cappedDelay * 0.1; // +0-10% jitter (prevents thundering herd)
    const delay = cappedDelay + jitter;
    await new Promise((r) => setTimeout(r, delay));
  }

  /** 判断错误是否可重试 */
  private isRetryableError(err: unknown, statusCode?: number): boolean {
    // Prefer the explicit argument; fall back to a statusCode property attached
    // to the error (set in the !response.ok path so the catch block classifies
    // HTTP errors correctly instead of treating them as retryable network errors).
    const code = statusCode ?? (err as { statusCode?: number } | null)?.statusCode;
    if (code !== undefined) {
      return this.retryConfig.retryableStatusCodes.has(code);
    }
    // 无状态码 = 网络层错误 (连接拒绝/DNS失败/超时/中断)
    // fetch 只在网络层失败时抛异常, HTTP 错误通过 !response.ok 路径处理 (带 statusCode)
    // Bun: "Unable to connect..." / Node: TypeError "fetch failed" 均为 Error 实例
    return err instanceof Error;
  }

  /**
   * 审计整改 D1（2026-08-25）：资源预算不可用时禁止直发本地 llama.cpp。
   * canRunLocal=false 时抛 LLM_ERROR(retriable=false)，避免对本地推理服务
   * 的无效请求；预算管理器自身异常时放行（与 effectiveMaxTokens 容错一致）。
   */
  private assertBudgetAvailable(): void {
    try {
      const status = getResourceBudgetManager().getStatus();
      if (!status.canRunLocal) {
        throw new DRELLMError(
          `insufficient resources for local inference: ${status.resource.availableMemory}MB available, ` +
            `need ${status.modelMemoryMB + status.safetyMarginMB}MB (model=${status.modelMemoryMB}MB + safety=${status.safetyMarginMB}MB)`,
          false,
          {
            availableMemoryMB: status.resource.availableMemory,
            requiredMB: status.modelMemoryMB + status.safetyMarginMB,
          }
        );
      }
    } catch (err) {
      if (err instanceof DRELLMError) throw err;
    }
  }

  /**
   * 标准生成 (带重试 + 熔断)
   */
  async generate(prompt: string, options?: {
    system?: string;
    maxTokens?: number;
    temperature?: number;
    stop?: string[];
    answerPrefix?: string;  // completion 模式的前缀引导 (如 '{"risk":"'), 返回内容会自动拼回该前缀
  }): Promise<LLMResponse> {
    // 资源预算检查 (D1): 预算不可用时不发起任何网络请求
    this.assertBudgetAvailable();

    // 熔断器检查
    if (!this.canExecute()) {
      throw new Error(
        `LLM circuit breaker is OPEN (consecutive failures: ${this.consecutiveFailures}, ` +
        `cooldown: ${this.breakerConfig.cooldownMs}ms). Call resetCircuit() to force reset.`
      );
    }

    this.stats.totalCalls++;
    const startTime = Date.now();

    // LLM cache: for deterministic calls (temperature === 0, which is the
    // LLMClient default), check cache before hitting the network. Same prompt
    // + model + temperature=0 always yields the same output, so caching is
    // semantically safe and maximizes hit rate.
    const effectiveTemp = options?.temperature ?? this.config.temperature ?? 0;
    if (effectiveTemp === 0) {
      const messages = options?.system
        ? [{ role: "system", content: options.system }, { role: "user", content: prompt }]
        : [{ role: "user", content: prompt }];
      const cKey = llmCacheKey({
        provider: this.config.baseUrl,
        model: this.config.model,
        messages,
        temperature: 0,
      });
      const cached = await llmCache.get(cKey);
      if (cached) {
        this.recordSuccess(); // cache hit counts as success for circuit breaker
        logger.debug("[LLM] Cache HIT", { model: this.config.model });
        return {
          content: cached.content ?? "",
          model: cached.model,
          usage: {
            promptTokens: cached.usage?.prompt_tokens ?? 0,
            completionTokens: cached.usage?.completion_tokens ?? 0,
          },
          finishReason: cached.finishReason ?? "stop",
        };
      }
    }

    const useRawCompletion = this.config.transport === "completion";

    let url: string;
    let body: string;
    if (useRawCompletion) {
      // 原生 /completion 模式：system+user 拍平为单段 prompt, "Answer:" 引导直接作答
      // (用于 chat template 强制思考且无法关闭的模型, 如 Qwopus3.5-2B)
      const flat = options?.system ? `${options.system}\n\n${prompt}` : prompt;
      url = `${this.config.baseUrl}/completion`;
      body = JSON.stringify({
        prompt: `${flat}\nAnswer: ${options?.answerPrefix ?? ""}`,
        n_predict: this.effectiveMaxTokens(options?.maxTokens ?? this.config.maxTokens),
        temperature: options?.temperature ?? this.config.temperature,
        top_k: this.config.topK,
        seed: this.config.seed,
        cache_prompt: true,
        stop: options?.stop ?? ["\n\n"],
      });
    } else {
      const messages = [];
      if (options?.system) {
        messages.push({ role: "system", content: options.system });
      }
      messages.push({ role: "user", content: prompt });

      url = `${this.config.baseUrl}/v1/chat/completions`;
      body = JSON.stringify({
        model: this.config.model,
        messages,
        temperature: options?.temperature ?? this.config.temperature,
        top_k: this.config.topK,
        max_tokens: this.effectiveMaxTokens(options?.maxTokens ?? this.config.maxTokens),
        seed: this.config.seed,
        stop: options?.stop,
        ...(this.config.chatTemplateKwargs ? { chat_template_kwargs: this.config.chatTemplateKwargs } : {}),
      });
    }

    const headers = {
      "Content-Type": "application/json",
      ...(this.config.apiKey ? { Authorization: `Bearer ${this.config.apiKey}` } : {}),
    };

    let lastError: Error | null = null;
    const maxAttempts = this.retryConfig.maxRetries + 1;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        const response = await fetch(url, {
          method: "POST",
          headers,
          body,
          signal: AbortSignal.timeout(this.config.timeout!),
        });

        if (!response.ok) {
          const err = new Error(`LLM API error: ${response.status} ${response.statusText}`);
          // Attach statusCode so the catch block can correctly classify the error.
          // Without this, isRetryableError(err) without statusCode returns true for
          // any Error, causing non-retryable 4xx (e.g. 401/403) to be retried and
          // over-count failures toward the circuit breaker.
          (err as Error & { statusCode?: number }).statusCode = response.status;
          if (this.isRetryableError(err, response.status) && attempt < maxAttempts - 1) {
            this.stats.retryCount++;
            logger.warn("[LLM] Retryable HTTP error, backing off", {
              status: response.status,
              attempt: attempt + 1,
              maxAttempts,
            });
            lastError = err;
            await this.backoff(attempt);
            continue;
          }
          // 不可重试的 HTTP 错误 (4xx 除 429) 或重试已耗尽
          // recordFailure() 由循环后的统一路径调用，此处不再重复计数
          throw err;
        }

        this.recordSuccess();
        if (useRawCompletion) {
          const raw = await response.json() as {
            content: string;
            stop: boolean;
            model: string;
            tokens_evaluated?: number;
            tokens_predicted?: number;
          };
          return {
            // 剥离可能残留的 <think> 块 (2B 类模型在补全模式也会思考);
            // answerPrefix 引导词拼回 (模型从前缀处续写, 完整输出 = 前缀 + 续写)
            content: (options?.answerPrefix ?? "") +
              (raw.content ?? "").replace(/<think>[\s\S]*?(<\/think>|$)/g, "").trim(),
            model: raw.model ?? this.config.model,
            usage: {
              promptTokens: raw.tokens_evaluated ?? 0,
              completionTokens: raw.tokens_predicted ?? 0,
            },
            finishReason: raw.stop ? "stop" : "length",
          };
        }

        const data = await response.json() as {
          choices: Array<{
            message: { content: string };
            finish_reason: string;
          }>;
          model: string;
          usage: { prompt_tokens: number; completion_tokens: number };
        };

        // Persist model output to disk (non-blocking)
        getModelOutputStore().persist({
          provider: this.config.baseUrl,
          model: this.config.model,
          prompt,
          system: options?.system,
          temperature: options?.temperature ?? this.config.temperature,
          latencyMs: Date.now() - startTime,
          success: true,
          response: {
            content: data.choices[0].message.content,
            usage: {
              prompt_tokens: data.usage.prompt_tokens,
              completion_tokens: data.usage.completion_tokens,
              total_tokens: data.usage.prompt_tokens + data.usage.completion_tokens,
            },
            finishReason: data.choices[0].finish_reason,
          },
        });

        // Cache successful deterministic response
        if (effectiveTemp === 0) {
          const messages = options?.system
            ? [{ role: "system", content: options.system }, { role: "user", content: prompt }]
            : [{ role: "user", content: prompt }];
          const cKey = llmCacheKey({
            provider: this.config.baseUrl,
            model: this.config.model,
            messages,
            temperature: 0,
          });
          llmCache.set(cKey, {
            content: data.choices[0].message.content,
            model: data.model,
            provider: this.config.baseUrl,
            usage: {
              prompt_tokens: data.usage.prompt_tokens,
              completion_tokens: data.usage.completion_tokens,
              total_tokens: data.usage.prompt_tokens + data.usage.completion_tokens,
            },
            finishReason: data.choices[0].finish_reason,
          });
        }

        return {
          content: data.choices[0].message.content,
          model: data.model,
          usage: {
            promptTokens: data.usage.prompt_tokens,
            completionTokens: data.usage.completion_tokens,
          },
          finishReason: data.choices[0].finish_reason,
        };
      } catch (err) {
        lastError = err as Error;
        // 熔断器已断开, 不再重试
        if (err instanceof Error && err.message.includes("circuit breaker is OPEN")) {
          throw err;
        }
        if (this.isRetryableError(err) && attempt < maxAttempts - 1) {
          this.stats.retryCount++;
          logger.warn("[LLM] Retryable error, backing off", {
            error: (err as Error).message,
            attempt: attempt + 1,
            maxAttempts,
          });
          await this.backoff(attempt);
          continue;
        }
        // 不可重试或已耗尽重试次数
        break;
      }
    }

    this.recordFailure();

    // Persist failed call for observability
    getModelOutputStore().persist({
      provider: this.config.baseUrl,
      model: this.config.model,
      prompt,
      system: options?.system,
      temperature: options?.temperature ?? this.config.temperature,
      latencyMs: Date.now() - startTime,
      success: false,
      error: lastError ?? new Error("LLM generate failed after all retries"),
    });

    throw lastError ?? new Error("LLM generate failed after all retries");
  }

  /**
   * 流式生成
   */
  async *streamGenerate(prompt: string, options?: {
    system?: string;
    maxTokens?: number;
    temperature?: number;
  }): AsyncGenerator<string> {
    // 资源预算检查 (D1): 预算不可用时不发起任何网络请求
    this.assertBudgetAvailable();

    const messages = [];

    if (options?.system) {
      messages.push({ role: "system", content: options.system });
    }

    messages.push({ role: "user", content: prompt });

    const response = await fetch(`${this.config.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(this.config.apiKey ? { Authorization: `Bearer ${this.config.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: this.config.model,
        messages,
        temperature: options?.temperature ?? this.config.temperature,
        top_k: this.config.topK,
        max_tokens: this.effectiveMaxTokens(options?.maxTokens ?? this.config.maxTokens),
        seed: this.config.seed,
        stream: true,
        ...(this.config.chatTemplateKwargs ? { chat_template_kwargs: this.config.chatTemplateKwargs } : {}),
      }),
      signal: AbortSignal.timeout(this.config.timeout!),
    });

    if (!response.ok) {
      throw new Error(`LLM API error: ${response.status} ${response.statusText}`);
    }

    const reader = response.body?.getReader();
    if (!reader) throw new Error("No response body");

    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (line.startsWith("data: ")) {
          const data = line.slice(6);
          if (data === "[DONE]") return;

          try {
            const parsed = JSON.parse(data) as {
              choices: Array<{
                delta: { content?: string };
              }>;
            };

            const content = parsed.choices[0]?.delta?.content;
            if (content) {
              yield content;
            }
          } catch (err) {
            logger.debug("[LLM] Stream chunk parse error", { error: (err as Error).message });
          }
        }
      }
    }
  }

  /**
   * 约束生成 (JSON Schema + 拒绝采样)
   */
  async generateConstrained(
    prompt: string,
    schema: Record<string, unknown>,
    options?: {
      maxTokens?: number;
      n?: number;
      seed?: number;
    }
  ): Promise<Record<string, unknown>> {
    const n = options?.n ?? 3;
    const candidates: Array<Record<string, unknown>> = [];
    let hasCallError = false;

    for (let i = 0; i < n; i++) {
      try {
        const response = await this.generate(prompt, {
          maxTokens: options?.maxTokens,
          temperature: 0.0,
        });

        const parsed = JSON.parse(response.content);

        // 验证 Schema
        if (this.validateSchema(parsed, schema)) {
          candidates.push(parsed);
        }
      } catch (err) {
        // 区分“LLM 调用/解析失败”与“返回内容不符合 schema”：调用失败应让上游可感知，
        // 而不是把服务不可用误判成“真实 reject”。
        hasCallError = true;
        logger.debug("[LLM] Constrained generation attempt failed", { error: (err as Error).message });
        continue;
      }
    }

    if (candidates.length === 0) {
      return {
        verdict: "reject",
        confidence: 0,
        chain: [],
        evidence_refs: [],
        reason: hasCallError ? "llm_unavailable" : "schema_validation_failed",
      };
    }

    // 取众数
    return this.selectMode(candidates);
  }

  /**
   * 验证 Schema
   */
  private validateSchema(obj: Record<string, unknown>, schema: Record<string, unknown>): boolean {
    // 检查必填字段
    const required = schema.required as string[] | undefined;
    if (required) {
      for (const field of required) {
        if (!(field in obj)) {
          return false;
        }
      }
    }

    // 检查 verdict 枚举
    const properties = schema.properties as Record<string, Record<string, unknown>> | undefined;
    if (properties?.verdict?.enum) {
      const validVerdicts = properties.verdict.enum as string[];
      if (!validVerdicts.includes(obj.verdict as string)) {
        return false;
      }
    }

    // 检查 confidence 范围
    if (properties?.confidence) {
      const confidence = obj.confidence;
      // Missing or non-number confidence must fail validation.
      // Without this guard, `undefined < min` is `false` and the check passes.
      if (typeof confidence !== "number") {
        return false;
      }
      const min = properties.confidence.minimum as number ?? 0;
      const max = properties.confidence.maximum as number ?? 1;
      if (confidence < min || confidence > max) {
        return false;
      }
    }

    // 检查 chain 长度
    if (properties?.chain) {
      const chain = obj.chain;
      // Missing or non-array chain must fail validation (not throw TypeError on .length).
      if (!Array.isArray(chain)) {
        return false;
      }
      const minItems = properties.chain.minItems as number ?? 0;
      const maxItems = properties.chain.maxItems as number ?? Infinity;
      if (chain.length < minItems || chain.length > maxItems) {
        return false;
      }
    }

    // 检查低置信度约束
    if (typeof obj.confidence === "number" && obj.confidence < 0.6 && obj.verdict === "accept") {
      return false;
    }

    return true;
  }

  /**
   * 选择众数
   */
  private selectMode(candidates: Array<Record<string, unknown>>): Record<string, unknown> {
    // 按 verdict + confidence 分组
    const groups = new Map<string, Array<Record<string, unknown>>>();

    for (const candidate of candidates) {
      const key = `${candidate.verdict}-${Math.round((candidate.confidence as number) * 100)}`;
      if (!groups.has(key)) {
        groups.set(key, []);
      }
      groups.get(key)!.push(candidate);
    }

    // 找到最大的组
    let maxGroup: Array<Record<string, unknown>> = [];
    let maxCount = 0;

    for (const [, group] of groups) {
      if (group.length > maxCount) {
        maxCount = group.length;
        maxGroup = group;
      }
    }

    // 返回第一个；若候选存在分歧（每组只出现一次），附加 modeAmbiguous 标记
    const chosen = maxGroup[0];
    if (maxCount === 1 && candidates.length > 1) {
      return { ...chosen, modeAmbiguous: true };
    }
    return chosen;
  }
}
