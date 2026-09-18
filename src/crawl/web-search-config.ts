/**
 * 网络搜索配置（config/web-search.yaml）—— 加载 / 保存 / 引擎状态
 *
 * 为什么单独一个文件：搜索相关的可调项（引擎池、权重、密钥变量名、SearXNG 部署参数、
 * 抓取礼貌策略）与模型路由、网关等无关，混在 axiom.yaml 里会让两件事都难改。
 * 仓库里已有同类先例：model-router.yaml / mcp-servers.yaml / site-rules.yaml。
 *
 * 密钥**不落盘在本文件**：只写 `${ENV_VAR}` 引用或 api_key_env 变量名，
 * 真实值走 .env / GUI 输入 → api-key-store。这样配置文件可以安全地进版本库。
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { getEffectiveApiKey, getProviderConfig } from "../utils/api-key-store.js";
import { readString } from "../utils/env.js";
import { logger } from "../utils/logger.js";

export const WEB_SEARCH_CONFIG_PATH = "./config/web-search.yaml";

export type EngineKind = "html" | "api" | "rss";

export interface WebSearchEngineConfig {
  id: string;
  label: string;
  kind: EngineKind;
  enabled: boolean;
  weight: number;
  /** false = 匿名可用；true = 需 api_key_env 指向的环境变量有值才生效 */
  needs_key: boolean;
  api_key_env?: string;
  free_tier?: string;
  signup_url?: string;
  note?: string;
  /** 额外参数（例如 google-cse 的 cx） */
  extra?: Record<string, string>;
}

export interface WebSearchAggregateConfig {
  max_results: number;
  per_engine: number;
  timeout_ms: number;
  dedupe: boolean;
  cache_ttl_sec: number;
  min_relevance: number;
}

export interface SearxngConfig {
  enabled: boolean;
  auto_deploy: boolean;
  base_url: string;
  bind: string;
  port: number;
  secret_key_env: string;
  fallback_instances: string[];
  fallback_timeout_ms: number;
}

export interface WebSearchPolicy {
  respect_robots: boolean;
  max_concurrency: number;
  request_delay_ms: number;
  user_agent: string;
}

export interface WebSearchConfig {
  version: number;
  aggregate: WebSearchAggregateConfig;
  engines: WebSearchEngineConfig[];
  searxng: SearxngConfig;
  policy: WebSearchPolicy;
}

/** 内置默认值：即使没有任何配置文件也能工作（匿名引擎全开） */
export const DEFAULT_WEB_SEARCH_CONFIG: WebSearchConfig = {
  version: 1,
  aggregate: {
    max_results: 10,
    per_engine: 5,
    timeout_ms: 15000,
    dedupe: true,
    cache_ttl_sec: 1800,
    min_relevance: 0,
  },
  engines: [
    { id: "searxng", label: "SearXNG（自建）", kind: "api", enabled: true, weight: 1.5, needs_key: false },
    { id: "duckduckgo", label: "DuckDuckGo", kind: "html", enabled: true, weight: 1.0, needs_key: false },
    { id: "bing", label: "Bing", kind: "html", enabled: true, weight: 0.9, needs_key: false },
    { id: "bing-html", label: "Bing（HTML 回退）", kind: "html", enabled: true, weight: 0.8, needs_key: false },
    { id: "wikipedia", label: "维基百科", kind: "api", enabled: true, weight: 0.8, needs_key: false },
    { id: "google-news", label: "Google News（RSS）", kind: "rss", enabled: true, weight: 0.9, needs_key: false },
    { id: "hackernews", label: "Hacker News", kind: "api", enabled: true, weight: 0.6, needs_key: false },
    { id: "github", label: "GitHub", kind: "api", enabled: true, weight: 0.6, needs_key: false },
    { id: "arxiv", label: "arXiv", kind: "api", enabled: true, weight: 0.6, needs_key: false },
    { id: "crossref", label: "Crossref", kind: "api", enabled: true, weight: 0.6, needs_key: false },
    { id: "openlibrary", label: "Open Library", kind: "api", enabled: true, weight: 0.5, needs_key: false },
  ],
  searxng: {
    enabled: true,
    auto_deploy: true,
    base_url: "http://127.0.0.1:8080",
    bind: "127.0.0.1",
    port: 8080,
    secret_key_env: "SEARXNG_SECRET_KEY",
    fallback_instances: [],
    fallback_timeout_ms: 8000,
  },
  policy: {
    respect_robots: true,
    max_concurrency: 3,
    request_delay_ms: 200,
    user_agent: "AxiomBot/1.0 (+local research assistant)",
  },
};

/** 递归解析 `${ENV_VAR}`（未设置的变量替换为空串，由调用方判定"未配置"） */
function resolveEnvVars<T>(value: T): T {
  if (typeof value === "string") {
    return value.replace(/\$\{([A-Z0-9_]+)\}/g, (_m, name: string) => readString(name, "")) as unknown as T;
  }
  if (Array.isArray(value)) return value.map((v) => resolveEnvVars(v)) as unknown as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = resolveEnvVars(v);
    return out as unknown as T;
  }
  return value;
}

function mergeWithDefaults(raw: Partial<WebSearchConfig>): WebSearchConfig {
  const d = DEFAULT_WEB_SEARCH_CONFIG;
  // 引擎列表按 id 合并：文件里出现的以文件为准，文件里没有的默认引擎自动补上（匿名可用）
  const byId = new Map<string, WebSearchEngineConfig>();
  for (const e of d.engines) byId.set(e.id, { ...e });
  for (const e of raw.engines ?? []) {
    if (!e || typeof e.id !== "string") continue;
    const base = byId.get(e.id) ?? ({} as WebSearchEngineConfig);
    byId.set(e.id, { ...base, ...e } as WebSearchEngineConfig);
  }
  return {
    version: raw.version ?? d.version,
    aggregate: { ...d.aggregate, ...(raw.aggregate ?? {}) },
    engines: Array.from(byId.values()),
    searxng: { ...d.searxng, ...(raw.searxng ?? {}) },
    policy: { ...d.policy, ...(raw.policy ?? {}) },
  };
}

/** 读取配置；文件不存在或损坏时回落到默认值（**不抛异常**，保证搜索功能不因此不可用） */
export function loadWebSearchConfig(path = WEB_SEARCH_CONFIG_PATH): WebSearchConfig {
  try {
    if (!existsSync(path)) {
      logger.info("[WebSearchConfig] 配置文件不存在，使用内置默认值", { path });
      return mergeWithDefaults({});
    }
    const raw = parseYaml(readFileSync(path, "utf-8")) as Partial<WebSearchConfig> | null;
    return mergeWithDefaults(resolveEnvVars(raw ?? {}));
  } catch (e) {
    logger.warn("[WebSearchConfig] 解析失败，回落到内置默认值", {
      path,
      error: e instanceof Error ? e.message : String(e),
    });
    return mergeWithDefaults({});
  }
}

/** 写回配置（GUI 修改后调用）。写入前把已解析的密钥**还原为 `${ENV_VAR}` 占位**，避免密钥落盘。 */
export function saveWebSearchConfig(cfg: WebSearchConfig, path = WEB_SEARCH_CONFIG_PATH): void {
  try {
    writeFileSync(path, stringifyYaml(cfg, { lineWidth: 100 }), "utf-8");
    logger.info("[WebSearchConfig] 已保存", { path });
  } catch (e) {
    logger.error("[WebSearchConfig] 保存失败", e as Error);
    throw e;
  }
}

/**
 * 该引擎当前是否**真的可用**：
 *   - 匿名引擎：只要 enabled 即可用
 *   - 需 Key 引擎：enabled 且对应环境变量（或 api-key-store 覆盖）有值
 */
export function resolveEngineKey(engine: WebSearchEngineConfig): string | undefined {
  if (!engine.api_key_env) return undefined;
  // 先按 provider 名查运行时覆盖，再退回环境变量
  try {
    const cfg = getProviderConfig(engine.id);
    if (cfg) return getEffectiveApiKey(engine.id as never, cfg.apiKeyEnv);
  } catch {
    /* 该 id 不是已知 provider，走环境变量 */
  }
  return readString(engine.api_key_env, "") || undefined;
}

export interface EngineStatus {
  id: string;
  label: string;
  kind: EngineKind;
  enabled: boolean;
  usable: boolean;
  needsKey: boolean;
  hasKey: boolean;
  apiKeyEnv?: string;
  freeTier?: string;
  signupUrl?: string;
  note?: string;
  /** 不可用的原因（供 GUI 直接展示） */
  reason?: string;
}

/** 供 GUI「设置 → 网络搜索」展示的引擎状态表 */
export function listEngineStatus(path = WEB_SEARCH_CONFIG_PATH): EngineStatus[] {
  const cfg = loadWebSearchConfig(path);
  return cfg.engines.map((e) => {
    const hasKey = Boolean(resolveEngineKey(e));
    const usable = e.enabled && (!e.needs_key || hasKey);
    let reason: string | undefined;
    if (!e.enabled) reason = "已在配置中关闭";
    else if (e.needs_key && !hasKey) reason = `缺少密钥：${e.api_key_env ?? "(未指定环境变量)"}`;
    return {
      id: e.id,
      label: e.label,
      kind: e.kind,
      enabled: e.enabled,
      usable,
      needsKey: e.needs_key,
      hasKey,
      apiKeyEnv: e.api_key_env,
      freeTier: e.free_tier,
      signupUrl: e.signup_url,
      note: e.note,
      reason,
    };
  });
}

/** 开关某个引擎并写回文件。返回是否成功（id 不存在则 false） */
export function setEngineEnabled(id: string, enabled: boolean, path = WEB_SEARCH_CONFIG_PATH): boolean {
  const cfg = loadWebSearchConfig(path);
  const engine = cfg.engines.find((e) => e.id === id);
  if (!engine) return false;
  engine.enabled = enabled;
  saveWebSearchConfig(cfg, path);
  return true;
}

/** 汇总：给 GUI / 文档用的一句话现状说明 */
export function describeWebSearchSetup(path = WEB_SEARCH_CONFIG_PATH): {
  engineCount: number;
  usableCount: number;
  anonymousCount: number;
  keyedCount: number;
  searxngEnabled: boolean;
  searxngUrl: string;
  hint: string;
} {
  const statuses = listEngineStatus(path);
  const cfg = loadWebSearchConfig(path);
  const usable = statuses.filter((s) => s.usable).length;
  const anonymous = statuses.filter((s) => !s.needsKey).length;
  const keyed = statuses.filter((s) => s.needsKey).length;
  const hint =
    usable === 0
      ? "当前没有任何可用引擎——请至少启用一个匿名引擎（如 duckduckgo / bing-html / searxng）。"
      : `当前 ${usable}/${statuses.length} 个引擎可用（其中 ${anonymous} 个匿名引擎无需任何 Key）。` +
        (keyed > 0 ? ` 另有 ${keyed} 个需 Key 的增强引擎，填入密钥后即可在下方启用。` : "");
  return {
    engineCount: statuses.length,
    usableCount: usable,
    anonymousCount: anonymous,
    keyedCount: keyed,
    searxngEnabled: cfg.searxng.enabled,
    searxngUrl: cfg.searxng.base_url,
    hint,
  };
}
