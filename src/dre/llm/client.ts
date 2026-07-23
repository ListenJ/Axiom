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
   * 标准生成 (带重试 + 熔断)
   */
  async generate(prompt: string, options?: {
    system?: string;
    maxTokens?: number;
    temperature?: number;
    stop?: string[];
  }): Promise<LLMResponse> {
    // 熔断器检查
    if (!this.canExecute()) {
      throw new Error(
        `LLM circuit breaker is OPEN (consecutive failures: ${this.consecutiveFailures}, ` +
        `cooldown: ${this.breakerConfig.cooldownMs}ms). Call resetCircuit() to force reset.`
      );
    }

    this.stats.totalCalls++;
    const messages = [];
    if (options?.system) {
      messages.push({ role: "system", content: options.system });
    }
    messages.push({ role: "user", content: prompt });

    const body = JSON.stringify({
      model: this.config.model,
      messages,
      temperature: options?.temperature ?? this.config.temperature,
      top_k: this.config.topK,
      max_tokens: options?.maxTokens ?? this.config.maxTokens,
      seed: this.config.seed,
      stop: options?.stop,
    });

    const headers = {
      "Content-Type": "application/json",
      ...(this.config.apiKey ? { Authorization: `Bearer ${this.config.apiKey}` } : {}),
    };

    let lastError: Error | null = null;
    const maxAttempts = this.retryConfig.maxRetries + 1;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        const response = await fetch(`${this.config.baseUrl}/v1/chat/completions`, {
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

        const data = await response.json() as {
          choices: Array<{
            message: { content: string };
            finish_reason: string;
          }>;
          model: string;
          usage: { prompt_tokens: number; completion_tokens: number };
        };

        this.recordSuccess();
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
        max_tokens: options?.maxTokens ?? this.config.maxTokens,
        seed: this.config.seed,
        stream: true,
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
        logger.debug("[LLM] Constrained generation parse error, retrying", { error: (err as Error).message });
        continue;
      }
    }

    if (candidates.length === 0) {
      return {
        verdict: "reject",
        confidence: 0,
        chain: [],
        evidence_refs: [],
        reason: "schema_validation_failed",
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

    // 返回第一个
    return maxGroup[0];
  }
}
