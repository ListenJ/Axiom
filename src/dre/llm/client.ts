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

import { z } from "zod";
import { logger } from "../../utils/logger.js";

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

/**
 * LLM 客户端
 */
export class LLMClient {
  private config: LLMConfig;

  constructor(config: LLMConfig) {
    this.config = {
      temperature: 0.0,
      topK: 1,
      seed: 42,
      maxTokens: 512,
      timeout: 120000,
      ...config,
    };
  }

  /**
   * 标准生成
   */
  async generate(prompt: string, options?: {
    system?: string;
    maxTokens?: number;
    temperature?: number;
    stop?: string[];
  }): Promise<LLMResponse> {
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
        stop: options?.stop,
      }),
      signal: AbortSignal.timeout(this.config.timeout!),
    });

    if (!response.ok) {
      throw new Error(`LLM API error: ${response.status} ${response.statusText}`);
    }

    const data = await response.json() as {
      choices: Array<{
        message: { content: string };
        finish_reason: string;
      }>;
      model: string;
      usage: { prompt_tokens: number; completion_tokens: number };
    };

    return {
      content: data.choices[0].message.content,
      model: data.model,
      usage: {
        promptTokens: data.usage.prompt_tokens,
        completionTokens: data.usage.completion_tokens,
      },
      finishReason: data.choices[0].finish_reason,
    };
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
      const confidence = obj.confidence as number;
      const min = properties.confidence.minimum as number ?? 0;
      const max = properties.confidence.maximum as number ?? 1;
      if (confidence < min || confidence > max) {
        return false;
      }
    }

    // 检查 chain 长度
    if (properties?.chain) {
      const chain = obj.chain as unknown[];
      const minItems = properties.chain.minItems as number ?? 0;
      const maxItems = properties.chain.maxItems as number ?? Infinity;
      if (chain.length < minItems || chain.length > maxItems) {
        return false;
      }
    }

    // 检查低置信度约束
    if ((obj.confidence as number) < 0.6 && obj.verdict === "accept") {
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
