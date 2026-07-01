/**
 * 配置管理器
 * 从 YAML 文件、环境变量加载配置，支持热重载
 */
import fs from "fs";
import YAML from "yaml";

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

/** 从 YAML 文件加载配置 */
function loadConfig(path = "./config/axiom.yaml"): AppConfig {
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
          port: Number(process.env.AXIOM_GATEWAY_PORT) || 18789,
          bind: process.env.AXIOM_BIND || "127.0.0.1",
          auth: { token: process.env.AXIOM_AUTH_TOKEN },
        },
        models: [],
        memory: {
          vaultPath: process.env.OBSIDIAN_VAULT_PATH || "./axiom-memory",
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
