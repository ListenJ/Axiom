/**
 * 多平台免费模型动态发现
 * 建议通过 crontab 每10分钟执行一次：
 *   * /10 * * * * bun run scripts/discover-free-models.ts
 */
import { Database } from "bun:sqlite";

interface FreeModel {
  id: string;
  name: string;
  provider: string;
  contextLength: number;
  description?: string;
  discoveredAt: string;
}

const PLATFORMS = {
  siliconflow: {
    baseUrl: "https://api.siliconflow.cn/v1",
    apiKey: process.env.SILICONFLOW_API_KEY,
    filter: (_m: any) => false, // 硅基流动免费模型硬编码
  },
  ofoxai: {
    baseUrl: process.env.OFOXAI_BASE_URL || "https://api.ofox.ai/v1",
    apiKey: process.env.OFOXAI_API_KEY,
    filter: (m: any) => m.id?.includes("free") || m.id === "z-ai/glm-4.7-flash:free",
  },
  openrouter: {
    baseUrl: "https://openrouter.ai/api/v1",
    apiKey: process.env.OPENROUTER_API_KEY,
    filter: (m: any) => m.id?.endsWith(":free") || (m.pricing?.prompt === 0 && m.pricing?.completion === 0),
  },
};

async function discoverFreeModels(platform: keyof typeof PLATFORMS): Promise<FreeModel[]> {
  const config = PLATFORMS[platform];
  if (!config.apiKey) {
    console.warn(`[${platform}] API key not configured, skipping`);
    return [];
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${config.apiKey}`,
    "Content-Type": "application/json",
  };

  if (platform === "openrouter") {
    headers["HTTP-Referer"] = "https://openclaw.ai";
    headers["X-Title"] = "OpenClaw Agent";
  }

  try {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 10000);

    const response = await fetch(`${config.baseUrl}/models`, {
      headers,
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const data = await response.json();
    const models = data.data || data;

    return models
      .filter(config.filter)
      .map((m: any) => ({
        id: m.id,
        name: m.name || m.id,
        provider: platform,
        contextLength: m.context_length || 4096,
        description: m.description,
        discoveredAt: new Date().toISOString(),
      }));
  } catch (error) {
    console.error(`[${platform}] Discovery failed:`, error);
    return [];
  }
}

function saveToDatabase(models: FreeModel[]): void {
  const dbPath = process.env.DATABASE_PATH || "./data/agent.db";
  const db = new Database(dbPath);

  db.run(`
    CREATE TABLE IF NOT EXISTS free_models (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      provider TEXT NOT NULL,
      context_length INTEGER,
      description TEXT,
      is_available INTEGER DEFAULT 1,
      discovered_at TEXT,
      last_checked_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // 标记所有为待验证
  db.run("UPDATE free_models SET is_available = 0");

  const insert = db.prepare(`
    INSERT OR REPLACE INTO free_models
    (id, name, provider, context_length, description, is_available, discovered_at, last_checked_at)
    VALUES (?, ?, ?, ?, ?, 1, ?, CURRENT_TIMESTAMP)
  `);

  for (const model of models) {
    insert.run(model.id, model.name, model.provider, model.contextLength, model.description, model.discoveredAt);
  }

  insert.finalize();
  db.close();

  console.log(`Saved ${models.length} free models to database`);
}

async function main() {
  console.log("🔍 Starting free model discovery...");
  const allModels: FreeModel[] = [];

  for (const platform of Object.keys(PLATFORMS) as Array<keyof typeof PLATFORMS>) {
    const models = await discoverFreeModels(platform);
    console.log(`[${platform.toUpperCase()}] Found ${models.length} free models`);
    allModels.push(...models);
  }

  // 硅基流动免费模型（硬编码，因官方模型列表API不区分免费/付费）
  const sfFreeModels = [
    "Qwen/Qwen2-7B-Instruct",
    "Qwen/Qwen2-1.5B-Instruct",
    "Qwen/Qwen1.5-7B-Chat",
    "THUDM/glm-4-9b-chat",
    "THUDM/chatglm3-6b",
    "internlm/internlm2_5-7b-chat",
    "mistralai/Mistral-7B-Instruct-v0.2",
    "deepseek-ai/DeepSeek-R1-Distill-Qwen-7B",
    "deepseek-ai/DeepSeek-R1-Distill-Llama-8B",
    "deepseek-ai/DeepSeek-R1-Distill-Qwen-1.5B",
  ];

  for (const modelId of sfFreeModels) {
    allModels.push({
      id: modelId,
      name: modelId,
      provider: "siliconflow",
      contextLength: 32768,
      discoveredAt: new Date().toISOString(),
    });
  }
  console.log(`[SILICONFLOW] Added ${sfFreeModels.length} hardcoded free models`);

  // OfoxAI 免费模型（硬编码，唯一免费：z-ai/glm-4.7-flash:free）
  const ofoxFreeModels = [
    { id: "z-ai/glm-4.7-flash:free", name: "GLM-4.7 Flash Free", contextLength: 32768 },
  ];

  for (const model of ofoxFreeModels) {
    allModels.push({
      id: model.id,
      name: model.name,
      provider: "ofoxai",
      contextLength: model.contextLength,
      discoveredAt: new Date().toISOString(),
    });
  }
  console.log(`[OFOXAI] Added ${ofoxFreeModels.length} hardcoded free models`);

  // 保存到数据库
  saveToDatabase(allModels);

  // 按提供商分组输出
  const grouped = allModels.reduce((acc, m) => {
    acc[m.provider] = acc[m.provider] || [];
    acc[m.provider].push(m);
    return acc;
  }, {} as Record<string, FreeModel[]>);

  console.log("\n📋 Router configuration recommendations:");
  for (const [provider, providerModels] of Object.entries(grouped)) {
    console.log(`\n${provider.toUpperCase()}:`);
    for (const m of providerModels) {
      console.log(`  - ${m.id} (${m.contextLength / 1024}K context)`);
    }
  }
}

main().catch(console.error);
