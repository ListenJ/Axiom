/**
 * DRE Configuration Loader
 *
 * 集中管理 DREConfig / KernelConfig 的加载。
 * 来源优先级: explicit config > env vars > defaults
 */

import type { KernelConfig } from "./kernel.js";
import { readString } from "../utils/env.js";
import { logger } from "../utils/logger.js";

export interface ConfigSource {
  dbPath?: string;
  llmUrl?: string;
  llmModel?: string;
  /** 主推理模型 API Key（DRE_LLM_API_KEY；本地 llama.cpp 可省略） */
  llmApiKey?: string;
  llmTemperature?: number;
  llmTopK?: number;
  llmSeed?: number;
  discriminUrl?: string;
  discriminModel?: string;
  /** 甄别模型 API Key（DRE_DISCRIMIN_API_KEY） */
  discriminApiKey?: string;
  cloudApiKey?: string;
  cloudModel?: string;
  cloudBaseUrl?: string;
  tickInterval?: number;
  autoTick?: boolean;
  workingMemoryCapacity?: number;
  episodicTTL?: number;
}

const ENV_MAP: Record<string, keyof ConfigSource> = {
  DRE_DB_PATH: "dbPath",
  DRE_LLM_URL: "llmUrl",
  DRE_LLM_MODEL: "llmModel",
  DRE_LLM_API_KEY: "llmApiKey",
  DRE_LLM_TEMPERATURE: "llmTemperature",
  DRE_LLM_TOP_K: "llmTopK",
  DRE_LLM_SEED: "llmSeed",
  DRE_DISCRIMIN_URL: "discriminUrl",
  DRE_DISCRIMIN_MODEL: "discriminModel",
  DEEPSEEK_API_KEY: "cloudApiKey",
  DEEPSEEK_MODEL: "cloudModel",
  DEEPSEEK_BASE_URL: "cloudBaseUrl",
  DRE_TICK_INTERVAL: "tickInterval",
  DRE_AUTO_TICK: "autoTick",
  DRE_WORKING_MEMORY_CAPACITY: "workingMemoryCapacity",
  DRE_EPISODIC_TTL: "episodicTTL",
};

const DEFAULTS: Required<ConfigSource> = {
  dbPath: "./data/dre.db",
  llmUrl: "http://127.0.0.1:8080",
  llmModel: "qwen3-1.7b-instruct",
  llmApiKey: "",
  llmTemperature: 0.0,
  llmTopK: 1,
  llmSeed: 42,
  discriminUrl: "",
  discriminModel: "qwen3-0.6b-instruct",
  discriminApiKey: "",
  cloudApiKey: "",
  cloudModel: "deepseek-v4-flash",
  cloudBaseUrl: "https://api.deepseek.com/v1",
  tickInterval: 10000,
  autoTick: true,
  workingMemoryCapacity: 16,
  episodicTTL: 3600000,
};

export class ConfigLoader {
  private source: ConfigSource;

  constructor(source?: ConfigSource) {
    this.source = { ...this.loadFromEnv(), ...source };
  }

  /**
   * 从环境变量加载
   */
  private loadFromEnv(): ConfigSource {
    const result: ConfigSource = {};
    for (const [envKey, configKey] of Object.entries(ENV_MAP)) {
      const value = readString(envKey);
      if (value !== undefined && value !== "") {
        // 类型推断
        if (configKey === "llmTemperature" || configKey === "llmTopK" || configKey === "llmSeed") {
          const n = Number(value);
          if (isNaN(n)) {
            logger.warn("[Config] Invalid numeric env var", { key: envKey, value });
            continue;
          }
          (result as Record<string, unknown>)[configKey] = n;
        } else if (configKey === "tickInterval" || configKey === "workingMemoryCapacity" || configKey === "episodicTTL") {
          const n = Number(value);
          if (isNaN(n)) {
            logger.warn("[Config] Invalid numeric env var", { key: envKey, value });
            continue;
          }
          (result as Record<string, unknown>)[configKey] = n;
        } else if (configKey === "autoTick") {
          (result as Record<string, unknown>)[configKey] = value === "true" || value === "1";
        } else {
          (result as Record<string, unknown>)[configKey] = value;
        }
      }
    }
    return result;
  }

  /**
   * 解析为完整 DREConfig
   */
  toKernelConfig(): KernelConfig {
    const merged = { ...DEFAULTS, ...this.source };

    const config: KernelConfig = {
      dbPath: merged.dbPath,
      mainLLM: {
        baseUrl: merged.llmUrl,
        model: merged.llmModel,
        apiKey: merged.llmApiKey || undefined,
        temperature: merged.llmTemperature,
        topK: merged.llmTopK,
        seed: merged.llmSeed,
      },
      tickInterval: merged.tickInterval,
      autoTick: merged.autoTick,
      workingMemoryCapacity: merged.workingMemoryCapacity,
      episodicTTL: merged.episodicTTL,
    };

    if (merged.discriminUrl) {
      config.discriminLLM = {
        baseUrl: merged.discriminUrl,
        model: merged.discriminModel,
        apiKey: merged.discriminApiKey || undefined,
        temperature: merged.llmTemperature,
        topK: merged.llmTopK,
        seed: merged.llmSeed,
      };
    }

    if (merged.cloudApiKey) {
      config.cloudFallback = {
        baseUrl: merged.cloudBaseUrl,
        apiKey: merged.cloudApiKey,
        model: merged.cloudModel,
      };
    }

    // 非本地端点且未配置 API Key 时给出清晰告警（本地 llama.cpp 可省略）
    if (!merged.llmApiKey && !/^https?:\/\/(127\.0\.0\.1|localhost)/.test(merged.llmUrl)) {
      logger.warn("[DRE] DRE_LLM_URL 指向远程端点但未配置 DRE_LLM_API_KEY，请求将因缺少鉴权而失败");
    }

    return config;
  }

  /**
   * 获取当前原始配置源 (用于调试)
   */
  getSource(): ConfigSource {
    return { ...this.source };
  }
}

