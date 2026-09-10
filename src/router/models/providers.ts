/**
 * Provider configurations — 兼容层（唯一事实源：src/utils/api-key-store.ts）。
 *
 * api-key-store 持有完整 provider 表（baseURL/apiKeyEnv/adapter/region/displayName），
 * 本文件只保留 router 侧需要的 { baseURL, apiKeyEnv } 子集，启动时派生，杜绝双份漂移。
 */
import type { ModelProvider, ProviderConfig } from "./types.js";
import { getProviderConfig } from "../../utils/api-key-store.js";

/** router 侧支持的 provider 集合（与 models/types.ts ModelProvider 联合保持一致）。 */
const ALL_MODEL_PROVIDERS: ModelProvider[] = [
  "siliconflow",
  "ofoxai",
  "ofoxai-anthropic",
  "ofoxai-gemini",
  "openrouter",
  "deepseek",
  "opencode",
  "kimi",
  "minimax",
  "nvidia-nim",
  "zhipu",
  "sensenova",
];

function buildProviderConfig(): Record<ModelProvider, ProviderConfig> {
  const out = {} as Record<ModelProvider, ProviderConfig>;
  for (const provider of ALL_MODEL_PROVIDERS) {
    const cfg = getProviderConfig(provider);
    if (!cfg) {
      throw new Error(`[ProviderConfig] api-key-store missing provider entry: ${provider}`);
    }
    out[provider] = cfg;
  }
  return out;
}

export const PROVIDER_CONFIG: Record<ModelProvider, ProviderConfig> = buildProviderConfig();

/** Check if a provider is configured (its API key env var is set). */
export function isProviderConfigured(provider: ModelProvider): boolean {
  const config = PROVIDER_CONFIG[provider];
  if (!config) return false;
  return !!process.env[config.apiKeyEnv];
}

/** List configured providers (those with API keys present in env). */
export function listConfiguredProviders(): ModelProvider[] {
  return ALL_MODEL_PROVIDERS.filter(isProviderConfigured);
}
