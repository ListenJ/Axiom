/**
 * Kimi Code API Adapter
 *
 * Provides programmatic access to Moonshot Kimi Code API.
 * Endpoint: https://api.kimi.com/coding/v1
 * Model: kimi-for-coding
 *
 * For CLI fallback, see: https://platform.moonshot.cn/docs/code
 */

import { logger } from "./logger.js";

export interface KimiCodeOptions {
  /** Temperature (0-2, default: 0.6) */
  temperature?: number;
  /** Max tokens (default: 4096) */
  maxTokens?: number;
  /** Timeout in ms (default: 60000) */
  timeout?: number;
  /** Enable streaming (not yet supported) */
  stream?: boolean;
  /** System prompt override */
  system?: string;
  /** Additional headers */
  headers?: Record<string, string>;
}

export interface KimiCodeMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface KimiCodeResult {
  content: string;
  model: string;
  provider: "kimi-code";
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
  /** Execution time in ms */
  durationMs: number;
}

const KIMI_CODE_BASE_URL =
  process.env.KIMI_CODE_BASE_URL || "https://api.kimi.com/coding/v1";
const KIMI_CODE_API_KEY = process.env.KIMI_CODE_API_KEY || "";
const DEFAULT_MODEL = "kimi-for-coding";

class KimiCodeAdapter {
  private readonly defaultTimeout = 60000;
  private readonly defaultTemperature = 0.6;
  private readonly defaultMaxTokens = 4096;

  /**
   * Execute chat completion via Kimi Code API
   */
  async chat(
    messages: KimiCodeMessage[],
    options: KimiCodeOptions = {}
  ): Promise<KimiCodeResult> {
    const startTime = Date.now();
    const {
      temperature = this.defaultTemperature,
      maxTokens = this.defaultMaxTokens,
      timeout = this.defaultTimeout,
      system,
      headers: extraHeaders = {},
    } = options;

    if (!KIMI_CODE_API_KEY) {
      throw new Error(
        "KIMI_CODE_API_KEY not set. Get one at https://platform.moonshot.cn"
      );
    }

    // Merge system message if provided
    const finalMessages = system
      ? [{ role: "system" as const, content: system }, ...messages.filter(m => m.role !== "system")]
      : messages;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);

    logger.info("[KimiCode] Sending request", {
      model: DEFAULT_MODEL,
      messageCount: finalMessages.length,
    });

    try {
      const res = await fetch(`${KIMI_CODE_BASE_URL}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${KIMI_CODE_API_KEY}`,
          ...extraHeaders,
        },
        body: JSON.stringify({
          model: DEFAULT_MODEL,
          messages: finalMessages,
          temperature,
          max_tokens: maxTokens,
        }),
        signal: controller.signal,
      });

      clearTimeout(timer);

      if (!res.ok) {
        const errText = await res.text();
        throw new Error(`Kimi Code API HTTP ${res.status}: ${errText}`);
      }

      const data = await res.json();
      const content = data.choices?.[0]?.message?.content ?? "";
      const usage = data.usage;
      const durationMs = Date.now() - startTime;

      logger.info("[KimiCode] Completed", {
        durationMs,
        contentLength: content.length,
        usage,
      });

      return {
        content,
        model: DEFAULT_MODEL,
        provider: "kimi-code",
        usage,
        durationMs,
      };
    } catch (error: any) {
      clearTimeout(timer);

      if (error.name === "AbortError") {
        throw new Error(`Kimi Code request timed out after ${timeout}ms`);
      }

      logger.error("[KimiCode] Request failed", error);
      throw error;
    }
  }

  /**
   * Quick single-prompt execution
   */
  async execute(
    prompt: string,
    options: KimiCodeOptions = {}
  ): Promise<KimiCodeResult> {
    const messages: KimiCodeMessage[] = [{ role: "user", content: prompt }];
    return this.chat(messages, options);
  }

  /**
   * Check if API key is configured
   */
  isConfigured(): boolean {
    return !!KIMI_CODE_API_KEY;
  }

  /**
   * Health check - verifies API connectivity
   */
  async healthCheck(): Promise<boolean> {
    try {
      await this.execute("Hello", { timeout: 10000, maxTokens: 10 });
      return true;
    } catch {
      return false;
    }
  }
}

export const kimiCode = new KimiCodeAdapter();
