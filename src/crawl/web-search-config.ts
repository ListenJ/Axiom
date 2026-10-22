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

import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { getEffectiveApiKey, getProviderConfig } from "../utils/api-key-store.js";
import { readString } from "../utils/env.js";
import { logger } from "../utils/logger.js";

/** 默认配置路径（保持不变；测试可通过 env 覆盖，见 resolveWebSearchConfigPath）。 */
export const DEFAULT_WEB_SEARCH_CONFIG_PATH = "./config/web-search.yaml";

/**
 * 生效的配置文件路径。
 *
 * 默认值**严格不变**：未设置 `AXIOM_WEB_SEARCH_CONFIG` 时与历史行为完全一致。
 * 该 env 仅用于**隔离临时配置的集成测试**（测试把配置指向 mkdtemp 目录），
 * 生产代码不得据此做业务分支（2026-10-22 P1 审计 A5；D3 决策约束）。
 */
export function resolveWebSearchConfigPath(): string {
  // 统一经 utils/env.ts 读取（架构门禁要求 src 内 env 访问集中；env-example 完整性测试覆盖）
  const override = readString("AXIOM_WEB_SEARCH_CONFIG", "").trim();
  return override.length > 0 ? override : DEFAULT_WEB_SEARCH_CONFIG_PATH;
}

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
export function loadWebSearchConfig(path = resolveWebSearchConfigPath()): WebSearchConfig {
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

// ══════════════════════════════════════════════════════════════════
// 并发安全（2026-10-22 P1）：内容修订号 + 原子写 + 乐观并发（CAS）
// ══════════════════════════════════════════════════════════════════

/** 文件不存在时的固定修订号哨兵（保证"新建文件"也能参与 CAS，而不是每次随机）。 */
export const MISSING_CONFIG_REVISION = "missing";

/** 配置内容修订号：对**文件原始文本**取 sha256（前 16 hex）。任何字节变化都会换修订号。 */
export function computeWebSearchRevision(rawText: string | null): string {
  if (rawText === null) return MISSING_CONFIG_REVISION;
  return createHash("sha256").update(rawText, "utf8").digest("hex").slice(0, 16);
}

function readRawConfig(path: string): string | null {
  try {
    return existsSync(path) ? readFileSync(path, "utf-8") : null;
  } catch {
    return null;
  }
}

/** 读配置 + 当前修订号（GUI 用 revision 做 If-Match 乐观并发；文件缺失/损坏时 revision 仍可用）。 */
export function loadWebSearchConfigWithRevision(
  path = resolveWebSearchConfigPath(),
): { config: WebSearchConfig; revision: string } {
  const rawText = readRawConfig(path);
  return { config: loadWebSearchConfig(path), revision: computeWebSearchRevision(rawText) };
}

/** 并发冲突：客户端持有的修订号与磁盘当前内容不一致（HTTP 层映射为 409）。 */
export class WebSearchConfigConflictError extends Error {
  readonly code = "revision-conflict";
  constructor(
    readonly expectedRevision: string,
    readonly actualRevision: string,
  ) {
    super(`配置已被其他请求修改（期望修订 ${expectedRevision}，磁盘当前 ${actualRevision}），请刷新后重试`);
    this.name = "WebSearchConfigConflictError";
  }
}

/** 补丁校验失败（HTTP 层映射为 400；拒绝未知/非法字段，避免污染配置文件）。 */
export class WebSearchConfigValidationError extends Error {
  readonly code = "invalid-patch";
  constructor(message: string) {
    super(message);
    this.name = "WebSearchConfigValidationError";
  }
}

export interface ApplyWebSearchPatchResult {
  config: WebSearchConfig;
  /** 实际生效的字段（`section.key` 形式）；未知字段不会出现在这里，而是直接 400 */
  applied: string[];
}

const AGGREGATE_RULES = {
  max_results: { kind: "int", min: 1, max: 50 },
  per_engine: { kind: "int", min: 1, max: 20 },
  timeout_ms: { kind: "int", min: 100, max: 120_000 },
  dedupe: { kind: "bool" },
  cache_ttl_sec: { kind: "int", min: 0, max: 86_400 },
  min_relevance: { kind: "num", min: 0, max: 1 },
} as const;

const SEARXNG_RULES = {
  enabled: { kind: "bool" },
  auto_deploy: { kind: "bool" },
  base_url: { kind: "url" },
  bind: { kind: "string", maxLen: 128 },
  port: { kind: "int", min: 1, max: 65_535 },
  secret_key_env: { kind: "string", maxLen: 128 },
  fallback_instances: { kind: "urlArray" },
  fallback_timeout_ms: { kind: "int", min: 100, max: 120_000 },
} as const;

const POLICY_RULES = {
  respect_robots: { kind: "bool" },
  max_concurrency: { kind: "int", min: 1, max: 32 },
  request_delay_ms: { kind: "int", min: 0, max: 60_000 },
  user_agent: { kind: "string", maxLen: 256 },
} as const;

type Rule = {
  kind: "int" | "num" | "bool" | "string" | "url" | "urlArray";
  min?: number;
  max?: number;
  maxLen?: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * P5.1（复核 R2）：`${VAR}` 占位在 load 时被 `resolveEnvVars` 解析为实际值且不可逆。
 * 因此写入路径必须拒绝占位，否则 GUI 回写会把解析值**明文落盘**（密钥泄露面）。
 *  - 补丁值：任何字符串 / URL 值含占位 → 400 invalid-patch；
 *  - 磁盘原文：值位置含占位 → 拒绝保存（提示直接编辑文件或改用 api_key_env）。
 * 注释行里的占位不触发（避免配置头注释误伤）。
 */
const ENV_PLACEHOLDER_IN_VALUE_RE = /\$\{[A-Z][A-Z0-9_]*\}/;
const ENV_PLACEHOLDER_IN_RAW_RE = /(^|\n)[ \t]*(?:-\s+|[^#\s][^:\n]*:\s+)[^\n]*\$\{[A-Z][A-Z0-9_]*\}/;

function assertNoEnvPlaceholder(label: string, value: string): void {
  if (ENV_PLACEHOLDER_IN_VALUE_RE.test(value)) {
    throw new WebSearchConfigValidationError(
      label + " 不支持 ${VAR} 占位（GUI 回写会把解析值明文落盘）；密钥请使用 api_key_env，或直接编辑配置文件",
    );
  }
}

function validateRule(label: string, rule: Rule, value: unknown): string | number | boolean | string[] {
  switch (rule.kind) {
    case "bool":
      if (typeof value !== "boolean") throw new WebSearchConfigValidationError(`${label} 必须是布尔值`);
      return value;
    case "int":
    case "num": {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new WebSearchConfigValidationError(`${label} 必须是数字`);
      }
      if (rule.kind === "int" && !Number.isInteger(value)) {
        throw new WebSearchConfigValidationError(`${label} 必须是整数`);
      }
      if (rule.min !== undefined && value < rule.min) {
        throw new WebSearchConfigValidationError(`${label} 不能小于 ${rule.min}`);
      }
      if (rule.max !== undefined && value > rule.max) {
        throw new WebSearchConfigValidationError(`${label} 不能大于 ${rule.max}`);
      }
      return value;
    }
    case "string": {
      if (typeof value !== "string") throw new WebSearchConfigValidationError(`${label} 必须是字符串`);
      if (rule.maxLen !== undefined && value.length > rule.maxLen) {
        throw new WebSearchConfigValidationError(`${label} 长度不能超过 ${rule.maxLen}`);
      }
      if (/[\r\n]/.test(value)) throw new WebSearchConfigValidationError(`${label} 不能包含换行`);
      assertNoEnvPlaceholder(label, value);
      return value;
    }
    case "url": {
      if (typeof value !== "string") throw new WebSearchConfigValidationError(`${label} 必须是字符串`);
      assertNoEnvPlaceholder(label, value);
      let parsed: URL;
      try {
        parsed = new URL(value);
      } catch {
        throw new WebSearchConfigValidationError(`${label} 不是合法 URL`);
      }
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        throw new WebSearchConfigValidationError(`${label} 只支持 http/https`);
      }
      return value;
    }
    case "urlArray": {
      if (!Array.isArray(value)) throw new WebSearchConfigValidationError(`${label} 必须是数组`);
      return value.map((item, i) => validateRule(`${label}[${i}]`, { kind: "url" }, item) as string);
    }
  }
}

function applySection(
  source: Record<string, unknown>,
  rules: Record<string, Rule>,
  target: Record<string, unknown>,
  section: string,
  applied: string[],
  unknownKeys: string[],
): void {
  for (const [key, value] of Object.entries(source)) {
    const rule = rules[key];
    if (!rule) {
      unknownKeys.push(`${section}.${key}`);
      continue;
    }
    target[key] = validateRule(`${section}.${key}`, rule, value);
    applied.push(`${section}.${key}`);
  }
}

/**
 * 把 POST 补丁应用到当前配置：**只接受已知字段并做类型/范围校验**。
 * 未知字段（含未知 engine id）**拒绝**（D3 决策调整：不做静默忽略），返回 400。
 * 纯函数（不改入参），供路由与单测共用；任何非法值抛 `WebSearchConfigValidationError`。
 */
export function applyWebSearchPatch(current: WebSearchConfig, patch: unknown): ApplyWebSearchPatchResult {
  if (!isRecord(patch)) {
    throw new WebSearchConfigValidationError("请求体必须是 JSON 对象");
  }
  const next = structuredClone(current) as unknown as {
    aggregate: Record<string, unknown>;
    searxng: Record<string, unknown>;
    policy: Record<string, unknown>;
    engines: WebSearchEngineConfig[];
  };
  const applied: string[] = [];
  const unknownKeys: string[] = [];

  // engines：只允许 { id, enabled?, weight? }；未知 id 视为非法（拒绝，不做静默忽略）
  if (patch.engines !== undefined) {
    if (!Array.isArray(patch.engines)) {
      throw new WebSearchConfigValidationError("engines 必须是数组");
    }
    for (const raw of patch.engines) {
      if (!isRecord(raw) || typeof raw.id !== "string") {
        throw new WebSearchConfigValidationError("engines 每项必须是 { id, enabled?, weight? }");
      }
      const engine = next.engines.find((e) => e.id === raw.id);
      if (!engine) {
        unknownKeys.push(`engines.${raw.id}`);
        continue;
      }
      if (raw.enabled !== undefined) {
        engine.enabled = validateRule(`engines.${raw.id}.enabled`, { kind: "bool" }, raw.enabled) as boolean;
        applied.push(`engines.${raw.id}.enabled`);
      }
      if (raw.weight !== undefined) {
        engine.weight = validateRule(`engines.${raw.id}.weight`, { kind: "num", min: 0, max: 10 }, raw.weight) as number;
        applied.push(`engines.${raw.id}.weight`);
      }
    }
  }

  if (patch.aggregate !== undefined) {
    if (!isRecord(patch.aggregate)) throw new WebSearchConfigValidationError("aggregate 必须是对象");
    applySection(patch.aggregate, AGGREGATE_RULES as Record<string, Rule>, next.aggregate, "aggregate", applied, unknownKeys);
  }
  if (patch.searxng !== undefined) {
    if (!isRecord(patch.searxng)) throw new WebSearchConfigValidationError("searxng 必须是对象");
    applySection(patch.searxng, SEARXNG_RULES as Record<string, Rule>, next.searxng, "searxng", applied, unknownKeys);
  }
  if (patch.policy !== undefined) {
    if (!isRecord(patch.policy)) throw new WebSearchConfigValidationError("policy 必须是对象");
    applySection(patch.policy, POLICY_RULES as Record<string, Rule>, next.policy, "policy", applied, unknownKeys);
  }

  // 顶层未知字段同样拒绝（白名单语义：只允许 engines/aggregate/searxng/policy，以及 ifRevision）
  for (const key of Object.keys(patch)) {
    if (key === "engines" || key === "aggregate" || key === "searxng" || key === "policy") continue;
    if (key === "ifRevision") continue; // 并发控制元数据，由路由消费
    unknownKeys.push(key);
  }

  if (unknownKeys.length > 0) {
    throw new WebSearchConfigValidationError(
      `未知配置字段（已拒绝写入）：${unknownKeys.join("、")}`,
    );
  }

  return { config: next as unknown as WebSearchConfig, applied };
}

export interface SaveWebSearchConfigOptions {
  /**
   * 乐观并发：期望的磁盘当前修订号（来自 `loadWebSearchConfigWithRevision`）。
   * 传入且与磁盘不一致 → 抛 `WebSearchConfigConflictError`（HTTP 409）。
   * 不传 = 旧行为（最后写入者胜；仅为兼容既有调用点保留）。
   */
  expectedRevision?: string;
}

/**
 * 写回配置（GUI 修改后调用）。返回**写入后**的新修订号。
 *
 * 2026-10-22 P1 改造（审计 A1/A2）：
 *   1. **原子写**：同目录临时文件 → `rename` 替换，崩溃/磁盘满不会留下半截 YAML；
 *      替换前尽力保留 `${path}.bak`（上一份可解析内容），失败不阻断主流程。
 *   2. **CAS**：传入 `expectedRevision` 时先比对磁盘当前内容修订号，不一致拒绝写入。
 *
 * 注意（审计 A4，原注释声称"写入前把已解析密钥还原为 ${ENV_VAR} 占位"——实现从未如此）：
 *   `loadWebSearchConfig` 会把 `${VAR}` 解析成实际值，且解析不可逆；因此**回写到本文件的字段
 *   不应使用 `${VAR}`**（本文件密钥一律用 `api_key_env` 变量名）。该限制已登记为债务。
 */
export function saveWebSearchConfig(
  cfg: WebSearchConfig,
  path = resolveWebSearchConfigPath(),
  opts: SaveWebSearchConfigOptions = {},
): string {
  const previousRaw = readRawConfig(path);
  const actualRevision = computeWebSearchRevision(previousRaw);
  if (opts.expectedRevision !== undefined && opts.expectedRevision !== actualRevision) {
    throw new WebSearchConfigConflictError(opts.expectedRevision, actualRevision);
  }

  // P5.1（复核 R2）：磁盘原文的值位置含 `${VAR}` 占位时拒绝回写——load 已把它解析成实际值，
  // 直接保存会把解析值明文落盘。要求用户直接编辑文件或改用 api_key_env（密钥引用名）。
  if (previousRaw !== null && ENV_PLACEHOLDER_IN_RAW_RE.test(previousRaw)) {
    throw new WebSearchConfigValidationError(
      "配置文件含 ${VAR} 占位：GUI 回写会把解析值明文落盘（已拒绝保存）。请直接编辑配置文件，或改用 api_key_env 后重试",
    );
  }

  const serialized = stringifyYaml(cfg, { lineWidth: 100 });
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });

  // 备份轮换（A1）：先把旧内容写到 .bak.tmp，**成功 rename 之后**再转动到 .bak。
  // 这样：写入失败时 .bak 保持上一份完好内容；.bak 永远只有最近 1 份，不会无限增长。
  const bakTmp = `${path}.bak.tmp`;
  if (previousRaw !== null) {
    try {
      copyFileSync(path, bakTmp);
    } catch (e) {
      logger.warn("[WebSearchConfig] 备份旧配置失败（继续原子写入）", {
        path,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  try {
    writeFileSync(tmp, serialized, "utf-8");
    renameSync(tmp, path);
  } catch (e) {
    for (const leftover of [tmp, bakTmp]) {
      try {
        rmSync(leftover, { force: true });
      } catch {
        /* 清理失败不影响抛错 */
      }
    }
    logger.error("[WebSearchConfig] 保存失败", e as Error);
    throw e;
  }

  // 主文件已原子替换成功 → 轮换备份（旧内容成为 .bak，覆盖更早的 .bak）
  if (previousRaw !== null) {
    try {
      renameSync(bakTmp, `${path}.bak`);
    } catch (e) {
      logger.warn("[WebSearchConfig] 备份轮换失败（忽略，不影响主写入）", {
        path,
        error: e instanceof Error ? e.message : String(e),
      });
      try {
        rmSync(bakTmp, { force: true });
      } catch {
        /* 忽略 */
      }
    }
  }

  const newRevision = computeWebSearchRevision(serialized);
  logger.info("[WebSearchConfig] 已保存", { path, revision: newRevision });
  return newRevision;
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
export function listEngineStatus(path = resolveWebSearchConfigPath()): EngineStatus[] {
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

/** 开关某个引擎并写回文件（2026-10-22：改为 CAS 写入，避免与 GUI 并发保存互相覆盖）。返回是否成功（id 不存在则 false） */
export function setEngineEnabled(id: string, enabled: boolean, path = resolveWebSearchConfigPath()): boolean {
  const { config, revision } = loadWebSearchConfigWithRevision(path);
  const engine = config.engines.find((e) => e.id === id);
  if (!engine) return false;
  engine.enabled = enabled;
  saveWebSearchConfig(config, path, { expectedRevision: revision });
  return true;
}

/** 汇总：给 GUI / 文档用的一句话现状说明 */
export function describeWebSearchSetup(path = resolveWebSearchConfigPath()): {
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
