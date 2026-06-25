/**
 * Runtime API Key Override Store
 *
 * 允许通过 HTTP API 在运行时设置/清除 provider 的 API Key，
 * 而无需重启服务或修改 .env 文件。
 *
 * 优先级: runtime override > process.env > 配置默认值
 *
 * 持久化:
 *   - 内存中的运行时覆盖由 api-key-persistence.ts 负责持久化到 SQLite
 *   - 服务启动时从 DB 加载已有覆盖（参见 main.ts 初始化流程）
 *   - 写入/清除时同步更新 DB（参见 api-keys.ts 路由处理）
 *
 * 安全说明:
 *   - 不写入 .env
 *   - 前端请求需携带有效的 x-api-key（OPENCLAW_AUTH_TOKEN）
 */

import { logger } from "./logger.js";
import { PROVIDER_CONFIG, type ModelProvider } from "../router/models.js";

type ProviderKey = ModelProvider | string;

interface OverrideEntry {
  apiKey: string;
  baseURL?: string;
  setAt: number;
  source: "env" | "runtime" | "config";
}

// In-memory store: provider -> entry
const store = new Map<ProviderKey, OverrideEntry>();

/**
 * Set (or clear) a provider's API key override.
 * Pass empty string to clear the override (falls back to env).
 */
export function setApiKeyOverride(
  provider: ProviderKey,
  apiKey: string,
  baseURL?: string
): void {
  if (!apiKey || apiKey.trim() === "") {
    clearApiKeyOverride(provider);
    return;
  }
  store.set(provider, {
    apiKey: apiKey.trim(),
    baseURL: baseURL?.trim() || undefined,
    setAt: Date.now(),
    source: "runtime",
  });
  logger.info(`[ApiKeyStore] Override set for provider: ${provider}`);
}

export function clearApiKeyOverride(provider: ProviderKey): void {
  if (store.delete(provider)) {
    logger.info(`[ApiKeyStore] Override cleared for provider: ${provider}`);
  }
}

/**
 * Resolve the effective API key for a provider.
 * Order: runtime override > process.env[apiKeyEnv]
 */
export function getEffectiveApiKey(
  provider: ProviderKey,
  apiKeyEnv: string
): string | undefined {
  const override = store.get(provider);
  if (override?.apiKey) return override.apiKey;
  return process.env[apiKeyEnv];
}

/**
 * Resolve the effective base URL for a provider.
 * Order: runtime override > process.env[baseURLEnv] > PROVIDER_CONFIG default
 */
export function getEffectiveBaseURL(
  provider: ProviderKey,
  apiKeyEnv: string, // used as the env-var hint, but PROVIDER_CONFIG holds the default
  defaultBaseURL: string
): string {
  const override = store.get(provider);
  if (override?.baseURL) return override.baseURL;

  // Some providers honor a *_BASE_URL env var; try that first
  const baseUrlEnv = apiKeyEnv.replace(/_API_KEY$/, "_BASE_URL");
  if (process.env[baseUrlEnv]) return process.env[baseUrlEnv]!;

  return defaultBaseURL;
}

/**
 * List all provider statuses (masked keys, never the actual value).
 * Used by GET /api-keys endpoint.
 */
export function listProviderStatus(): Array<{
  provider: string;
  apiKeyEnv: string;
  baseURL: string;
  source: "env" | "runtime" | "config" | "none";
  configured: boolean;
  masked: string; // e.g. "sk-aaaa****" or ""
}> {
  const out: Array<{
    provider: string;
    apiKeyEnv: string;
    baseURL: string;
    source: "env" | "runtime" | "config" | "none";
    configured: boolean;
    masked: string;
  }> = [];

  for (const [provider, cfg] of Object.entries(PROVIDER_CONFIG)) {
    const override = store.get(provider);
    const envKey = process.env[cfg.apiKeyEnv];
    const effectiveKey = override?.apiKey || envKey;
    const baseURL = getEffectiveBaseURL(provider, cfg.apiKeyEnv, cfg.baseURL);

    out.push({
      provider,
      apiKeyEnv: cfg.apiKeyEnv,
      baseURL,
      source: override ? "runtime" : envKey ? "env" : "none",
      configured: !!effectiveKey,
      masked: effectiveKey ? maskKey(effectiveKey) : "",
    });
  }

  return out;
}

function maskKey(key: string): string {
  if (key.length <= 10) return "****";
  return `${key.slice(0, 6)}****${key.slice(-4)}`;
}

/**
 * Validate that a given provider string is one of the known providers.
 * Returns the typed provider or null.
 */
export function isKnownProvider(provider: string): provider is ModelProvider {
  return provider in PROVIDER_CONFIG;
}

/**
 * Bulk-load overrides from DB into the in-memory store.
 * Called once at startup after api_key_overrides table is initialized.
 */
export function loadOverrides(entries: Array<{ provider: string; apiKey: string; baseURL?: string; setAt: number }>): void {
  for (const e of entries) {
    store.set(e.provider, {
      apiKey: e.apiKey,
      baseURL: e.baseURL,
      setAt: e.setAt,
      source: "runtime",
    });
  }
  if (entries.length > 0) {
    logger.info(`[ApiKeyStore] Loaded ${entries.length} persisted override(s) from DB`);
  }
}
