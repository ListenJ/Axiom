/**
 * 多维度搜索结果打分器 (Task 2.2)
 *
 * 4 维度评分（各 0-1，加权 0-100）：
 *   1. sourceCredibility：TLD 加权（.edu/.gov 高，.xyz/.top 低）
 *   2. contentRelevance：与 query 的 Jaccard 相似度（复用 hallucination-detector 的 tokenize 思路）
 *   3. timeliness：publishDate 距今天数，越近分越高
 *   4. factualAccuracy：调 ConformalHallucinationDetector.verify(statement=snippet, context=query) 取 1 - pValue
 *
 * API: scoreResult(result, query, factBase?): ScoreBreakdown
 */
import type { SearchEngineResult } from "./search-engines.js";
import { ConformalHallucinationDetector, type FactEntry } from "../memory/hallucination-detector.js";

export interface ScoreBreakdown {
  sourceCredibility: number;
  contentRelevance: number;
  timeliness: number;
  factualAccuracy: number;
  total: number;
}

/** 权重（总和 1.0） */
const WEIGHTS = {
  sourceCredibility: 0.2,
  contentRelevance: 0.35,
  timeliness: 0.15,
  factualAccuracy: 0.3,
} as const;

/** TLD 可信度映射 */
const TLD_CREDIBILITY: Record<string, number> = {
  ".gov": 1.0,
  ".edu": 0.95,
  ".mil": 0.95,
  ".org": 0.75,
  ".io": 0.65,
  ".dev": 0.65,
  ".ai": 0.6,
  ".com": 0.55,
  ".net": 0.5,
  ".cn": 0.5,
  ".xyz": 0.25,
  ".top": 0.2,
  ".click": 0.2,
  ".loan": 0.15,
  ".work": 0.2,
  ".biz": 0.3,
  ".info": 0.3,
};

/** 简单 tokenizer：小写、按非字母数字拆分、过滤短词 */
function tokenize(text: string): Set<string> {
  return new Set(
    text.toLowerCase().split(/[^a-z0-9\u4e00-\u9fa5]+/).filter((t) => t.length >= 2)
  );
}

/** Jaccard 相似度 */
function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const t of a) if (b.has(t)) intersection++;
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/** 计算 sourceCredibility (0-1) */
function scoreSourceCredibility(link: string): number {
  try {
    const hostname = new URL(link).hostname.toLowerCase();
    // 取最长匹配的 TLD
    let bestTld = "";
    for (const tld of Object.keys(TLD_CREDIBILITY)) {
      if (hostname.endsWith(tld) && tld.length > bestTld.length) {
        bestTld = tld;
      }
    }
    if (bestTld) return TLD_CREDIBILITY[bestTld];
    // 未知 TLD 给中位分
    return 0.5;
  } catch {
    return 0.3;
  }
}

/** 计算 contentRelevance (0-1) */
function scoreContentRelevance(result: SearchEngineResult, query: string): number {
  const queryTokens = tokenize(query);
  const titleTokens = tokenize(result.title);
  const snippetTokens = tokenize(result.snippet);
  // 标题相似度权重 0.6，snippet 相似度权重 0.4
  const titleSim = jaccardSimilarity(queryTokens, titleTokens);
  const snippetSim = jaccardSimilarity(queryTokens, snippetTokens);
  return Math.min(1, titleSim * 0.6 + snippetSim * 0.4);
}

/** 计算 timeliness (0-1)，越近分越高 */
function scoreTimeliness(dateStr?: string): number {
  if (!dateStr) return 0.5; // 无日期给中位分
  const date = new Date(dateStr);
  if (isNaN(date.getTime())) return 0.5;
  const daysAgo = (Date.now() - date.getTime()) / (1000 * 60 * 60 * 24);
  if (daysAgo <= 0) return 1.0;
  if (daysAgo <= 7) return 0.9;
  if (daysAgo <= 30) return 0.8;
  if (daysAgo <= 90) return 0.65;
  if (daysAgo <= 365) return 0.45;
  return 0.25;
}

/** 计算 factualAccuracy (0-1)，基于 ConformalHallucinationDetector */
function scoreFactualAccuracy(
  result: SearchEngineResult,
  query: string,
  factBase?: FactEntry[],
): number {
  // 无 snippet 直接给中位分（无法判定）
  if (!result.snippet || result.snippet.trim().length === 0) return 0.5;
  try {
    const detector = new ConformalHallucinationDetector({
      alpha: 0.1,
      factBase: factBase ?? [],
    });
    const verdict = detector.verify(result.snippet, query);
    // pValue 越大越可信（非幻觉），factualAccuracy = 1 - pValue 是错的
    // 实际：pValue 大 = 可信 = 高分；factualAccuracy = pValue
    return Math.max(0, Math.min(1, verdict.pValue));
  } catch {
    // 检测器失败时给保守中位分
    return 0.5;
  }
}

/**
 * 多维度打分。
 * @param result 搜索结果
 * @param query 查询字符串
 * @param factBase 可选事实库（用于 factualAccuracy）
 */
export function scoreResult(
  result: SearchEngineResult,
  query: string,
  factBase?: FactEntry[],
): ScoreBreakdown {
  const sourceCredibility = scoreSourceCredibility(result.link);
  const contentRelevance = scoreContentRelevance(result, query);
  const timeliness = scoreTimeliness(result.date);
  const factualAccuracy = scoreFactualAccuracy(result, query, factBase);

  const total = Math.round(
    100 *
      (sourceCredibility * WEIGHTS.sourceCredibility +
        contentRelevance * WEIGHTS.contentRelevance +
        timeliness * WEIGHTS.timeliness +
        factualAccuracy * WEIGHTS.factualAccuracy),
  );

  return {
    sourceCredibility,
    contentRelevance,
    timeliness,
    factualAccuracy,
    total,
  };
}
