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
 *   - 前端请求需携带有效的 x-api-key（AXIOM_AUTH_TOKEN）
 *
 * API 标准兼容:
 *   - adapter 字段标识 provider 使用的 API 协议:
 *     "openai"    — OpenAI Chat Completions 标准（/v1/chat/completions）
 *     "anthropic" — Claude 母公司 API 标准（/v1/messages）
 *     "gemini"    — Google Gemini 标准
 *     "opencode"  — OpenCode Go 套餐服务（基于 OpenAI 协议扩展）
 *
 * 国内/海外差异化适配:
 *   - region 字段标识 provider 的部署区域:
 *     "domestic"  — 国内版本（境内 API 端点，国内 API Key）
 *     "overseas"  — 海外版本（境外 API 端点，海外 API Key）
 *   - 同一 provider 可同时配置国内与海外两个变体（如 kimi / kimi-overseas）
 *   - 用户仅需添加单个 API Key 即可使用对应变体服务
 */

import { logger } from "./logger.js";

type ApiAdapter = "openai" | "anthropic" | "gemini" | "opencode";
type ProviderRegion = "domestic" | "overseas" | "global";

interface ProviderEntry {
  apiKeyEnv: string;
  baseURL: string;
  /** API 协议适配器：openai=OpenAI标准, anthropic=Claude标准, gemini, opencode */
  adapter: ApiAdapter;
  /** 部署区域：domestic=国内, overseas=海外, global=全球统一 */
  region: ProviderRegion;
  /** 可读名称（前端展示用） */
  displayName: string;
  /** 该 provider 是否支持区域变体切换（用于前端 UI） */
  hasRegionalVariants?: boolean;
}

/**
 * Provider 配置表 — 涵盖两套主流 API 标准 (Claude / OpenAI) 与
 * 国内开源模型 (KIMI/GLM/Deepseek/MiniMax) 的国内/海外版本。
 *
 * 国内/海外差异化的底层适配逻辑：
 *  - KIMI:     国内 moonshot.cn  / 海外 moonshot.ai
 *  - GLM:      国内 bigmodel.cn  / 海外 z.ai
 *  - Deepseek: 国内 deepseek.com / 海外 deepseek.com（同一端点，但分组以便分流）
 *  - MiniMax:  国内 minimax.chat / 海外 minimax.io
 */
const PROVIDER_CONFIG: Record<string, ProviderEntry> = {
  // ─── OpenAI 标准协议 ──────────────────────────────────────────────
  siliconflow: {
    apiKeyEnv: "SILICONFLOW_API_KEY",
    baseURL: "https://api.siliconflow.cn/v1",
    adapter: "openai",
    region: "domestic",
    displayName: "SiliconFlow",
  },
  ofoxai: {
    apiKeyEnv: "OFOXAI_API_KEY",
    baseURL: "https://api.ofoxai.com",
    adapter: "openai",
    region: "global",
    displayName: "OFOXAI",
  },
  openrouter: {
    apiKeyEnv: "OPENROUTER_API_KEY",
    baseURL: "https://openrouter.ai/api/v1",
    adapter: "openai",
    region: "global",
    displayName: "OpenRouter",
  },
  deepseek: {
    apiKeyEnv: "DEEPSEEK_API_KEY",
    baseURL: "https://api.deepseek.com/v1",
    adapter: "openai",
    region: "domestic",
    displayName: "DeepSeek (国内)",
    hasRegionalVariants: true,
  },
  "deepseek-overseas": {
    apiKeyEnv: "DEEPSEEK_OVERSEAS_API_KEY",
    baseURL: "https://api.deepseek.com/v1",
    adapter: "openai",
    region: "overseas",
    displayName: "DeepSeek (海外)",
    hasRegionalVariants: true,
  },
  kimi: {
    apiKeyEnv: "KIMI_API_KEY",
    baseURL: "https://api.moonshot.cn/v1",
    adapter: "openai",
    region: "domestic",
    displayName: "KIMI (国内)",
    hasRegionalVariants: true,
  },
  "kimi-overseas": {
    apiKeyEnv: "KIMI_OVERSEAS_API_KEY",
    baseURL: "https://api.moonshot.ai/v1",
    adapter: "openai",
    region: "overseas",
    displayName: "KIMI (海外)",
    hasRegionalVariants: true,
  },
  zhipu: {
    apiKeyEnv: "ZHIPU_API_KEY",
    baseURL: "https://open.bigmodel.cn/api/paas/v4",
    adapter: "openai",
    region: "domestic",
    displayName: "GLM 智谱 (国内)",
    hasRegionalVariants: true,
  },
  "zhipu-overseas": {
    apiKeyEnv: "ZHIPU_OVERSEAS_API_KEY",
    baseURL: "https://api.z.ai/api/paas/v4",
    adapter: "openai",
    region: "overseas",
    displayName: "GLM 智谱 (海外)",
    hasRegionalVariants: true,
  },
  minimax: {
    apiKeyEnv: "MINIMAX_API_KEY",
    baseURL: "https://api.minimax.chat/v1",
    adapter: "openai",
    region: "domestic",
    displayName: "MiniMax (国内)",
    hasRegionalVariants: true,
  },
  "minimax-overseas": {
    apiKeyEnv: "MINIMAX_OVERSEAS_API_KEY",
    baseURL: "https://api.minimax.io/v1",
    adapter: "openai",
    region: "overseas",
    displayName: "MiniMax (海外)",
    hasRegionalVariants: true,
  },
  nim: {
    apiKeyEnv: "NIM_API_KEY",
    baseURL: "https://integrate.api.nvidia.com/v1",
    adapter: "openai",
    region: "global",
    displayName: "NVIDIA NIM",
  },
  // ─── Claude (Anthropic) 母公司 API 标准 ─────────────────────────
  "ofoxai-anthropic": {
    apiKeyEnv: "OFOXAI_ANTHROPIC_API_KEY",
    baseURL: "https://api.ofoxai.com/anthropic",
    adapter: "anthropic",
    region: "global",
    displayName: "OFOXAI (Claude 标准)",
  },
  // 2026-07-26 R5 修复：补齐 router 使用但 api-key-store 缺失的 provider
  "ofoxai-gemini": {
    apiKeyEnv: "OFOXAI_GEMINI_API_KEY",
    baseURL: "https://api.ofoxai.com/gemini",
    adapter: "gemini",
    region: "global",
    displayName: "OFOXAI (Gemini 标准)",
  },
  "nvidia-nim": {
    apiKeyEnv: "NIM_API_KEY",
    baseURL: "https://integrate.api.nvidia.com/v1",
    adapter: "openai",
    region: "global",
    displayName: "NVIDIA NIM",
  },
  // ─── OpenCode Go 套餐服务 ────────────────────────────────────────
  opencode: {
    apiKeyEnv: "OPENCODE_API_KEY",
    // OpenCode Go 官方 OpenAI 兼容端点（用户套餐为 Go；api.opencode.ai 网关返回 Not Found）
    baseURL: "https://opencode.ai/zen/go/v1",
    adapter: "opencode",
    region: "global",
    displayName: "OpenCode Go 套餐",
  },
};

type ModelProvider = keyof typeof PROVIDER_CONFIG;

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
 *
 * 返回字段包含：
 *  - provider:       provider 标识（如 kimi / kimi-overseas）
 *  - apiKeyEnv:      对应的环境变量名
 *  - baseURL:        实际生效的 API 端点
 *  - adapter:        API 协议适配器（openai / anthropic / gemini / opencode）
 *  - region:         部署区域（domestic / overseas / global）
 *  - displayName:    前端展示用名称
 *  - hasRegionalVariants: 是否有国内/海外两个变体
 *  - source:         密钥来源（env / runtime / none）
 *  - configured:     是否已配置（有可用密钥）
 *  - masked:         脱敏后的密钥预览
 */
export function listProviderStatus(): Array<{
  provider: string;
  apiKeyEnv: string;
  baseURL: string;
  adapter: ApiAdapter;
  region: ProviderRegion;
  displayName: string;
  hasRegionalVariants: boolean;
  source: "env" | "runtime" | "config" | "none";
  configured: boolean;
  masked: string;
}> {
  const out: Array<{
    provider: string;
    apiKeyEnv: string;
    baseURL: string;
    adapter: ApiAdapter;
    region: ProviderRegion;
    displayName: string;
    hasRegionalVariants: boolean;
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
      adapter: cfg.adapter,
      region: cfg.region,
      displayName: cfg.displayName,
      hasRegionalVariants: !!cfg.hasRegionalVariants,
      source: override ? "runtime" : envKey ? "env" : "none",
      configured: !!effectiveKey,
      masked: effectiveKey ? maskKey(effectiveKey) : "",
    });
  }

  return out;
}

/** 按适配器类型列出所有 providers（用于前端按 API 标准分组展示）。 */
export function listProvidersByAdapter(): Record<ApiAdapter, Array<{ provider: string; displayName: string; region: ProviderRegion }>> {
  const result: Record<ApiAdapter, Array<{ provider: string; displayName: string; region: ProviderRegion }>> = {
    openai: [],
    anthropic: [],
    gemini: [],
    opencode: [],
  };
  for (const [provider, cfg] of Object.entries(PROVIDER_CONFIG)) {
    result[cfg.adapter].push({ provider, displayName: cfg.displayName, region: cfg.region });
  }
  return result;
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
 * 只读 provider 的 baseURL/apiKeyEnv —— router 兼容层（router/models/providers.ts）
 * 的唯一数据源。全量字段（adapter/region/displayName）见 listProviderStatus。
 */
export function getProviderConfig(provider: string): { baseURL: string; apiKeyEnv: string } | undefined {
  const entry = PROVIDER_CONFIG[provider];
  if (!entry) return undefined;
  return { baseURL: entry.baseURL, apiKeyEnv: entry.apiKeyEnv };
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

/**
 * 测试 provider 的 API Key 连通性。
 *
 * 通过向 provider 的模型列表端点发送轻量级 GET 请求（不消耗 token），
 * 验证 API Key 是否有效、端点是否可达。
 *
 * 按 adapter 类型差异化适配：
 *  - openai/opencode: GET {baseURL}/models,  Authorization: Bearer {key}
 *  - anthropic:       GET {baseURL}/v1/models, x-api-key + anthropic-version
 *  - gemini:          GET {baseURL}/v1beta/models?key={key}
 *
 * 返回 { ok, latency?, modelCount?, error? } — ok=false 时 error 必填。
 */
export async function testProviderConnection(
  apiKey: string,
  baseURL: string,
  adapter: ApiAdapter,
): Promise<{ ok: boolean; latency?: number; modelCount?: number; error?: string }> {
  const start = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);

  try {
    const base = baseURL.replace(/\/$/, "");
    let url: string;
    let headers: Record<string, string>;

    if (adapter === "anthropic") {
      // Anthropic Messages API: /v1/models 端点
      url = `${base}/v1/models`;
      headers = {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      };
    } else if (adapter === "gemini") {
      // Gemini: key 作为 query 参数
      url = `${base}/v1beta/models?key=${encodeURIComponent(apiKey)}`;
      headers = {};
    } else {
      // OpenAI 兼容 (openai / opencode): /models 端点
      url = `${base}/models`;
      headers = { Authorization: `Bearer ${apiKey}` };
    }

    const response = await fetch(url, {
      method: "GET",
      headers,
      signal: controller.signal,
    });

    clearTimeout(timeout);
    const latency = Date.now() - start;

    if (response.ok) {
      // 尝试解析模型数量（非关键，失败不影响测试结果）
      let modelCount: number | undefined;
      try {
        const data = (await response.json()) as Record<string, unknown>;
        const dataArr = (data as { data?: unknown[] })?.data;
        const modelsArr = (data as { models?: unknown[] })?.models;
        if (Array.isArray(dataArr)) modelCount = dataArr.length;
        else if (Array.isArray(modelsArr)) modelCount = modelsArr.length;
      } catch {
        /* 解析失败不影响测试结果 */
      }
      return { ok: true, latency, modelCount };
    }

    // 非 2xx：提取错误信息
    let errorMsg = `HTTP ${response.status}`;
    try {
      const data = (await response.json()) as Record<string, unknown>;
      const errObj = data?.error as Record<string, unknown> | undefined;
      if (typeof errObj?.message === "string") errorMsg = errObj.message;
      else if (typeof data?.message === "string") errorMsg = data.message;
    } catch {
      /* 忽略解析失败 */
    }

    // 常见状态码友好提示
    if (response.status === 401 || response.status === 403) {
      errorMsg = `认证失败（${response.status}）：API Key 无效或权限不足`;
    }
    return { ok: false, latency, error: errorMsg };
  } catch (e) {
    clearTimeout(timeout);
    const latency = Date.now() - start;
    if (e instanceof Error && e.name === "AbortError") {
      return { ok: false, latency, error: "请求超时（8s），请检查网络或端点是否可达" };
    }
    return { ok: false, latency, error: e instanceof Error ? e.message : String(e) };
  }
}
