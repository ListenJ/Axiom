/**
 * User Config Loader — 用户自配置模型/链接闭环。
 *
 * 数据源（按优先级合并，均缺省容忍）：
 *   1. data/model-config.json —— 前端 /models 管理页写入（routes/models.ts 格式）
 *   2. config/model-router.yaml —— 角色分层路由表（provider/model/priority/maxRetries/timeout）
 *
 * 注入方式：转换为 ModelCapability 后经 registerModel() 写入 model-capability-registry 的
 * EXTENSIONS，findModelsForRole 立即生效；baseURL/apiKey 透传到 capability，
 * callProvider 按 override 优先使用（见 provider-caller.ts）。
 *
 * 幂等：reload 前先 unregister 上次注册的 user_* 扩展，避免重复累积。
 */
import fs from "node:fs";
import { parse as parseYaml } from "yaml";
import { registerModel, unregisterModel, type ModelCapability } from "./model-capability-registry.js";
import type { ModelProvider, TaskRole } from "./models.js";
import { logger } from "../utils/logger.js";

export interface UserModelConfigEntry {
  id: string;
  name?: string;
  provider: string;
  model: string;
  baseURL?: string;
  apiKey?: string;
  roles?: string[];
  priority?: number;
  maxRetries?: number;
  timeout?: number;
  enabled?: boolean;
}

export interface UserModelLoaderOptions {
  configPath?: string;
  yamlPath?: string;
}

export interface UserModelLoadReport {
  registered: number;
  skipped: number;
  errors: string[];
}

const DEFAULT_CONFIG_PATH = "./data/model-config.json";
const DEFAULT_YAML_PATH = "./config/model-router.yaml";

/** 与 models/types.ts TaskRole 联合保持一致（新增角色时需同步）。 */
const KNOWN_ROLES: TaskRole[] = [
  "decision", "architecture", "evaluation", "general-chat", "code-generation",
  "code-review", "embedding", "english", "rl", "general-tool", "coding",
  "research", "memory", "deep_research", "math", "review", "main_coding",
  "computer-use", "intent-classifier",
];
const ROLE_SET = new Set<string>(KNOWN_ROLES);

const registeredIds = new Set<string>();

function slugify(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, "_");
}

function toEntry(m: Record<string, unknown>, idHint: string): UserModelConfigEntry {
  return {
    id: String(m.id ?? idHint),
    name: m.name ? String(m.name) : undefined,
    provider: String(m.provider ?? "openrouter"),
    model: String(m.model ?? ""),
    baseURL: m.baseURL ? String(m.baseURL) : undefined,
    apiKey: m.apiKey ? String(m.apiKey) : undefined,
    roles: Array.isArray(m.roles) ? m.roles.map(String) : undefined,
    priority: typeof m.priority === "number" ? m.priority : undefined,
    maxRetries: typeof m.maxRetries === "number" ? m.maxRetries : undefined,
    timeout: typeof m.timeout === "number" ? m.timeout : undefined,
    enabled: m.enabled !== false,
  };
}

/** 解析 data/model-config.json（routes/models.ts 写入格式）。 */
export function parseModelConfigJson(content: string): UserModelConfigEntry[] {
  const data = JSON.parse(content) as { models?: Array<Record<string, unknown>> };
  if (!Array.isArray(data.models)) return [];
  return data.models
    .map((m, i) => toEntry(m, `model_${i}`))
    .filter((e) => e.model.length > 0);
}

/** 解析 config/model-router.yaml（键 = 角色，值为模型列表）。 */
export function parseModelRouterYaml(content: string): UserModelConfigEntry[] {
  const data = parseYaml(content) as Record<string, unknown> | null | undefined;
  if (!data || typeof data !== "object") return [];
  const entries: UserModelConfigEntry[] = [];
  for (const [role, list] of Object.entries(data)) {
    if (!Array.isArray(list)) continue;
    for (const item of list as Array<Record<string, unknown>>) {
      if (!item || typeof item !== "object" || !item.model) continue;
      entries.push(toEntry({ ...item, roles: [role] }, `yaml_${role}_${String(item.model)}`));
    }
  }
  return entries;
}

/** 清空已注册的 user_* 扩展（reload 前调用）。 */
export function resetUserModels(): void {
  for (const id of registeredIds) {
    unregisterModel(id);
  }
  registeredIds.clear();
}

/** 加载用户模型并注入 capability registry，返回统计。缺文件/解析失败不抛错。 */
export function loadUserModels(options: UserModelLoaderOptions = {}): UserModelLoadReport {
  resetUserModels();

  const entries: UserModelConfigEntry[] = [];
  const errors: string[] = [];
  const configPath = options.configPath ?? DEFAULT_CONFIG_PATH;
  const yamlPath = options.yamlPath ?? DEFAULT_YAML_PATH;

  if (fs.existsSync(configPath)) {
    try {
      entries.push(...parseModelConfigJson(fs.readFileSync(configPath, "utf8")));
    } catch (e) {
      errors.push(`model-config.json: ${(e as Error).message}`);
    }
  }
  if (fs.existsSync(yamlPath)) {
    try {
      entries.push(...parseModelRouterYaml(fs.readFileSync(yamlPath, "utf8")));
    } catch (e) {
      errors.push(`model-router.yaml: ${(e as Error).message}`);
    }
  }

  let registered = 0;
  let skipped = 0;
  for (const entry of entries) {
    if (entry.enabled === false) {
      skipped++;
      continue;
    }
    const roles = (entry.roles && entry.roles.length > 0 ? entry.roles : ["general-chat"])
      .filter((r) => ROLE_SET.has(r)) as TaskRole[];
    if (roles.length === 0) {
      skipped++;
      continue;
    }

    const capability: ModelCapability = {
      id: `user_${slugify(entry.id)}`,
      provider: entry.provider as ModelProvider,
      model: entry.model,
      roles,
      contextWindow: 128_000,
      tags: ["user-config"],
      ...(entry.priority !== undefined ? { priority: entry.priority } : {}),
      ...(entry.maxRetries !== undefined ? { maxRetries: entry.maxRetries } : {}),
      ...(entry.timeout !== undefined ? { timeout: entry.timeout } : {}),
      ...(entry.baseURL ? { baseURL: entry.baseURL } : {}),
      ...(entry.apiKey ? { apiKey: entry.apiKey } : {}),
    };

    try {
      registerModel(capability);
      registeredIds.add(capability.id);
      registered++;
    } catch (e) {
      skipped++;
      errors.push(`register ${entry.id}: ${(e as Error).message}`);
    }
  }

  logger.info("[UserConfigLoader] loaded", { registered, skipped, errors: errors.length });
  return { registered, skipped, errors };
}
