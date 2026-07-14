import type { RouteContext } from "./types.js";
import fs from "fs";

const CONFIG_PATH = "./data/model-config.json";

interface ModelEntry {
  id: string;
  name: string;
  provider: string;
  model: string;
  baseURL?: string;
  apiKey?: string;
  tier?: string;
  purpose?: string;
  freeOnly?: boolean;
  enabled: boolean;
}

interface ProviderEntry {
  id: string;
  name: string;
  baseURL: string;
  apiKeyLast4?: string;
  enabled: boolean;
}

interface ModelConfigFile {
  models: ModelEntry[];
  providers: ProviderEntry[];
}

function readConfig(): ModelConfigFile {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8")) as ModelConfigFile;
    }
  } catch { /* ignore */ }
  return { models: [], providers: [] };
}

function writeConfig(config: ModelConfigFile): void {
  const dir = CONFIG_PATH.substring(0, CONFIG_PATH.lastIndexOf("/"));
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), "utf-8");
}

const KNOWN_PROVIDERS: ProviderEntry[] = [
  { id: "siliconflow", name: "SiliconFlow", baseURL: "https://api.siliconflow.cn/v1", apiKeyLast4: process.env.SILICONFLOW_API_KEY?.slice(-4) ?? "", enabled: !!process.env.SILICONFLOW_API_KEY },
  { id: "zhipu", name: "智谱AI", baseURL: "https://open.bigmodel.cn/api/paas/v4", apiKeyLast4: process.env.ZHIPU_API_KEY?.slice(-4) ?? "", enabled: !!process.env.ZHIPU_API_KEY },
  { id: "minimax", name: "MiniMax", baseURL: "https://api.minimax.chat/v1", apiKeyLast4: process.env.MINIMAX_API_KEY?.slice(-4) ?? "", enabled: !!process.env.MINIMAX_API_KEY },
  { id: "openrouter", name: "OpenRouter", baseURL: "https://openrouter.ai/api/v1", apiKeyLast4: process.env.OPENROUTER_API_KEY?.slice(-4) ?? "", enabled: !!process.env.OPENROUTER_API_KEY },
  { id: "deepseek", name: "DeepSeek", baseURL: "https://api.deepseek.com/v1", apiKeyLast4: process.env.DEEPSEEK_API_KEY?.slice(-4) ?? "", enabled: !!process.env.DEEPSEEK_API_KEY },
];

export async function handleListModels(ctx: RouteContext): Promise<Response | null> {
  if (ctx.url.pathname !== "/models" || ctx.req.method !== "GET") return null;
  const config = readConfig();
  return ctx.jsonResponse({ models: config.models }, 200, ctx.baseHeaders);
}

export async function handleAddModel(ctx: RouteContext): Promise<Response | null> {
  if (ctx.url.pathname !== "/models" || ctx.req.method !== "POST") return null;
  try {
    const body = await ctx.req.json() as Record<string, unknown>;
    if (!body.name || !body.provider || !body.model) {
      return ctx.jsonResponse({ error: "name、provider 和 model 为必填项" }, 400, ctx.baseHeaders);
    }
    const config = readConfig();
    const entry: ModelEntry = {
      id: `model_${Date.now()}`,
      name: String(body.name),
      provider: String(body.provider),
      model: String(body.model),
      baseURL: body.baseURL ? String(body.baseURL) : undefined,
      apiKey: body.apiKey ? String(body.apiKey) : undefined,
      tier: body.tier ? String(body.tier) : undefined,
      purpose: body.purpose ? String(body.purpose) : undefined,
      freeOnly: !!body.freeOnly,
      enabled: body.enabled !== false,
    };
    config.models.push(entry);
    writeConfig(config);
    return ctx.jsonResponse({ success: true, model: entry }, 200, ctx.baseHeaders);
  } catch (e) {
    return ctx.jsonResponse({ error: String(e) }, 400, ctx.baseHeaders);
  }
}

export async function handleDeleteModel(ctx: RouteContext): Promise<Response | null> {
  const match = ctx.url.pathname.match(/^\/models\/(.+)$/);
  if (!match || ctx.req.method !== "DELETE") return null;
  const modelId = decodeURIComponent(match[1]);
  const config = readConfig();
  const idx = config.models.findIndex((m) => m.id === modelId);
  if (idx === -1) {
    return ctx.jsonResponse({ error: "模型未找到" }, 404, ctx.baseHeaders);
  }
  config.models.splice(idx, 1);
  writeConfig(config);
  return ctx.jsonResponse({ success: true, message: `模型 ${modelId} 已删除` }, 200, ctx.baseHeaders);
}

export async function handleListProviders(ctx: RouteContext): Promise<Response | null> {
  if (ctx.url.pathname !== "/providers" || ctx.req.method !== "GET") return null;
  return ctx.jsonResponse({ providers: KNOWN_PROVIDERS }, 200, ctx.baseHeaders);
}

export async function handleTestProvider(ctx: RouteContext): Promise<Response | null> {
  const match = ctx.url.pathname.match(/^\/providers\/(.+)\/test$/);
  if (!match || ctx.req.method !== "POST") return null;
  const providerId = match[1];
  const provider = KNOWN_PROVIDERS.find((p) => p.id === providerId);
  if (!provider) {
    return ctx.jsonResponse({ success: false, message: "未知 Provider" }, 404, ctx.baseHeaders);
  }
  try {
    const res = await fetch(`${provider.baseURL}/models`, { signal: AbortSignal.timeout(10000) });
    return ctx.jsonResponse(
      { success: res.ok, message: res.ok ? "连接成功" : `HTTP ${res.status}` },
      res.ok ? 200 : 502,
      ctx.baseHeaders,
    );
  } catch (e) {
    return ctx.jsonResponse({ success: false, message: String(e) }, 502, ctx.baseHeaders);
  }
}
