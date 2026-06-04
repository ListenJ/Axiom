/**
 * 模型供应商自动适配器
 *
 * 功能:
 *   1. 根据模型定价自动选择最优供应商
 *   2. 动态发现免费模型 (OpenRouter free tier)
 *   3. 根据输入/输出 token 定价优化成本
 *   4. 支持多供应商 fallback chain
 *   5. 项目自我进化: 评估 → 选优 → 替换 → 再评估
 *
 * 核心概念:
 *   - Score = capability × W_cap + speed × W_speed + cost × W_cost + safety × W_safety
 *   - 不同任务角色 (编码/研究/对话) 使用不同的权重组合
 *   - 自动淘汰低分模型，引入新的高分模型
 */
import { logger } from "../utils/logger.js";
import { proxyFetch } from "../utils/proxy-fetch.js";
import { isPgAvailable, getPG } from "../db/pg-client.js";

// ========== 类型定义 ==========

export interface ProviderConfig {
  name: string;
  baseURL: string;
  apiKeyEnv: string;
  models: ModelListing[];
  pricing: PricingTier;
}

export interface ModelListing {
  id: string;
  name: string;
  contextWindow: number;
  inputPrice: number;   // $/1M tokens
  outputPrice: number;  // $/1M tokens
  isFree: boolean;
  tags: string[];       // coding, research, general, math, etc.
}

export interface PricingTier {
  /** 免费额度 (tokens/month) */
  freeQuota: number;
  /** 超出免费额度后的统一价格 */
  overagePrice: number;
}

export interface ModelRecommendation {
  modelId: string;
  provider: string;
  role: string;
  score: number;
  reason: string;
  estimatedCostPerCall: number;
}

export interface EvolutionCycle {
  cycleId: string;
  timestamp: Date;
  evaluated: number;
  promoted: ModelRecommendation[];
  demoted: string[];
  newCandidates: string[];
}

// ========== 已知供应商配置 ==========

const KNOWN_PROVIDERS: Record<string, ProviderConfig> = {
  openrouter: {
    name: "OpenRouter",
    baseURL: "https://openrouter.ai/api/v1",
    apiKeyEnv: "OPENROUTER_API_KEY",
    models: [],  // 动态发现
    pricing: { freeQuota: Infinity, overagePrice: 0 },  // 按模型定价
  },
  deepseek: {
    name: "DeepSeek",
    baseURL: "https://api.deepseek.com/v1",
    apiKeyEnv: "DEEPSEEK_API_KEY",
    models: [
      { id: "deepseek-chat", name: "DeepSeek V3", contextWindow: 65536, inputPrice: 0.27, outputPrice: 1.10, isFree: false, tags: ["coding", "general"] },
      { id: "deepseek-reasoner", name: "DeepSeek R1", contextWindow: 65536, inputPrice: 0.55, outputPrice: 2.19, isFree: false, tags: ["research", "reasoning"] },
    ],
    pricing: { freeQuota: 5_000_000, overagePrice: 0 },
  },
  siliconflow: {
    name: "SiliconFlow",
    baseURL: "https://api.siliconflow.cn/v1",
    apiKeyEnv: "SILICONFLOW_API_KEY",
    models: [],  // 动态发现
    pricing: { freeQuota: 14_000_000, overagePrice: 0 },
  },
  kimi: {
    name: "Kimi (Moonshot)",
    baseURL: "https://api.moonshot.cn/v1",
    apiKeyEnv: "KIMI_API_KEY",
    models: [
      { id: "moonshot-v1-128k", name: "Moonshot v1 128K", contextWindow: 131072, inputPrice: 0.84, outputPrice: 0.84, isFree: false, tags: ["general", "coding"] },
    ],
    pricing: { freeQuota: 15_000_000, overagePrice: 0 },
  },
  minimax: {
    name: "MiniMax",
    baseURL: "https://api.minimax.chat/v1",
    apiKeyEnv: "MINIMAX_API_KEY",
    models: [
      { id: "abab6.5s-chat", name: "MiniMax abab6.5s", contextWindow: 32768, inputPrice: 0.10, outputPrice: 0.10, isFree: false, tags: ["general"] },
    ],
    pricing: { freeQuota: 1_000_000, overagePrice: 0 },
  },
};

// ========== 角色权重配置 ==========

const ROLE_WEIGHTS: Record<string, {
  capability: number;
  speed: number;
  cost: number;
  safety: number;
}> = {
  "coding": { capability: 0.7, speed: 0.1, cost: 0.15, safety: 0.05 },
  "research": { capability: 0.6, speed: 0.05, cost: 0.15, safety: 0.2 },
  "general-tool": { capability: 0.4, speed: 0.3, cost: 0.25, safety: 0.05 },
  "evaluation": { capability: 0.8, speed: 0.05, cost: 0.1, safety: 0.05 },
  "conversation": { capability: 0.3, speed: 0.4, cost: 0.25, safety: 0.05 },
  "decision": { capability: 0.6, speed: 0.2, cost: 0.15, safety: 0.05 },
  "default": { capability: 0.35, speed: 0.2, cost: 0.25, safety: 0.2 },
};

// ========== 模型发现 ==========

/**
 * 从 OpenRouter 动态发现免费模型
 */
export async function discoverFreeModels(): Promise<ModelListing[]> {
  try {
    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) return [];

    const res = await proxyFetch("https://openrouter.ai/api/v1/models", {
      headers: { "Authorization": `Bearer ${apiKey}` },
      timeout: 15000,
    });

    if (!res.ok) return [];

    const data = await res.json();
    const models = data.data || [];

    const freeModels: ModelListing[] = [];

    for (const m of models) {
      const isFree = m.id.endsWith(":free")
        || (m.pricing?.prompt === "0" && m.pricing?.completion === "0");

      if (!isFree) continue;

      freeModels.push({
        id: m.id,
        name: m.name || m.id,
        contextWindow: m.context_length || 4096,
        inputPrice: parseFloat(m.pricing?.prompt || "0"),
        outputPrice: parseFloat(m.pricing?.completion || "0"),
        isFree: true,
        tags: inferModelTags(m),
      });
    }

    logger.info(`[ModelAdvisor] Discovered ${freeModels.length} free models from OpenRouter`);
    return freeModels;
  } catch (err) {
    logger.warn("[ModelAdvisor] Failed to discover free models", { error: (err as Error).message });
    return [];
  }
}

/**
 * 从 SiliconFlow 发现可用模型
 */
export async function discoverSiliconFlowModels(): Promise<ModelListing[]> {
  try {
    const apiKey = process.env.SILICONFLOW_API_KEY;
    if (!apiKey) return [];

    const res = await proxyFetch("https://api.siliconflow.cn/v1/models", {
      headers: { "Authorization": `Bearer ${apiKey}` },
      timeout: 15000,
    });

    if (!res.ok) return [];

    const data = await res.json();
    return (data.data || []).map((m: any) => ({
      id: m.id,
      name: m.id,
      contextWindow: 32768,
      inputPrice: 0,
      outputPrice: 0,
      isFree: true,
      tags: inferModelTags(m),
    }));
  } catch {
    return [];
  }
}

function inferModelTags(model: any): string[] {
  const tags: string[] = [];
  const id = (model.id || "").toLowerCase();
  const name = (model.name || "").toLowerCase();

  if (id.includes("code") || id.includes("coder") || id.includes("dev")) tags.push("coding");
  if (id.includes("math") || id.includes("reason")) tags.push("reasoning");
  if (id.includes("research") || id.includes("hermes")) tags.push("research");
  if (id.includes("chat") || id.includes("instruct")) tags.push("general");
  if (id.includes("vision") || id.includes("vl")) tags.push("vision");

  // 默认标签
  if (tags.length === 0) tags.push("general");

  return tags;
}

// ========== 模型推荐 ==========

/**
 * 根据任务角色推荐最佳模型
 */
export async function recommendModels(
  role: string,
  options: {
    preferFree?: boolean;
    maxCostPerCall?: number;
    minCapability?: number;
    limit?: number;
  } = {},
): Promise<ModelRecommendation[]> {
  const { preferFree = true, maxCostPerCall = 0.01, minCapability = 50, limit = 3 } = options;
  const weights = ROLE_WEIGHTS[role] || ROLE_WEIGHTS["default"];

  // 收集所有可用模型
  const allModels: Array<{ model: ModelListing; provider: string; evalScore?: any }> = [];

  // 1. 从已知供应商
  for (const [providerKey, provider] of Object.entries(KNOWN_PROVIDERS)) {
    if (!process.env[provider.apiKeyEnv]) continue;

    for (const model of provider.models) {
      allModels.push({ model, provider: providerKey });
    }
  }

  // 2. 从 OpenRouter 动态发现
  const freeModels = await discoverFreeModels();
  for (const model of freeModels) {
    allModels.push({ model, provider: "openrouter" });
  }

  // 3. 从 PostgreSQL 获取评估分数 (如果有)
  if (await isPgAvailable()) {
    const pg = getPG();
    try {
      const evals = await pg`
        SELECT DISTINCT ON (model_id) model_id, capability, speed, cost, safety, overall_score
        FROM model_evaluations
        WHERE created_at > NOW() - INTERVAL '7 days'
        ORDER BY model_id, created_at DESC
      `;

      for (const entry of allModels) {
        const ev = evals.find((e: any) => e.model_id === entry.model.id);
        if (ev) {
          entry.evalScore = ev;
        }
      }
    } catch { /* ignore */ }
  }

  // 4. 计算综合分数
  const scored = allModels.map(({ model, provider, evalScore }) => {
    const capability = evalScore?.capability || estimateCapability(model);
    const speed = evalScore?.speed || estimateSpeed(model);
    const cost = evalScore?.cost || computeCostScore(model);
    const safety = evalScore?.safety || 70;

    const compositeScore =
      capability * weights.capability +
      speed * weights.speed +
      cost * weights.cost +
      safety * weights.safety;

    // 免费模型加分
    const freeBonus = model.isFree && preferFree ? 10 : 0;

    // 估算每次调用成本
    const estimatedCost = estimateCostPerCall(model, role);

    return {
      modelId: model.id,
      provider,
      role,
      score: Math.round((compositeScore + freeBonus) * 10) / 10,
      reason: generateRecommendationReason(model, evalScore, weights),
      estimatedCostPerCall: estimatedCost,
      _capability: capability,
    };
  });

  // 5. 过滤和排序
  return scored
    .filter((m) => m._capability >= minCapability)
    .filter((m) => !maxCostPerCall || m.estimatedCostPerCall <= maxCostPerCall)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ _capability, ...rest }) => rest);
}

// ========== 辅助评分函数 ==========

function estimateCapability(model: ModelListing): number {
  // 基于模型名称的启发式估计
  const id = model.id.toLowerCase();
  if (id.includes("405b") || id.includes("70b") || id.includes("deepseek")) return 80;
  if (id.includes("32b") || id.includes("gemma-4")) return 72;
  if (id.includes("8b") || id.includes("nano")) return 55;
  return 65;
}

function estimateSpeed(model: ModelListing): number {
  // 上下文窗口越大，速度越慢 (粗略估计)
  if (model.contextWindow > 100000) return 50;
  if (model.contextWindow > 32000) return 65;
  return 80;
}

function computeCostScore(model: ModelListing): number {
  if (model.isFree) return 100;
  const avgPrice = (model.inputPrice + model.outputPrice) / 2;
  // 价格越高，分数越低
  if (avgPrice < 0.5) return 90;
  if (avgPrice < 2) return 75;
  if (avgPrice < 5) return 60;
  if (avgPrice < 15) return 45;
  return 30;
}

function estimateCostPerCall(model: ModelListing, role: string): number {
  // 估算: 平均 2000 input tokens + 1000 output tokens
  const inputTokens = role === "research" ? 5000 : 2000;
  const outputTokens = role === "research" ? 2000 : 1000;
  return (inputTokens * model.inputPrice + outputTokens * model.outputPrice) / 1_000_000;
}

function generateRecommendationReason(
  model: ModelListing,
  evalScore: any,
  weights: any,
): string {
  const parts: string[] = [];

  if (model.isFree) parts.push("Free model");
  if (evalScore) parts.push(`Evaluated: ${Math.round(evalScore.overall_score)}%`);
  if (model.contextWindow >= 128000) parts.push(`${Math.round(model.contextWindow / 1000)}K context`);

  const topWeight = Object.entries(weights).sort((a, b) => (b[1] as number) - (a[1] as number))[0];
  parts.push(`Optimized for ${topWeight[0]}`);

  return parts.join(", ");
}

// ========== 项目自我进化 ==========

/**
 * 运行进化周期: 评估 → 选优 → 替换 → 记录
 *
 * 这个函数可以被定时任务调用，持续优化模型选择
 */
export async function runEvolutionCycle(): Promise<EvolutionCycle> {
  const cycleId = `evo_${Date.now()}`;
  const cycle: EvolutionCycle = {
    cycleId,
    timestamp: new Date(),
    evaluated: 0,
    promoted: [],
    demoted: [],
    newCandidates: [],
  };

  logger.info("[ModelEvolution] Starting evolution cycle", { cycleId });

  // 1. 评估所有角色
  const roles = Object.keys(ROLE_WEIGHTS);
  for (const role of roles) {
    const recommendations = await recommendModels(role, { limit: 5 });
    cycle.evaluated += recommendations.length;

    if (recommendations.length > 0) {
      const top = recommendations[0];
      cycle.promoted.push(top);
      logger.info(`[ModelEvolution] Best for ${role}: ${top.modelId} (score: ${top.score})`);
    }

    // 标记低分模型
    const lowScorers = recommendations.filter((r) => r.score < 40);
    for (const ls of lowScorers) {
      cycle.demoted.push(ls.modelId);
    }
  }

  // 2. 发现新候选
  const newFree = await discoverFreeModels();
  const knownIds = new Set(Object.values(KNOWN_PROVIDERS).flatMap((p) => p.models.map((m) => m.id)));
  cycle.newCandidates = newFree.filter((m) => !knownIds.has(m.id)).map((m) => m.id);

  if (cycle.newCandidates.length > 0) {
    logger.info("[ModelEvolution] New candidates discovered", { count: cycle.newCandidates.length });
  }

  // 3. 记录进化历史
  if (await isPgAvailable()) {
    try {
      const pg = getPG();
      await pg`
        INSERT INTO model_evaluations (model_id, provider, capability, speed, cost, safety, overall_score, eval_type)
        SELECT
          ${cycle.promoted[0]?.modelId || 'unknown'},
          ${cycle.promoted[0]?.provider || 'unknown'},
          0, 0, 0, 0,
          ${cycle.promoted[0]?.score || 0},
          'evolution'
        WHERE NOT EXISTS (
          SELECT 1 FROM model_evaluations
          WHERE model_id = ${cycle.promoted[0]?.modelId || 'unknown'}
            AND eval_type = 'evolution'
            AND created_at > NOW() - INTERVAL '1 hour'
        )
      `;
    } catch { /* ignore */ }
  }

  logger.info("[ModelEvolution] Cycle complete", {
    evaluated: cycle.evaluated,
    promoted: cycle.promoted.length,
    demoted: cycle.demoted.length,
    newCandidates: cycle.newCandidates.length,
  });

  return cycle;
}
