/**
 * Model Evaluation Service — 实时模型评估与基准数据采集
 *
 * 功能:
 *   1. 从 OpenRouter API 拉取实时模型数据（价格、上下文长度、使用量）
 *   2. 使用 UnifiedSearch 搜索 LLM Arena / SOTA 榜单获取基准分数
 *   3. 多维度评分：能力(capability)、速度(speed)、成本(cost)、安全性(safety)
 *   4. SQLite 持久化评估结果，支持历史趋势查询
 *   5. 与 model-capability-registry.ts 集成，为动态分配提供数据支撑
 *
 * 架构: "三省六部制" — 隶属中书省(TaskOrchestrator)的评估子系统
 */

import { Database } from "bun:sqlite";
import { logger } from "../utils/logger.js";
import { proxyFetch } from "../utils/proxy-fetch.js";

// ========== 类型定义 ==========

export interface OpenRouterModelInfo {
  id: string;
  name: string;
  description?: string;
  pricing: {
    prompt: string;    // per token, USD string
    completion: string; // per token, USD string
  };
  context_length: number;
  top_provider?: {
    context_length?: number;
    max_completion_tokens?: number;
    is_moderated?: boolean;
  };
  architecture?: {
    modality?: string;
    tokenizer?: string;
    instruct_type?: string;
  };
  per_request_limits?: {
    prompt_tokens?: string;
    completion_tokens?: string;
  };
}

export interface BenchmarkScore {
  source: string;          // "llm-arena" | "sota" | "openrouter" | "openclaw-eval"
  benchmark: string;       // "MMLU" | "HumanEval" | "MATH" | "SWE-Bench" | "arena-elo" etc.
  score: number;           // normalized 0-100
  rawScore?: number;       // original score
  rawMax?: number;         // original max
  date: string;            // ISO date when benchmark was published
  url?: string;            // source URL
}

export interface ModelEvalResult {
  modelId: string;
  provider: string;
  evaluatedAt: string;
  scores: {
    capability: number;    // 0-100: reasoning, coding, knowledge
    speed: number;         // 0-100: latency & throughput
    cost: number;          // 0-100: lower cost = higher score
    safety: number;        // 0-100: safety & alignment
    overall: number;       // weighted composite
  };
  benchmarks: BenchmarkScore[];
  metadata: {
    contextWindow: number;
    promptPricePer1M: number;   // USD per 1M tokens
    completionPricePer1M: number;
    isFree: boolean;
    maxOutputTokens?: number;
  };
  recommendation?: {
    bestRoles: string[];
    notes: string;
  };
}

export interface EvalQueryOptions {
  provider?: string;
  minOverall?: number;
  sortBy?: "overall" | "capability" | "speed" | "cost" | "safety";
  limit?: number;
  sinceDays?: number;
}

// ========== 常量 ==========

const OPENROUTER_API_BASE = "https://openrouter.ai/api/v1";
const EVAL_DB_PATH = "./data/model-eval.db";
const CACHE_TTL_HOURS = 6;  // 评估数据缓存6小时

// 评分权重 (可配置)
const DEFAULT_WEIGHTS = {
  capability: 0.35,
  speed: 0.20,
  cost: 0.25,
  safety: 0.20,
};

// 基准搜索查询模板
const BENCHMARK_QUERIES = [
  "LLM arena leaderboard rankings 2026",
  "SOTA large language model benchmarks MMLU HumanEval MATH 2026",
  "SWE-Bench verified leaderboard AI coding models",
  "LMSYS Chatbot Arena Elo ratings 2026",
];

// ========== 数据库初始化 ==========

function initEvalDatabase(db: Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS model_evaluations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      model_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      evaluated_at INTEGER NOT NULL,
      capability_score REAL DEFAULT 0,
      speed_score REAL DEFAULT 0,
      cost_score REAL DEFAULT 0,
      safety_score REAL DEFAULT 0,
      overall_score REAL DEFAULT 0,
      benchmarks TEXT DEFAULT '[]',
      metadata TEXT DEFAULT '{}',
      recommendation TEXT DEFAULT '{}'
    );
    CREATE INDEX IF NOT EXISTS idx_eval_model ON model_evaluations(model_id);
    CREATE INDEX IF NOT EXISTS idx_eval_time ON model_evaluations(evaluated_at);
    CREATE INDEX IF NOT EXISTS idx_eval_overall ON model_evaluations(overall_score DESC);

    CREATE TABLE IF NOT EXISTS openrouter_models_cache (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      model_id TEXT UNIQUE NOT NULL,
      model_data TEXT NOT NULL,
      fetched_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_or_model ON openrouter_models_cache(model_id);

    CREATE TABLE IF NOT EXISTS benchmark_cache (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      query_hash TEXT UNIQUE NOT NULL,
      results TEXT NOT NULL,
      fetched_at INTEGER NOT NULL
    );
  `);
}

// ========== OpenRouter API 数据拉取 ==========

async function fetchOpenRouterModels(apiKey?: string): Promise<OpenRouterModelInfo[]> {
  const key = apiKey || process.env.OPENROUTER_API_KEY;
  if (!key) {
    logger.warn("[ModelEval] No OPENROUTER_API_KEY, skipping OpenRouter fetch");
    return [];
  }

  try {
    const res = await proxyFetch(`${OPENROUTER_API_BASE}/models`, {
      headers: {
        "Authorization": `Bearer ${key}`,
        "HTTP-Referer": "https://openclaw.ai",
        "X-Title": "OpenClaw Agent",
      },
      timeout: 15000,
    });

    if (!res.ok) {
      logger.warn("[ModelEval] OpenRouter API returned", { status: res.status });
      return [];
    }

    const data = await res.json() as { data?: OpenRouterModelInfo[] };
    return data.data || [];
  } catch (err) {
    logger.warn("[ModelEval] OpenRouter fetch failed", { error: (err as Error).message });
    return [];
  }
}

// ========== 基准数据搜索与解析 ==========

/**
 * 使用 UnifiedSearch 搜索基准数据，然后解析提取分数
 */
async function searchBenchmarkData(
  modelName: string,
  modelId: string,
  db: Database
): Promise<BenchmarkScore[]> {
  const queryHash = String(Bun.hash(`${modelName}:${modelId}`));

  // Check cache
  const cached = db.prepare(
    "SELECT results FROM benchmark_cache WHERE query_hash = ? AND fetched_at > ?"
  ).get(queryHash, Date.now() - CACHE_TTL_HOURS * 3600 * 1000) as { results: string } | undefined;

  if (cached) {
    try { return JSON.parse(cached.results); } catch { /* fall through */ }
  }

  const scores: BenchmarkScore[] = [];

  try {
    // Lazy import to avoid circular dependency
    const { UnifiedSearch } = await import("../crawl/unified-search.js");
    const search = new UnifiedSearch();

    // Search for model-specific benchmarks
    const query = `${modelName} LLM benchmark score arena ranking 2026`;
    const results = await search.quickSearch(query, 10);

    for (const result of results) {
      const parsed = parseBenchmarkSnippet(result.snippet, result.title, modelName, result.link);
      scores.push(...parsed);
    }

    // Search for coding benchmarks specifically
    const codingQuery = `${modelName} SWE-Bench HumanEval coding benchmark score`;
    const codingResults = await search.quickSearch(codingQuery, 5);

    for (const result of codingResults) {
      const parsed = parseBenchmarkSnippet(result.snippet, result.title, modelName, result.link);
      scores.push(...parsed);
    }

    search.close();
  } catch (err) {
    logger.warn("[ModelEval] Benchmark search failed", {
      model: modelName,
      error: (err as Error).message,
    });
  }

  // Fallback: estimate from OpenRouter metadata if no web results
  if (scores.length === 0) {
    scores.push(...estimateFromMetadata(modelId, modelName));
  }

  // Cache results
  try {
    db.prepare(
      "INSERT OR REPLACE INTO benchmark_cache (query_hash, results, fetched_at) VALUES (?, ?, ?)"
    ).run(queryHash, JSON.stringify(scores), Date.now());
  } catch { /* ignore cache errors */ }

  return scores;
}

/**
 * 从搜索结果片段中提取基准分数
 */
function parseBenchmarkSnippet(
  snippet: string,
  title: string,
  modelName: string,
  url: string
): BenchmarkScore[] {
  const scores: BenchmarkScore[] = [];
  const text = `${title} ${snippet}`.toLowerCase();
  const now = new Date().toISOString();

  // Arena ELO rating
  const eloMatch = text.match(/(?:elo|rating|arena)\s*(?:score|rating)?[:\s]*(\d{3,4})/i);
  if (eloMatch) {
    const elo = parseInt(eloMatch[1]);
    if (elo >= 800 && elo <= 2000) {
      scores.push({
        source: "llm-arena",
        benchmark: "arena-elo",
        score: Math.min(100, Math.max(0, ((elo - 800) / 800) * 100)),
        rawScore: elo,
        rawMax: 1800,
        date: now,
        url,
      });
    }
  }

  // MMLU
  const mmluMatch = text.match(/mmlu[:\s]*(\d+\.?\d*)%?/i);
  if (mmluMatch) {
    const mmlu = parseFloat(mmluMatch[1]);
    const normalized = mmlu > 1 ? mmlu : mmlu * 100;
    if (normalized >= 20 && normalized <= 100) {
      scores.push({
        source: "sota",
        benchmark: "MMLU",
        score: normalized,
        rawScore: normalized,
        rawMax: 100,
        date: now,
        url,
      });
    }
  }

  // HumanEval / coding
  const humanEvalMatch = text.match(/humaneval[:\s]*(\d+\.?\d*)%?/i);
  if (humanEvalMatch) {
    const he = parseFloat(humanEvalMatch[1]);
    const normalized = he > 1 ? he : he * 100;
    if (normalized >= 10 && normalized <= 100) {
      scores.push({
        source: "sota",
        benchmark: "HumanEval",
        score: normalized,
        rawScore: normalized,
        rawMax: 100,
        date: now,
        url,
      });
    }
  }

  // SWE-Bench
  const sweMatch = text.match(/swe-?bench[:\s]*(\d+\.?\d*)%?/i);
  if (sweMatch) {
    const swe = parseFloat(sweMatch[1]);
    const normalized = swe > 1 ? swe : swe * 100;
    if (normalized >= 5 && normalized <= 100) {
      scores.push({
        source: "sota",
        benchmark: "SWE-Bench",
        score: Math.min(100, normalized * 1.5), // SWE-Bench is hard, scale up
        rawScore: normalized,
        rawMax: 100,
        date: now,
        url,
      });
    }
  }

  // MATH benchmark
  const mathMatch = text.match(/math[:\s]*(\d+\.?\d*)%?/i);
  if (mathMatch && !text.includes("mathematics") && text.length < 500) {
    const math = parseFloat(mathMatch[1]);
    const normalized = math > 1 ? math : math * 100;
    if (normalized >= 10 && normalized <= 100) {
      scores.push({
        source: "sota",
        benchmark: "MATH",
        score: normalized,
        rawScore: normalized,
        rawMax: 100,
        date: now,
        url,
      });
    }
  }

  return scores;
}

/**
 * 当无法获取网络基准数据时，基于模型元数据估算分数
 */
function estimateFromMetadata(modelId: string, modelName: string): BenchmarkScore[] {
  const lower = `${modelId} ${modelName}`.toLowerCase();
  const now = new Date().toISOString();

  // Heuristic estimation based on model naming patterns
  let baseScore = 50;

  // Known high-capability model families
  if (lower.includes("gpt-4") || lower.includes("claude") || lower.includes("opus")) baseScore = 85;
  else if (lower.includes("gpt-3.5") || lower.includes("sonnet")) baseScore = 75;
  else if (lower.includes("deepseek") && lower.includes("v3")) baseScore = 78;
  else if (lower.includes("deepseek") && lower.includes("v4")) baseScore = 82;
  else if (lower.includes("glm") && lower.includes("5")) baseScore = 80;
  else if (lower.includes("glm") && lower.includes("4")) baseScore = 72;
  else if (lower.includes("kimi") && lower.includes("k2")) baseScore = 78;
  else if (lower.includes("minimax") && lower.includes("m3")) baseScore = 79;
  else if (lower.includes("qwen") && lower.includes("3")) baseScore = 76;
  else if (lower.includes("hermes") || lower.includes("405b")) baseScore = 74;
  else if (lower.includes("llama") && lower.includes("3.3")) baseScore = 70;
  else if (lower.includes("gemma") && lower.includes("4")) baseScore = 68;
  else if (lower.includes(":free") || lower.includes("free")) baseScore = 60;

  return [{
    source: "openclaw-eval",
    benchmark: "metadata-estimate",
    score: baseScore,
    date: now,
  }];
}

// ========== 评分计算 ==========

/**
 * 计算速度分数: 基于上下文长度和价格推断推理速度
 * (真实延迟需要通过 eval-runner 实测获取)
 */
function computeSpeedScore(model: OpenRouterModelInfo): number {
  let score = 70; // baseline

  // Smaller context models tend to be faster
  const ctx = model.context_length || 0;
  if (ctx <= 8192) score += 15;
  else if (ctx <= 32768) score += 10;
  else if (ctx <= 131072) score += 5;
  else if (ctx > 256000) score -= 10;

  // Free models usually have rate limits (slower in practice)
  const isFree = model.id.includes(":free");
  if (isFree) score -= 10;

  // Models with high output limits tend to be optimized
  const maxOutput = parseInt(model.per_request_limits?.completion_tokens || "0");
  if (maxOutput > 8192) score += 5;

  return Math.min(100, Math.max(0, score));
}

/**
 * 计算成本分数: 价格越低分数越高
 */
function computeCostScore(model: OpenRouterModelInfo): number {
  const promptPrice = parseFloat(model.pricing?.prompt || "0");
  const completionPrice = parseFloat(model.pricing?.completion || "0");

  // Free model
  if (model.id.includes(":free") || (promptPrice === 0 && completionPrice === 0)) {
    return 100;
  }

  // Price is per token, convert to per-1M-tokens for readability
  const promptPer1M = promptPrice * 1_000_000;
  const completionPer1M = completionPrice * 1_000_000;
  const avgPrice = (promptPer1M + completionPer1M) / 2;

  // Scoring curve: $0/1M = 100, $1/1M = 80, $5/1M = 60, $15/1M = 40, $50+/1M = 10
  if (avgPrice <= 0.5) return 95;
  if (avgPrice <= 1) return 85;
  if (avgPrice <= 3) return 75;
  if (avgPrice <= 5) return 65;
  if (avgPrice <= 10) return 50;
  if (avgPrice <= 20) return 35;
  if (avgPrice <= 50) return 20;
  return 10;
}

/**
 * 计算安全分数: 基于模型元数据推断
 */
function computeSafetyScore(model: OpenRouterModelInfo): number {
  let score = 70; // baseline

  // Moderated models get a boost
  if (model.top_provider?.is_moderated) score += 15;

  // Known safe model families
  const id = model.id.toLowerCase();
  if (id.includes("gpt-4") || id.includes("claude")) score += 10;
  if (id.includes("gemini")) score += 8;
  if (id.includes("llama") || id.includes("gemma")) score += 5;

  // Instruct/chat models are typically more aligned
  if (model.architecture?.instruct_type === "instruct" || id.includes("instruct")) score += 5;
  if (id.includes("chat")) score += 3;

  return Math.min(100, Math.max(0, score));
}

/**
 * 计算综合能力分数
 */
function computeCapabilityScore(
  model: OpenRouterModelInfo,
  benchmarks: BenchmarkScore[]
): number {
  // If we have benchmark data, use weighted average
  if (benchmarks.length > 0) {
    const weightedScores: [number, number][] = []; // [score, weight]

    for (const b of benchmarks) {
      const weight = BENCHMARK_WEIGHTS[b.benchmark] || 0.5;
      weightedScores.push([b.score, weight]);
    }

    const totalWeight = weightedScores.reduce((sum, [, w]) => sum + w, 0);
    if (totalWeight > 0) {
      const weightedAvg = weightedScores.reduce((sum, [s, w]) => sum + s * w, 0) / totalWeight;
      return Math.round(Math.min(100, Math.max(0, weightedAvg)));
    }
  }

  // Fallback: estimate from metadata
  const estimates = benchmarks.filter(b => b.source === "openclaw-eval");
  if (estimates.length > 0) {
    return Math.round(estimates.reduce((sum, b) => sum + b.score, 0) / estimates.length);
  }

  return 50; // default unknown
}

// 各基准的权重
const BENCHMARK_WEIGHTS: Record<string, number> = {
  "arena-elo": 1.0,
  "MMLU": 0.8,
  "HumanEval": 0.9,
  "SWE-Bench": 1.0,
  "MATH": 0.7,
  "metadata-estimate": 0.3,
};

/**
 * 基于模型能力推断最佳角色
 */
function inferBestRoles(
  model: OpenRouterModelInfo,
  scores: ModelEvalResult["scores"]
): string[] {
  const roles: string[] = [];
  const id = model.id.toLowerCase();
  const ctx = model.context_length || 0;

  // High capability → decision, architecture
  if (scores.capability >= 75) roles.push("decision", "architecture");

  // Coding models
  if (id.includes("coder") || id.includes("code") || id.includes("dev")) {
    roles.push("code-generation", "code-review", "coding");
  }

  // Research / deep research
  if (id.includes("hermes") || id.includes("research") || id.includes("deepseek-r")) {
    roles.push("research", "deep_research", "rl");
  }

  // Long context → good for review and analysis
  if (ctx >= 128000) roles.push("review", "research");

  // Fast models → general chat, decision routing
  if (scores.speed >= 80) roles.push("decision", "general-chat");

  // Free models → tool pool
  if (model.id.includes(":free")) roles.push("general-tool", "english");

  // Embedding
  if (id.includes("embed") || id.includes("bge")) roles.push("embedding");

  // Ensure at least one role
  if (roles.length === 0) roles.push("general-chat");

  return [...new Set(roles)];
}

// ========== 主服务类 ==========

export class ModelEvalService {
  private db: Database;
  private lastFullEval: number = 0;
  private evalInProgress = false;

  constructor(dbPath?: string) {
    this.db = new Database(dbPath || EVAL_DB_PATH);
    initEvalDatabase(this.db);
  }

  /**
   * 执行完整的模型评估流程
   * 1. 从 OpenRouter 拉取模型列表
   * 2. 搜索基准数据
   * 3. 计算多维度评分
   * 4. 持久化结果
   */
  async runFullEvaluation(opts?: {
    models?: string[];       // 只评估指定模型
    includeBenchmarks?: boolean;  // 是否搜索网络基准 (default: true)
    apiKey?: string;
  }): Promise<ModelEvalResult[]> {
    if (this.evalInProgress) {
      logger.warn("[ModelEval] Evaluation already in progress, skipping");
      return [];
    }

    this.evalInProgress = true;
    const startTime = performance.now();
    const results: ModelEvalResult[] = [];

    try {
      // Step 1: Fetch OpenRouter models
      logger.info("[ModelEval] Fetching OpenRouter model catalog...");
      const openRouterModels = await fetchOpenRouterModels(opts?.apiKey);
      logger.info("[ModelEval] Fetched models", { count: openRouterModels.length });

      // Cache OpenRouter models
      this.cacheOpenRouterModels(openRouterModels);

      // Filter if specific models requested
      const targetModels = opts?.models
        ? openRouterModels.filter(m => opts.models!.some(id => m.id.includes(id) || m.name.includes(id)))
        : openRouterModels;

      // Step 2: Evaluate each model
      const includeBench = opts?.includeBenchmarks !== false;
      const concurrency = 5; // limit concurrent web searches
      const queue = [...targetModels];
      const workers: Promise<void>[] = [];

      for (let i = 0; i < Math.min(concurrency, queue.length); i++) {
        workers.push((async () => {
          while (queue.length > 0) {
            const model = queue.shift();
            if (!model) break;

            try {
              const result = await this.evaluateModel(model, includeBench);
              results.push(result);
              this.persistEvaluation(result);
            } catch (err) {
              logger.warn("[ModelEval] Failed to evaluate model", {
                model: model.id,
                error: (err as Error).message,
              });
            }
          }
        })());
      }

      await Promise.all(workers);

      this.lastFullEval = Date.now();
      const elapsed = Math.round(performance.now() - startTime);
      logger.info("[ModelEval] Full evaluation complete", {
        modelsEvaluated: results.length,
        elapsedMs: elapsed,
      });
    } catch (err) {
      logger.error("[ModelEval] Full evaluation failed", err as Error);
    } finally {
      this.evalInProgress = false;
    }

    return results;
  }

  /**
   * 评估单个 OpenRouter 模型
   */
  async evaluateModel(
    model: OpenRouterModelInfo,
    includeBenchmarks = true
  ): Promise<ModelEvalResult> {
    // Fetch benchmarks if requested
    let benchmarks: BenchmarkScore[] = [];
    if (includeBenchmarks) {
      benchmarks = await searchBenchmarkData(model.name, model.id, this.db);
    }

    // Compute scores
    const capability = computeCapabilityScore(model, benchmarks);
    const speed = computeSpeedScore(model);
    const cost = computeCostScore(model);
    const safety = computeSafetyScore(model);

    const overall = Math.round(
      capability * DEFAULT_WEIGHTS.capability +
      speed * DEFAULT_WEIGHTS.speed +
      cost * DEFAULT_WEIGHTS.cost +
      safety * DEFAULT_WEIGHTS.safety
    );

    const promptPrice = parseFloat(model.pricing?.prompt || "0") * 1_000_000;
    const completionPrice = parseFloat(model.pricing?.completion || "0") * 1_000_000;

    const result: ModelEvalResult = {
      modelId: model.id,
      provider: this.inferProvider(model.id),
      evaluatedAt: new Date().toISOString(),
      scores: { capability, speed, cost, safety, overall },
      benchmarks,
      metadata: {
        contextWindow: model.context_length || 0,
        promptPricePer1M: Math.round(promptPrice * 100) / 100,
        completionPricePer1M: Math.round(completionPrice * 100) / 100,
        isFree: model.id.includes(":free") || (promptPrice === 0 && completionPrice === 0),
        maxOutputTokens: model.top_provider?.max_completion_tokens
          ? parseInt(String(model.top_provider.max_completion_tokens))
          : undefined,
      },
      recommendation: {
        bestRoles: inferBestRoles(model, { capability, speed, cost, safety, overall }),
        notes: this.generateNotes(model, { capability, speed, cost, safety, overall }),
      },
    };

    return result;
  }

  /**
   * 快速评估: 只评估本地注册表中的模型，不搜索网络基准
   */
  async quickEvaluation(): Promise<ModelEvalResult[]> {
    const openRouterModels = await fetchOpenRouterModels();
    if (openRouterModels.length === 0) return [];

    // Get models from local registry
    const { UNIFIED_REGISTRY } = await import("../router/models.js");
    const registryIds = UNIFIED_REGISTRY.map(m => m.model);

    // Filter to only models that exist in our registry
    const relevantModels = openRouterModels.filter(m =>
      registryIds.some(rid => m.id.includes(rid) || rid.includes(m.id.split("/").pop() || ""))
    );

    const results: ModelEvalResult[] = [];
    for (const model of relevantModels) {
      const result = await this.evaluateModel(model, false);
      results.push(result);
      this.persistEvaluation(result);
    }

    return results;
  }

  // ========== 查询接口 ==========

  /**
   * 查询最新评估结果
   */
  getLatestResults(opts?: EvalQueryOptions): ModelEvalResult[] {
    const since = opts?.sinceDays
      ? Date.now() - opts.sinceDays * 86400 * 1000
      : Date.now() - 7 * 86400 * 1000; // default 7 days

    let sql = `
      SELECT * FROM model_evaluations
      WHERE evaluated_at > ?
    `;
    const params: (string | number)[] = [since];

    if (opts?.provider) {
      sql += " AND provider = ?";
      params.push(opts.provider);
    }
    if (opts?.minOverall) {
      sql += " AND overall_score >= ?";
      params.push(opts.minOverall);
    }

    const sortCol = opts?.sortBy
      ? `${opts.sortBy}_score`
      : "overall_score";
    sql += ` ORDER BY ${sortCol} DESC`;

    if (opts?.limit) {
      sql += " LIMIT ?";
      params.push(opts.limit);
    }

    const rows = this.db.prepare(sql).all(...params) as any[];
    return rows.map(this.rowToEvalResult);
  }

  /**
   * 获取单个模型的最新评估
   */
  getModelEval(modelId: string): ModelEvalResult | null {
    const row = this.db.prepare(`
      SELECT * FROM model_evaluations
      WHERE model_id = ?
      ORDER BY evaluated_at DESC LIMIT 1
    `).get(modelId) as any;

    return row ? this.rowToEvalResult(row) : null;
  }

  /**
   * 获取评估统计摘要
   */
  getStats(): {
    totalEvaluations: number;
    modelsEvaluated: number;
    lastEvalAt: string | null;
    topModels: { modelId: string; overall: number }[];
  } {
    const total = this.db.prepare(
      "SELECT COUNT(*) as c FROM model_evaluations"
    ).get() as { c: number };

    const models = this.db.prepare(
      "SELECT COUNT(DISTINCT model_id) as c FROM model_evaluations"
    ).get() as { c: number };

    const last = this.db.prepare(
      "SELECT MAX(evaluated_at) as t FROM model_evaluations"
    ).get() as { t: number | null };

    const top = this.db.prepare(`
      SELECT model_id, MAX(overall_score) as overall
      FROM model_evaluations
      WHERE evaluated_at > ?
      GROUP BY model_id
      ORDER BY overall DESC
      LIMIT 10
    `).all(Date.now() - 7 * 86400 * 1000) as { model_id: string; overall: number }[];

    return {
      totalEvaluations: total.c,
      modelsEvaluated: models.c,
      lastEvalAt: last.t ? new Date(last.t).toISOString() : null,
      topModels: top.map(t => ({ modelId: t.model_id, overall: Math.round(t.overall) })),
    };
  }

  /**
   * 获取模型评估历史趋势
   */
  getModelTrend(modelId: string, days = 30): { date: string; overall: number; capability: number }[] {
    const since = Date.now() - days * 86400 * 1000;
    const rows = this.db.prepare(`
      SELECT evaluated_at, overall_score, capability_score
      FROM model_evaluations
      WHERE model_id = ? AND evaluated_at > ?
      ORDER BY evaluated_at ASC
    `).all(modelId, since) as { evaluated_at: number; overall_score: number; capability_score: number }[];

    return rows.map(r => ({
      date: new Date(r.evaluated_at).toISOString().slice(0, 10),
      overall: Math.round(r.overall_score),
      capability: Math.round(r.capability_score),
    }));
  }

  /**
   * 获取 OpenRouter 缓存的模型列表
   */
  getCachedModels(): OpenRouterModelInfo[] {
    const rows = this.db.prepare(
      "SELECT model_data FROM openrouter_models_cache WHERE fetched_at > ?"
    ).all(Date.now() - CACHE_TTL_HOURS * 3600 * 1000) as { model_data: string }[];

    return rows.map(r => {
      try { return JSON.parse(r.model_data); } catch { return null; }
    }).filter(Boolean) as OpenRouterModelInfo[];
  }

  // ========== 内部方法 ==========

  private cacheOpenRouterModels(models: OpenRouterModelInfo[]) {
    const stmt = this.db.prepare(
      "INSERT OR REPLACE INTO openrouter_models_cache (model_id, model_data, fetched_at) VALUES (?, ?, ?)"
    );

    for (const model of models) {
      try {
        stmt.run(model.id, JSON.stringify(model), Date.now());
      } catch { /* ignore individual cache errors */ }
    }
  }

  private persistEvaluation(result: ModelEvalResult) {
    try {
      this.db.prepare(`
        INSERT INTO model_evaluations
        (model_id, provider, evaluated_at, capability_score, speed_score, cost_score, safety_score, overall_score, benchmarks, metadata, recommendation)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        result.modelId,
        result.provider,
        Date.now(),
        result.scores.capability,
        result.scores.speed,
        result.scores.cost,
        result.scores.safety,
        result.scores.overall,
        JSON.stringify(result.benchmarks),
        JSON.stringify(result.metadata),
        JSON.stringify(result.recommendation),
      );
    } catch (err) {
      logger.warn("[ModelEval] Failed to persist evaluation", {
        model: result.modelId,
        error: (err as Error).message,
      });
    }
  }

  private rowToEvalResult(row: any): ModelEvalResult {
    return {
      modelId: row.model_id,
      provider: row.provider,
      evaluatedAt: new Date(row.evaluated_at).toISOString(),
      scores: {
        capability: Math.round(row.capability_score),
        speed: Math.round(row.speed_score),
        cost: Math.round(row.cost_score),
        safety: Math.round(row.safety_score),
        overall: Math.round(row.overall_score),
      },
      benchmarks: safeJsonParse(row.benchmarks, []),
      metadata: safeJsonParse(row.metadata, {
        contextWindow: 0,
        promptPricePer1M: 0,
        completionPricePer1M: 0,
        isFree: false,
      }),
      recommendation: safeJsonParse(row.recommendation, undefined),
    };
  }

  private inferProvider(modelId: string): string {
    const lower = modelId.toLowerCase();
    if (lower.includes("deepseek")) return "deepseek";
    if (lower.includes("anthropic") || lower.includes("claude")) return "anthropic";
    if (lower.includes("openai") || lower.includes("gpt")) return "openai";
    if (lower.includes("google") || lower.includes("gemini") || lower.includes("gemma")) return "google";
    if (lower.includes("meta") || lower.includes("llama")) return "meta";
    if (lower.includes("qwen")) return "qwen";
    if (lower.includes("mistral")) return "mistral";
    if (lower.includes("z-ai") || lower.includes("glm")) return "zhipu";
    if (lower.includes("moonshot") || lower.includes("kimi")) return "kimi";
    if (lower.includes("minimax")) return "minimax";
    if (lower.includes("nous")) return "nousresearch";
    return "other";
  }

  private generateNotes(
    model: OpenRouterModelInfo,
    scores: ModelEvalResult["scores"]
  ): string {
    const notes: string[] = [];
    const isFree = model.id.includes(":free");

    if (scores.overall >= 80) notes.push("High overall performance");
    if (scores.capability >= 85) notes.push("Excellent capability — suitable for complex reasoning");
    if (scores.speed >= 85) notes.push("Very fast — ideal for real-time routing");
    if (scores.cost >= 90) notes.push(isFree ? "Free tier available" : "Very cost-effective");
    if (scores.safety >= 85) notes.push("Strong safety alignment");

    if (scores.capability < 50) notes.push("Below average capability — use for simple tasks only");
    if (scores.speed < 40) notes.push("May be slow under load");
    if (scores.cost < 30) notes.push("Relatively expensive");

    return notes.join(". ") || "Standard model — evaluate for specific use cases";
  }

  /** 关闭数据库 */
  close() {
    this.db.close();
  }
}

// ========== 工具函数 ==========

function safeJsonParse<T>(str: string | undefined, fallback: T): T {
  if (!str) return fallback;
  try { return JSON.parse(str); } catch { return fallback; }
}

// ========== 全局单例 ==========

let _instance: ModelEvalService | null = null;

export function getModelEvalService(): ModelEvalService {
  if (!_instance) {
    _instance = new ModelEvalService();
  }
  return _instance;
}
