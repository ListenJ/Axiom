/**
 * Provider configurations + config helpers.
 * Split from models.ts (was 1128 lines) for maintainability.
 */
import type { ModelProvider, ProviderConfig } from "./types.js";

export const PROVIDER_CONFIG: Record<ModelProvider, ProviderConfig> = {
  siliconflow: {
    baseURL: "https://api.siliconflow.cn/v1",
    apiKeyEnv: "SILICONFLOW_API_KEY",
  },
  ofoxai: {
    baseURL: "https://api.ofoxai.com",
    apiKeyEnv: "OFOXAI_API_KEY",
  },
  "ofoxai-anthropic": {
    baseURL: "https://api.ofoxai.com/anthropic",
    apiKeyEnv: "OFOXAI_ANTHROPIC_API_KEY",
  },
  "ofoxai-gemini": {
    baseURL: "https://api.ofoxai.com/gemini",
    apiKeyEnv: "OFOXAI_GEMINI_API_KEY",
  },
  openrouter: {
    baseURL: "https://openrouter.ai/api/v1",
    apiKeyEnv: "OPENROUTER_API_KEY",
  },
  deepseek: {
    baseURL: "https://api.deepseek.com/v1",
    apiKeyEnv: "DEEPSEEK_API_KEY",
  },
  opencode: {
    baseURL: "https://api.opencode.ai/v1",
    apiKeyEnv: "OPENCODE_API_KEY",
  },
  kimi: {
    baseURL: "https://api.moonshot.cn/v1",
    apiKeyEnv: "KIMI_API_KEY",
  },
  minimax: {
    baseURL: process.env.MINIMAX_BASE_URL || "https://api.minimax.chat/v1",
    apiKeyEnv: "MINIMAX_API_KEY",
  },
  "nvidia-nim": {
    baseURL: "https://integrate.api.nvidia.com/v1",
    apiKeyEnv: "NIM_API_KEY",
  },
};

/** Check if a provider is configured (its API key env var is set). */
export function isProviderConfigured(provider: ModelProvider): boolean {
  const config = PROVIDER_CONFIG[provider];
  if (!config) return false;
  return !!process.env[config.apiKeyEnv];
}

/** List configured providers (those with API keys present in env). */
export function listConfiguredProviders(): ModelProvider[] {
  return (Object.keys(PROVIDER_CONFIG) as ModelProvider[]).filter(isProviderConfigured);
}