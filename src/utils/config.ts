/**
 * 配置管理器
 * 从 YAML 文件、环境变量加载配置，支持热重载
 */
import fs from "fs";
import YAML from "yaml";
import { TIMEOUTS } from "../constants/timeouts.js";

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

export interface AppConfig {
  gateway: GatewayConfig;
  models: ModelConfig[];
  memory: MemoryConfig;
  crawler: CrawlerConfig;
}

/** 从 YAML 文件加载配置 */
export function loadConfig(path = "./config/openclaw.yaml"): AppConfig {
  if (!fs.existsSync(path)) {
    throw new Error(`Config file not found: ${path}`);
  }

  const raw = fs.readFileSync(path, "utf-8");
  const parsed = YAML.parse(raw) as Record<string, unknown>;

  // 递归替换环境变量占位符 ${VAR_NAME}
  const resolved = resolveEnvVars(parsed) as Record<string, unknown>;

  return {
    gateway: resolved.gateway as GatewayConfig,
    models: (resolved.models as ModelConfig[]) || [],
    memory: resolved.memory as MemoryConfig,
    crawler: resolved.crawler as CrawlerConfig,
  };
}

/** 递归替换 ${ENV_VAR} 占位符 */
function resolveEnvVars(obj: unknown): unknown {
  if (typeof obj === "string") {
    return obj.replace(/\$\{([^}]+)\}/g, (_, name) => process.env[name] ?? "");
  }
  if (Array.isArray(obj)) {
    return obj.map(resolveEnvVars);
  }
  if (obj && typeof obj === "object") {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      result[k] = resolveEnvVars(v);
    }
    return result;
  }
  return obj;
}

/** 获取模型路由配置（从 YAML 加载或回退到默认） */
export function getModelRoutes(config?: AppConfig): Record<string, Array<{ provider: string; model: string; priority: number; maxRetries: number; timeout: number }>> {
  if (!config) return {
    "general-chat": [
      { provider: "ofoxai", model: "z-ai/glm-4.7-flash:free", priority: 0, maxRetries: 2, timeout: 15000 },
      { provider: "siliconflow", model: "Qwen/Qwen2-7B-Instruct", priority: 1, maxRetries: 2, timeout: 10000 },
    ],
    "code-generation": [
      { provider: "opencode", model: "opencode/deepseek-v4-flash-free", priority: 0, maxRetries: 2, timeout: 20000 },
      { provider: "ofoxai", model: "z-ai/glm-4.7-flash:free", priority: 1, maxRetries: 2, timeout: 15000 },
      { provider: "deepseek", model: "deepseek-v4-flash", priority: 2, maxRetries: 2, timeout: 20000 },
    ],
    "coding": [
      { provider: "opencode", model: "opencode/deepseek-v4-flash-free", priority: 0, maxRetries: 2, timeout: 20000 },
      { provider: "deepseek", model: "deepseek-v4-flash", priority: 1, maxRetries: 2, timeout: 20000 },
    ],
    "complex-reasoning": [
      { provider: "ofoxai", model: "z-ai/glm-4.7-flash:free", priority: 0, maxRetries: 2, timeout: 20000 },
      { provider: "deepseek", model: "deepseek-chat", priority: 1, maxRetries: 2, timeout: TIMEOUTS.API_DEFAULT },
    ],
    "embedding": [
      { provider: "siliconflow", model: "BAAI/bge-large-zh", priority: 0, maxRetries: 2, timeout: 10000 },
    ],
  };

  const routes: Record<string, Array<{ provider: string; model: string; priority: number; maxRetries: number; timeout: number }>> = {};

  for (const m of config.models) {
    for (const purpose of m.purpose) {
      if (!routes[purpose]) routes[purpose] = [];
      routes[purpose].push({
        provider: m.provider,
        model: m.model,
        priority: m.priority,
        maxRetries: 2,
        timeout: purpose.includes("reasoning") ? TIMEOUTS.API_DEFAULT : TIMEOUTS.API_MEDIUM,
      });
    }
  }

  // 按优先级排序
  for (const key of Object.keys(routes)) {
    routes[key].sort((a, b) => a.priority - b.priority);
  }

  return routes;
}

/** 全局配置缓存 */
let cachedConfig: AppConfig | null = null;

export function getConfig(): AppConfig {
  if (!cachedConfig) {
    try {
      cachedConfig = loadConfig();
    } catch {
      // 回退到环境变量
      cachedConfig = {
        gateway: {
          port: Number(process.env.OPENCLAW_GATEWAY_PORT) || 18789,
          bind: process.env.OPENCLAW_BIND || "127.0.0.1",
          auth: { token: process.env.OPENCLAW_AUTH_TOKEN },
        },
        models: [],
        memory: {
          vaultPath: process.env.OBSIDIAN_VAULT_PATH || "./openclaw-memory",
          obsidianApiPort: Number(process.env.OBSIDIAN_API_PORT) || 27124,
          obsidianApiToken: process.env.OBSIDIAN_API_TOKEN || "",
          databasePath: process.env.DATABASE_PATH || "./data/agent.db",
        },
        crawler: {
          searchApi: process.env.CRAWLER_SEARCH_API || "multi-engine",
          serpapiKey: process.env.SERPAPI_KEY || "",
          maxConcurrent: Number(process.env.CRAWLER_MAX_CONCURRENT) || 3,
          requestDelay: Number(process.env.CRAWLER_REQUEST_DELAY) || 1000,
        },
      };
    }
  }
  return cachedConfig;
}

export function reloadConfig(): AppConfig {
  cachedConfig = null;
  return getConfig();
}
