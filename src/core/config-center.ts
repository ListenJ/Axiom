/**
 * 统一配置中心 v2.0 — 交互式配置管理
 *
 * 设计目标:
 *   - 单一入口管理所有配置 (ENV + YAML + Runtime)
 *   - 交互式向导引导用户完成初始配置
 *   - 配置热重载，无需重启
 *   - 配置验证和自动修复建议
 *   - 配置变更审计日志
 *
 * 配置优先级: Runtime Override > ENV > YAML > Default
 */

import fs from "fs";
import path from "path";
import YAML from "yaml";
import { logger } from "../utils/logger.js";

// ═══════════════════════════════════════════════════════════════
// 类型定义
// ═══════════════════════════════════════════════════════════════

export interface ConfigSchema {
  key: string;
  envVar: string;
  yamlPath: string;
  type: "string" | "number" | "boolean" | "url" | "api_key" | "path";
  required: boolean;
  default?: unknown;
  description: string;
  category: "gateway" | "model" | "memory" | "crawler" | "security" | "advanced";
  sensitive?: boolean; // API key 等敏感信息
  validator?: (val: unknown) => { valid: boolean; message?: string };
}

export interface ConfigValue {
  key: string;
  value: unknown;
  source: "default" | "yaml" | "env" | "runtime";
  lastModified: number;
  validated: boolean;
}

export interface ConfigAuditEntry {
  key: string;
  oldValue: unknown;
  newValue: unknown;
  source: string;
  timestamp: number;
  actor: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: Array<{ key: string; message: string; suggestion?: string }>;
  warnings: Array<{ key: string; message: string; suggestion?: string }>;
  missing: Array<{ key: string; envVar: string; description: string }>;
}

// ═══════════════════════════════════════════════════════════════
// 配置 Schema 定义
// ═══════════════════════════════════════════════════════════════

export const CONFIG_SCHEMA: ConfigSchema[] = [
  // Gateway
  { key: "gateway.port", envVar: "AXIOM_GATEWAY_PORT", yamlPath: "gateway.port", type: "number", required: true, default: 18789, description: "HTTP 服务端口", category: "gateway" },
  { key: "gateway.bind", envVar: "AXIOM_BIND", yamlPath: "gateway.bind", type: "string", required: true, default: "127.0.0.1", description: "绑定地址", category: "gateway" },
  { key: "gateway.auth_token", envVar: "AXIOM_AUTH_TOKEN", yamlPath: "gateway.auth.token", type: "api_key", required: false, description: "API 鉴权 Token", category: "security", sensitive: true },

  // Models
  { key: "model.siliconflow_key", envVar: "SILICONFLOW_API_KEY", yamlPath: "models.0.apiKey", type: "api_key", required: false, description: "硅基流动 API Key", category: "model", sensitive: true },
  { key: "model.ofoxai_key", envVar: "OFOXAI_API_KEY", yamlPath: "models.1.apiKey", type: "api_key", required: false, description: "OfoxAI API Key", category: "model", sensitive: true },
  { key: "model.openrouter_key", envVar: "OPENROUTER_API_KEY", yamlPath: "models.2.apiKey", type: "api_key", required: false, description: "OpenRouter API Key", category: "model", sensitive: true },
  { key: "model.deepseek_key", envVar: "DEEPSEEK_API_KEY", yamlPath: "models.3.apiKey", type: "api_key", required: false, description: "DeepSeek API Key", category: "model", sensitive: true },
  { key: "model.kimi_key", envVar: "KIMI_API_KEY", yamlPath: "models.4.apiKey", type: "api_key", required: false, description: "Kimi API Key", category: "model", sensitive: true },
  { key: "model.minimax_key", envVar: "MINIMAX_API_KEY", yamlPath: "models.5.apiKey", type: "api_key", required: false, description: "MiniMax API Key", category: "model", sensitive: true },

  // Memory
  { key: "memory.vault_path", envVar: "OBSIDIAN_VAULT_PATH", yamlPath: "memory.vaultPath", type: "path", required: true, default: "./axiom-memory", description: "Obsidian Vault 路径", category: "memory" },
  { key: "memory.database_path", envVar: "DATABASE_PATH", yamlPath: "memory.databasePath", type: "path", required: true, default: "./data/agent.db", description: "SQLite 数据库路径", category: "memory" },
  { key: "memory.redis_url", envVar: "REDIS_URL", yamlPath: "memory.redisUrl", type: "url", required: false, description: "Redis URL (可选)", category: "memory" },

  // Crawler
  { key: "crawler.serpapi_key", envVar: "SERPAPI_KEY", yamlPath: "crawler.serpapiKey", type: "api_key", required: false, description: "SerpAPI Key (搜索)", category: "crawler", sensitive: true },
  { key: "crawler.max_concurrent", envVar: "CRAWLER_MAX_CONCURRENT", yamlPath: "crawler.maxConcurrent", type: "number", required: true, default: 3, description: "最大并发抓取数", category: "crawler" },

  // Security
  { key: "security.cors_origins", envVar: "CORS_ORIGINS", yamlPath: "security.corsOrigins", type: "string", required: false, default: "", description: "CORS 允许域名（逗号分隔）", category: "security" },
  { key: "security.max_body_size", envVar: "MAX_BODY_SIZE", yamlPath: "security.maxBodySize", type: "number", required: true, default: 1048576, description: "最大请求体大小 (bytes)", category: "security" },

  // Advanced
  { key: "advanced.codegraph_auto_index", envVar: "CODEGRAPH_AUTO_INDEX", yamlPath: "advanced.codegraphAutoIndex", type: "boolean", required: false, default: false, description: "启动时自动索引 CodeGraph", category: "advanced" },
  { key: "advanced.opencode_default_model", envVar: "OPENCODE_DEFAULT_MODEL", yamlPath: "advanced.opencodeDefaultModel", type: "string", required: false, default: "opencode/deepseek-v4-flash-free", description: "OpenCode 默认模型", category: "advanced" },
];

// ═══════════════════════════════════════════════════════════════
// 配置中心主类
// ═══════════════════════════════════════════════════════════════

export class ConfigCenter {
  private values = new Map<string, ConfigValue>();
  private auditLog: ConfigAuditEntry[] = [];
  private yamlPath: string;
  private yamlData: Record<string, unknown> = {};
  private listeners = new Set<(key: string, value: unknown) => void>();

  constructor(yamlPath = "./config/axiom.yaml") {
    this.yamlPath = yamlPath;
    this.loadAll();
  }

  // ---------------------------------------------------------------------------
  // 加载
  // ---------------------------------------------------------------------------

  private loadAll(): void {
    // 1. 加载默认值
    for (const schema of CONFIG_SCHEMA) {
      if (schema.default !== undefined) {
        this.values.set(schema.key, {
          key: schema.key,
          value: schema.default,
          source: "default",
          lastModified: 0,
          validated: true,
        });
      }
    }

    // 2. 加载 YAML
    if (fs.existsSync(this.yamlPath)) {
      try {
        const raw = fs.readFileSync(this.yamlPath, "utf-8");
        this.yamlData = resolveEnvVars(YAML.parse(raw)) as Record<string, unknown>;
        for (const schema of CONFIG_SCHEMA) {
          const val = getPath(this.yamlData, schema.yamlPath);
          if (val !== undefined) {
            this.values.set(schema.key, {
              key: schema.key,
              value: val,
              source: "yaml",
              lastModified: Date.now(),
              validated: true,
            });
          }
        }
      } catch (e) {
        logger.warn("[ConfigCenter] Failed to load YAML", { error: (e as Error).message });
      }
    }

    // 3. 加载 ENV (最高优先级)
    for (const schema of CONFIG_SCHEMA) {
      const envVal = process.env[schema.envVar];
      if (envVal !== undefined && envVal !== "") {
        const parsed = this.parseValue(envVal, schema.type);
        this.values.set(schema.key, {
          key: schema.key,
          value: parsed,
          source: "env",
          lastModified: Date.now(),
          validated: true,
        });
      }
    }
  }

  // ---------------------------------------------------------------------------
  // 读取
  // ---------------------------------------------------------------------------

  get<T = unknown>(key: string): T | undefined {
    return this.values.get(key)?.value as T | undefined;
  }

  getString(key: string): string {
    return String(this.get(key) ?? "");
  }

  getNumber(key: string): number {
    return Number(this.get(key) ?? 0);
  }

  getBoolean(key: string): boolean {
    const val = this.get(key);
    if (typeof val === "boolean") return val;
    if (typeof val === "string") return val.toLowerCase() === "true";
    return Boolean(val);
  }

  /** 获取原始 YAML 数据 */
  getYamlData(): Record<string, unknown> {
    return this.yamlData;
  }

  /** 获取脱敏后的值（用于日志和前端展示） */
  getMasked(key: string): string {
    const schema = CONFIG_SCHEMA.find((s) => s.key === key);
    const val = this.getString(key);
    if (schema?.sensitive && val.length > 8) {
      return val.slice(0, 4) + "****" + val.slice(-4);
    }
    return val;
  }

  /** 获取所有配置 */
  getAll(): Record<string, { value: unknown; source: string; masked: string }> {
    const result: Record<string, { value: unknown; source: string; masked: string }> = {};
    for (const [key, val] of this.values) {
      result[key] = {
        value: val.value,
        source: val.source,
        masked: this.getMasked(key),
      };
    }
    return result;
  }

  /** 按分类获取 */
  getByCategory(category: ConfigSchema["category"]): Array<{ key: string; value: unknown; masked: string; description: string }> {
    return CONFIG_SCHEMA
      .filter((s) => s.category === category)
      .map((s) => ({
        key: s.key,
        value: this.get(s.key),
        masked: this.getMasked(s.key),
        description: s.description,
      }));
  }

  // ---------------------------------------------------------------------------
  // 写入
  // ---------------------------------------------------------------------------

  set(key: string, value: unknown, actor = "system", persist = true): void {
    const schema = CONFIG_SCHEMA.find((s) => s.key === key);
    if (!schema) {
      logger.warn("[ConfigCenter] Unknown config key", { key });
      return;
    }

    const oldValue = this.get(key);

    // 验证
    if (schema.validator) {
      const result = schema.validator(value);
      if (!result.valid) {
        logger.warn("[ConfigCenter] Validation failed", { key, message: result.message });
        return;
      }
    }

    // 审计日志
    this.auditLog.push({
      key,
      oldValue,
      newValue: value,
      source: "runtime",
      timestamp: Date.now(),
      actor,
    });

    this.values.set(key, {
      key,
      value,
      source: "runtime",
      lastModified: Date.now(),
      validated: true,
    });

    // 持久化到 YAML
    if (persist) {
      this.persistToYaml(key, value);
    }

    // 通知监听器
    for (const listener of this.listeners) {
      try { listener(key, value); } catch {}
    }

    logger.info("[ConfigCenter] Config updated", { key, actor });
  }

  /** 批量设置 */
  setBatch(entries: Array<{ key: string; value: unknown }>, actor = "system"): void {
    for (const { key, value } of entries) {
      this.set(key, value, actor, false);
    }
    this.saveYaml();
  }

  // ---------------------------------------------------------------------------
  // 验证
  // ---------------------------------------------------------------------------

  validate(): ValidationResult {
    const errors: ValidationResult["errors"] = [];
    const warnings: ValidationResult["warnings"] = [];
    const missing: ValidationResult["missing"] = [];

    for (const schema of CONFIG_SCHEMA) {
      const value = this.get(schema.key);

      // 必填检查
      if (schema.required && (value === undefined || value === "" || value === null)) {
        missing.push({
          key: schema.key,
          envVar: schema.envVar,
          description: schema.description,
        });
        continue;
      }

      if (value === undefined) continue;

      // 类型检查
      const typeCheck = this.checkType(value, schema.type);
      if (!typeCheck.valid) {
        errors.push({
          key: schema.key,
          message: typeCheck.message!,
          suggestion: `应为 ${schema.type} 类型`,
        });
      }

      // 自定义验证
      if (schema.validator) {
        const result = schema.validator(value);
        if (!result.valid) {
          errors.push({ key: schema.key, message: result.message! });
        }
      }

      // API Key 格式检查
      if (schema.type === "api_key" && typeof value === "string" && value.length > 0 && value.length < 10) {
        warnings.push({
          key: schema.key,
          message: "API Key 长度异常，可能不正确",
          suggestion: "请检查 API Key 是否完整",
        });
      }
    }

    return { valid: errors.length === 0 && missing.length === 0, errors, warnings, missing };
  }

  /** 快速诊断 */
  diagnose(): Array<{ component: string; status: "ok" | "warning" | "error"; message: string; fix?: string }> {
    const results: ReturnType<typeof this.diagnose> = [];

    // API Keys
    const apiKeys = [
      { name: "SiliconFlow", key: "model.siliconflow_key" },
      { name: "OfoxAI", key: "model.ofoxai_key" },
      { name: "OpenRouter", key: "model.openrouter_key" },
      { name: "DeepSeek", key: "model.deepseek_key" },
    ];

    let hasAnyKey = false;
    for (const { name, key } of apiKeys) {
      const val = this.getString(key);
      if (val) {
        hasAnyKey = true;
        results.push({ component: `${name} API`, status: "ok", message: `${name} API Key 已配置` });
      } else {
        results.push({ component: `${name} API`, status: "warning", message: `${name} API Key 未配置`, fix: `设置环境变量 ${CONFIG_SCHEMA.find((s) => s.key === key)?.envVar}` });
      }
    }

    if (!hasAnyKey) {
      results.push({ component: "模型服务", status: "error", message: "没有配置任何模型 API Key，系统无法调用 LLM", fix: "至少配置一个 API Key，推荐: SILICONFLOW_API_KEY" });
    }

    // Auth Token
    const authToken = this.getString("gateway.auth_token");
    if (!authToken) {
      results.push({ component: "安全", status: "error", message: "未设置 AXIOM_AUTH_TOKEN，所有请求将被拒绝", fix: "设置 AXIOM_AUTH_TOKEN 环境变量" });
    } else if (authToken.length < 16) {
      results.push({ component: "安全", status: "warning", message: "API Token 过短，建议至少 16 位", fix: "生成更长的随机 Token" });
    } else {
      results.push({ component: "安全", status: "ok", message: "API Token 已配置" });
    }

    // Vault
    const vaultPath = this.getString("memory.vault_path");
    if (fs.existsSync(vaultPath)) {
      results.push({ component: "Vault", status: "ok", message: `Vault 路径存在: ${vaultPath}` });
    } else {
      results.push({ component: "Vault", status: "warning", message: `Vault 路径不存在: ${vaultPath}`, fix: `创建目录: mkdir -p ${vaultPath}` });
    }

    // Database
    const dbPath = this.getString("memory.database_path");
    const dbDir = path.dirname(dbPath);
    if (fs.existsSync(dbDir)) {
      results.push({ component: "数据库", status: "ok", message: "数据库目录存在" });
    } else {
      results.push({ component: "数据库", status: "warning", message: `数据库目录不存在: ${dbDir}`, fix: `创建目录: mkdir -p ${dbDir}` });
    }

    // CodeGraph
    const codegraphExists = fs.existsSync("./.codegraph/codegraph.db");
    results.push({ component: "CodeGraph", status: codegraphExists ? "ok" : "warning", message: codegraphExists ? "CodeGraph 已索引" : "CodeGraph 未索引", fix: codegraphExists ? undefined : "运行: npx codegraph init -i" });

    return results;
  }

  // ---------------------------------------------------------------------------
  // 监听器
  // ---------------------------------------------------------------------------

  onChange(listener: (key: string, value: unknown) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  // ---------------------------------------------------------------------------
  // 审计日志
  // ---------------------------------------------------------------------------

  getAuditLog(limit = 50): ConfigAuditEntry[] {
    return this.auditLog.slice(-limit);
  }

  // ---------------------------------------------------------------------------
  // 持久化
  // ---------------------------------------------------------------------------

  private persistToYaml(key: string, value: unknown): void {
    const schema = CONFIG_SCHEMA.find((s) => s.key === key);
    if (!schema) return;

    setPath(this.yamlData, schema.yamlPath, value);
    this.saveYaml();
  }

  private saveYaml(): void {
    try {
      const dir = path.dirname(this.yamlPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(this.yamlPath, YAML.stringify(this.yamlData), "utf-8");
    } catch (e) {
      logger.error("[ConfigCenter] Failed to save YAML", e as Error);
    }
  }

  // ---------------------------------------------------------------------------
  // 辅助方法
  // ---------------------------------------------------------------------------

  private parseValue(raw: string, type: ConfigSchema["type"]): unknown {
    switch (type) {
      case "number": return Number(raw);
      case "boolean": return raw.toLowerCase() === "true";
      default: return raw;
    }
  }

  private checkType(value: unknown, type: ConfigSchema["type"]): { valid: boolean; message?: string } {
    switch (type) {
      case "number": return typeof value === "number" ? { valid: true } : { valid: false, message: `Expected number, got ${typeof value}` };
      case "boolean": return typeof value === "boolean" ? { valid: true } : { valid: false, message: `Expected boolean, got ${typeof value}` };
      case "string":
      case "api_key":
      case "path":
      case "url": return typeof value === "string" ? { valid: true } : { valid: false, message: `Expected string, got ${typeof value}` };
      default: return { valid: true };
    }
  }
}

// ═══════════════════════════════════════════════════════════════
// 辅助函数
// ═══════════════════════════════════════════════════════════════

function getPath(obj: Record<string, unknown>, path: string): unknown {
  const parts = path.split(".");
  let current: unknown = obj;
  for (const part of parts) {
    if (current && typeof current === "object") {
      current = (current as Record<string, unknown>)[part];
    } else {
      return undefined;
    }
  }
  return current;
}

function setPath(obj: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split(".");
  let current: Record<string, unknown> = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];
    if (!current[part] || typeof current[part] !== "object") {
      current[part] = {};
    }
    current = current[part] as Record<string, unknown>;
  }
  current[parts[parts.length - 1]] = value;
}

const ALLOWED_ENV_VARS = new Set([
  "DATABASE_PATH", "OBSIDIAN_VAULT_PATH", "LOG_LEVEL", "NODE_ENV",
  "KNOWLEDGE_DB_PATH", "BING_API_KEY",
]);

function resolveEnvVars(obj: unknown): unknown {
  if (typeof obj === "string") {
    return obj.replace(/\$\{([^}]+)\}/g, (_, name) => {
      if (!ALLOWED_ENV_VARS.has(name)) {
        logger.warn(`[Config] Blocked access to env var: ${name} (not in whitelist)`);
        return "";
      }
      return process.env[name] ?? "";
    });
  }
  if (Array.isArray(obj)) return obj.map(resolveEnvVars);
  if (obj && typeof obj === "object") {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) result[k] = resolveEnvVars(v);
    return result;
  }
  return obj;
}

// ═══════════════════════════════════════════════════════════════
// 全局实例
// ═══════════════════════════════════════════════════════════════

let globalCenter: ConfigCenter | null = null;

export function getConfigCenter(): ConfigCenter {
  if (!globalCenter) globalCenter = new ConfigCenter();
  return globalCenter;
}

export function resetConfigCenter(): void {
  globalCenter = null;
}

// ═══════════════════════════════════════════════════════════════
// 向下兼容: 提供 utils/config.ts 的 getConfig() 接口
// ═══════════════════════════════════════════════════════════════

interface GatewayConfig {
  port: number;
  bind: string;
  auth?: { token?: string };
}

interface ModelConfig {
  name: string;
  provider: string;
  model: string;
  baseUrl: string;
  apiKey: string;
  tier: number;
  purpose: string[];
  priority: number;
  freeOnly?: boolean;
  httpProxy?: string;
}

interface MemoryConfig {
  vaultPath: string;
  obsidianApiPort: number;
  obsidianApiToken: string;
  databasePath: string;
}

interface CrawlerConfig {
  searchApi: string;
  serpapiKey: string;
  maxConcurrent: number;
  requestDelay: number;
}

interface AppConfig {
  gateway: GatewayConfig;
  models: ModelConfig[];
  memory: MemoryConfig;
  crawler: CrawlerConfig;
}

export function getConfig(): AppConfig {
  const cc = getConfigCenter();
  return {
    gateway: {
      port: cc.getNumber("gateway.port"),
      bind: cc.getString("gateway.bind"),
      auth: { token: cc.getString("gateway.auth_token") || undefined },
    },
    models: (cc.getYamlData()?.models ?? []) as ModelConfig[],
    memory: {
      vaultPath: cc.getString("memory.vault_path"),
      obsidianApiPort: Number(process.env.OBSIDIAN_API_PORT) || 27124,
      obsidianApiToken: process.env.OBSIDIAN_API_TOKEN || "",
      databasePath: cc.getString("memory.database_path"),
    },
    crawler: {
      searchApi: process.env.CRAWLER_SEARCH_API || "multi-engine",
      serpapiKey: cc.getString("crawler.serpapi_key"),
      maxConcurrent: cc.getNumber("crawler.max_concurrent") || 3,
      requestDelay: Number(process.env.CRAWLER_REQUEST_DELAY) || 1000,
    },
  };
}

export function reloadConfig(): AppConfig {
  resetConfigCenter();
  return getConfig();
}
