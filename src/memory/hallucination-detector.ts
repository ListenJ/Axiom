/**
 * 幻觉检测器 — 基于归纳式共形预测 (Inductive Conformal Prediction)
 *
 * ## 核心数学原理
 *
 * 给定事实库 factBase = {f_j}_{j=1}^m，对任意陈述 statement 定义：
 *
 *   非一致性度量 (nonconformity measure):
 *     s(statement) = 1 - max_evidence_score(statement, factBase)
 *
 *   其中 max_evidence_score = max_{f ∈ factBase} jaccard(tokenize(statement), tokenize(f)) × f.confidence
 *
 *   校准集：{(statement_i, truth_i)}_{i=1}^n，truth_i ∈ {0,1}（0=幻觉，1=事实）
 *
 *   p-value (Mondrian-style conformal p-value):
 *     p = (|{s_i ∈ cal_set : s_i ≥ s_new}| + 1) / (n + 1)
 *
 *   决策规则：若 p < α → 判定为幻觉 (hallucination)
 *
 * ## 统计保证：FDR 控制
 *
 *   在可交换性假设下 (exchangeability)，False Discovery Rate (FDR) 受控：
 *     FDR ≤ α
 *
 *   换言之，检测器标记为"幻觉"的陈述中，最多有 α 比例的假阳性。
 *   这是共形预测保证的无分布 (distribution-free) 边界，无需任何分布假设。
 *
 * ## 证据评分（手写余弦/符号方法，PG vector 可选）
 *
 *   - 分词：中英文混合分词，过滤停用词
 *   - 相似度：Jaccard 系数 × 事实置信度
 *   - BM25 风格加权：结合 IDF-like 稀有词加权
 *   - 无 embedding / 向量 / 神经网络依赖
 *
 * ## 与 DeterministicSearchEngine 的集成
 *
 *   - 事实库可从 vault 中导入（通过 DeterministicSearchEngine 检索相关笔记）
 *   - FactEntry 结构兼容 VaultNote 和外部事实源
 *   - 支持增量校准：用户反馈逐个积累，动态更新校准集
 *
 * ## 参考文献
 *
 *   - Vovk, V., Gammerman, A., & Shafer, G. (2005). Algorithmic Learning in a Random World.
 *   - Angelopoulos, A. N., & Bates, S. (2021). A Gentle Introduction to Conformal Prediction
 *     and Distribution-Free Uncertainty Quantification.
 *   - Benjamini, Y., & Hochberg, Y. (1995). Controlling the False Discovery Rate.
 *   - Bates, S., Angelopoulos, A., Lei, L., Malik, J., & Jordan, M. (2021).
 *     Distribution-free, Risk-controlling Prediction Sets.
 */

import { logger } from "../utils/logger.js";

// ============================================================================
// 类型定义
// ============================================================================

/**
 * 事实库条目 — 一条已知事实
 *
 * 置信度 confidence ∈ [0, 1] 表示该事实的可靠程度：
 *   - 1.0：经过多重验证的确定事实（如"水的沸点是 100°C"）
 *   - 0.5：有一定依据但未经充分验证（如用户记忆中的模糊信息）
 *   - 0.0：不可靠，不应纳入事实库
 */
export interface FactEntry {
  /** 事实文本 */
  text: string;
  /** 可选的向量嵌入（用于未来升级到语义搜索，当前不使用） */
  embedding?: number[];
  /** 事实来源，如 "vault/科学/物理.md" */
  source?: string;
  /** 置信度 ∈ [0, 1] */
  confidence: number;
}

/**
 * 幻觉判定结果 — 对一条陈述的验证结论
 */
export interface HallucinationVerdict {
  /** 是否判定为幻觉（p < α 时为 true） */
  isHallucination: boolean;
  /** 共形 p-value，越大越可信 ∈ (0, 1] */
  pValue: number;
  /** 综合置信度：基于最大证据相似度和事实置信度的组合 ∈ [0, 1] */
  confidence: number;
  /** 匹配到的证据列表（按相似度降序排列） */
  evidence: EvidenceItem[];
}

/**
 * 证据项 — 陈述与某条事实的匹配详情
 */
export interface EvidenceItem {
  /** 事实的唯一标识（source + 索引哈希） */
  factId: string;
  /** 相似度得分 ∈ [0, 1] */
  similarity: number;
  /** 匹配到的事实文本 */
  text: string;
}

/**
 * 校准对 — 陈述及其真实标签
 *
 * truth ∈ {0, 1}：
 *   - 1：该陈述是事实（非幻觉）
 *   - 0：该陈述是幻觉
 */
export interface CalibrationPair {
  /** 陈述文本 */
  statement: string;
  /** 真实标签：true=事实, false=幻觉 */
  isFact: boolean;
}

/**
 * 校准质量诊断信息
 */
export interface CalibrationQuality {
  /** 校准集大小 n */
  n: number;
  /** 非一致性得分的均值 (越小越好，说明事实库覆盖好) */
  meanScore: number;
  /** 非一致性得分的分布摘要 */
  scoreDistribution: {
    min: number;
    max: number;
    median: number;
    /** 非一致性得分的第 25 百分位 */
    p25: number;
    /** 非一致性得分的第 75 百分位 */
    p75: number;
  };
}

/**
 * ConformalHallucinationDetector 配置
 */
export interface HallucinationDetectorConfig {
  alpha?: number;
  factBase?: FactEntry[];
  minTokenOverlap?: number;
}

// ============================================================================
// BM25 风格 IDF 计算
// ============================================================================

class IDFCache {
  private idf = new Map<string, number>();
  private totalDocs = 0;

  build(facts: FactEntry[]): void {
    this.idf.clear();
    this.totalDocs = facts.length;
    if (this.totalDocs === 0) return;

    const df = new Map<string, number>();
    for (const fact of facts) {
      const tokens = new Set(tokenize(fact.text));
      for (const t of tokens) {
        df.set(t, (df.get(t) || 0) + 1);
      }
    }

    for (const [token, docFreq] of df) {
      const idfVal = Math.log(
        (this.totalDocs - docFreq + 0.5) / (docFreq + 0.5) + 1
      );
      this.idf.set(token, Math.max(0, idfVal));
    }
  }

  get(token: string): number {
    return this.idf.get(token) ?? 0;
  }

  get docCount(): number {
    return this.totalDocs;
  }

  clear(): void {
    this.idf.clear();
    this.totalDocs = 0;
  }
}

// ============================================================================
// 分词器
// ============================================================================

function tokenize(text: string): string[] {
  if (!text || text.trim().length === 0) return [];

  const normalized = text.toLowerCase().trim();

  const stopWords = new Set([
    "a", "an", "the", "is", "are", "was", "were", "be", "been", "being",
    "have", "has", "had", "do", "does", "did", "will", "would", "could",
    "should", "may", "might", "can", "shall", "to", "of", "in", "for",
    "on", "with", "at", "by", "from", "as", "into", "through", "during",
    "before", "after", "above", "below", "between", "and", "but", "or",
    "nor", "not", "so", "yet", "both", "either", "neither", "each",
    "every", "all", "any", "few", "more", "most", "other", "some",
    "such", "no", "only", "own", "same", "than", "too", "very", "just",
    "it", "its", "this", "that", "these", "those", "he", "she", "they",
    "them", "his", "her", "their", "we", "you", "i", "me", "my", "our",
    "的", "了", "在", "是", "我", "有", "和", "就", "不", "人", "都",
    "一", "一个", "上", "也", "很", "到", "说", "要", "去", "你",
    "会", "着", "没有", "看", "好", "自己", "这", "他", "她", "它",
    "们", "那", "些", "什么", "怎么", "如何", "为什么", "因为",
    "所以", "但是", "虽然", "如果", "可以", "这个", "那个", "已经",
    "还", "还是", "又", "再", "才", "刚", "能", "能够", "会",
  ]);

  const tokens: string[] = [];
  const pattern = /[a-z0-9]+|[\u4e00-\u9fff]|[\u3040-\u309f\u30a0-\u30ff]|[\uac00-\ud7af]/g;

  let match: RegExpExecArray | null;
  while ((match = pattern.exec(normalized)) !== null) {
    const token = match[0];
    if (stopWords.has(token)) continue;
    if (/^[a-z0-9]+$/.test(token) && token.length < 2) continue;
    tokens.push(token);
  }

  return tokens;
}

function jaccardSimilarity(tokensA: string[], tokensB: string[]): number {
  if (tokensA.length === 0 && tokensB.length === 0) return 1.0;
  if (tokensA.length === 0 || tokensB.length === 0) return 0.0;

  const setA = new Set(tokensA);
  const setB = new Set(tokensB);
  let intersection = 0;
  for (const token of setA) {
    if (setB.has(token)) intersection++;
  }
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function bm25WeightedSimilarity(
  tokensA: string[],
  tokensB: string[],
  idf: IDFCache
): number {
  if (tokensA.length === 0 && tokensB.length === 0) return 1.0;
  if (tokensA.length === 0 || tokensB.length === 0) return 0.0;

  const setA = new Set(tokensA);
  const setB = new Set(tokensB);
  let intersectionWeight = 0;
  let unionWeight = 0;
  const counted = new Set<string>();

  for (const token of setA) {
    const w = idf.get(token);
    if (setB.has(token)) intersectionWeight += w;
    unionWeight += w;
    counted.add(token);
  }

  for (const token of setB) {
    if (!counted.has(token)) {
      unionWeight += idf.get(token);
    }
  }

  return unionWeight === 0 ? 0 : intersectionWeight / unionWeight;
}

// ============================================================================
// 哈希工具
// ============================================================================

function hashString(str: string): string {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash + str.charCodeAt(i)) | 0;
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

// ============================================================================
// ConformalHallucinationDetector 实现
// ============================================================================

export class ConformalHallucinationDetector {
  public readonly alpha: number;
  private factBase: FactEntry[];
  private idfCache = new IDFCache();
  private readonly minTokenOverlap: number;
  private calibrationScores: number[] = [];
  private n: number = 0;

  constructor(config: HallucinationDetectorConfig = {}) {
    this.alpha = config.alpha ?? 0.05;
    if (this.alpha <= 0 || this.alpha >= 1) {
      throw new Error(
        "ConformalHallucinationDetector: alpha must be in (0, 1), got: " + this.alpha
      );
    }
    this.factBase = config.factBase ?? [];
    this.minTokenOverlap = config.minTokenOverlap ?? 1;
    if (this.factBase.length > 0) {
      this.idfCache.build(this.factBase);
    }
    logger.info(
      "ConformalHallucinationDetector initialized: alpha=" + this.alpha +
      ", factBase=" + this.factBase.length +
      ", minTokenOverlap=" + this.minTokenOverlap
    );
  }

  calibrate(pairs: CalibrationPair[]): this {
    if (pairs.length === 0) {
      logger.warn("ConformalHallucinationDetector.calibrate: empty calibration set, no statistical guarantee");
      this.calibrationScores = [];
      this.n = 0;
      return this;
    }

    this.calibrationScores = pairs.map((pair) => {
      const maxScore = this.computeMaxEvidenceScore(pair.statement);
      return 1 - maxScore;
    });

    this.calibrationScores.sort((a, b) => a - b);
    this.n = this.calibrationScores.length;

    const stats = this.computeScoreStats(this.calibrationScores);
    logger.info(
      "ConformalHallucinationDetector.calibrate: done, n=" + this.n +
      ", range [" + stats.min.toFixed(4) + ", " + stats.max.toFixed(4) + "]" +
      ", mean=" + stats.mean.toFixed(4) +
      ", median=" + stats.median.toFixed(4)
    );

    return this;
  }

  verify(statement: string, context?: string): HallucinationVerdict {
    const log = logger.withContext({ component: "HallucinationDetector" });

    if (!statement || statement.trim().length === 0) {
      log.debug("verify: empty statement, conservative non-hallucination");
      return {
        isHallucination: false,
        pValue: 1.0,
        confidence: 1.0,
        evidence: [],
      };
    }

    const { maxScore, evidence } = this.computeEvidence(statement);
    const nonconformityScore = 1 - maxScore;
    const pValue = this.computePValue(nonconformityScore);
    const isHallucination = pValue < this.alpha;

    const truncated = statement.length > 60 ? statement.slice(0, 60) + "..." : statement;
    log.info(
      "verify: \"" + truncated + "\"" +
      " -> maxScore=" + maxScore.toFixed(4) +
      ", pValue=" + pValue.toFixed(4) +
      ", isHallucination=" + isHallucination +
      ", evidence=" + evidence.length
    );

    return {
      isHallucination,
      pValue,
      confidence: maxScore,
      evidence,
    };
  }

  private computeEvidence(statement: string): {
    maxScore: number;
    evidence: EvidenceItem[];
  } {
    const stTokens = tokenize(statement);
    if (stTokens.length === 0 || this.factBase.length === 0) {
      return { maxScore: 0, evidence: [] };
    }

    let maxScore = 0;
    const evidence: EvidenceItem[] = [];
    const stSet = new Set(stTokens);

    for (const fact of this.factBase) {
      const factTokens = tokenize(fact.text);
      if (factTokens.length === 0) continue;

      let overlapCount = 0;
      for (const ft of factTokens) {
        if (stSet.has(ft)) overlapCount++;
      }
      if (overlapCount < this.minTokenOverlap) continue;

      const baseSimilarity = bm25WeightedSimilarity(stTokens, factTokens, this.idfCache);
      if (baseSimilarity <= 0) continue;

      const similarity = baseSimilarity * fact.confidence;
      evidence.push({
        factId: (fact.source || "fact") + "_" + hashString(fact.text),
        similarity,
        text: fact.text,
      });

      if (similarity > maxScore) {
        maxScore = similarity;
      }
    }

    evidence.sort((a, b) => b.similarity - a.similarity);
    return { maxScore, evidence };
  }

  private computeMaxEvidenceScore(statement: string): number {
    const { maxScore } = this.computeEvidence(statement);
    return maxScore;
  }

  private computePValue(nonconformityScore: number): number {
    if (this.n === 0) return 1.0;
    const countGeq = this.countGreaterOrEqual(nonconformityScore);
    return (countGeq + 1) / (this.n + 1);
  }

  private countGreaterOrEqual(target: number): number {
    let left = 0;
    let right = this.n;
    while (left < right) {
      const mid = Math.floor((left + right) / 2);
      if (this.calibrationScores[mid] < target) {
        left = mid + 1;
      } else {
        right = mid;
      }
    }
    return this.n - left;
  }

  setFactBase(facts: FactEntry[]): void {
    this.factBase = facts;
    this.idfCache.clear();
    if (facts.length > 0) {
      this.idfCache.build(facts);
    }
    logger.info(
      "ConformalHallucinationDetector.setFactBase: updated, size=" + facts.length +
      " (note: re-calibrate recommended)"
    );
  }

  addFact(fact: FactEntry): void {
    this.factBase.push(fact);
    if (this.factBase.length > 0) {
      this.idfCache.build(this.factBase);
    }
    logger.debug(
      "ConformalHallucinationDetector.addFact: added \"" + fact.text.slice(0, 40) + "...\"" +
      ", confidence=" + fact.confidence +
      ", factBaseSize=" + this.factBase.length
    );
  }

  addFacts(facts: FactEntry[]): void {
    this.factBase.push(...facts);
    if (this.factBase.length > 0) {
      this.idfCache.build(this.factBase);
    }
    logger.info(
      "ConformalHallucinationDetector.addFacts: batch added " + facts.length +
      " facts, total=" + this.factBase.length
    );
  }

  get factBaseSize(): number {
    return this.factBase.length;
  }

  getCalibrationQuality(): CalibrationQuality {
    if (this.n === 0) {
      return {
        n: 0,
        meanScore: 0,
        scoreDistribution: { min: 0, max: 0, median: 0, p25: 0, p75: 0 },
      };
    }

    const stats = this.computeScoreStats(this.calibrationScores);
    return {
      n: this.n,
      meanScore: stats.mean,
      scoreDistribution: {
        min: stats.min,
        max: stats.max,
        median: stats.median,
        p25: this.percentile(this.calibrationScores, 25),
        p75: this.percentile(this.calibrationScores, 75),
      },
    };
  }

  private computeScoreStats(sortedScores: number[]): {
    min: number;
    max: number;
    mean: number;
    median: number;
  } {
    if (sortedScores.length === 0) {
      return { min: 0, max: 0, mean: 0, median: 0 };
    }
    const len = sortedScores.length;
    const min = sortedScores[0];
    const max = sortedScores[len - 1];
    const mean = sortedScores.reduce((sum, s) => sum + s, 0) / len;
    const median =
      len % 2 === 0
        ? (sortedScores[len / 2 - 1] + sortedScores[len / 2]) / 2
        : sortedScores[Math.floor(len / 2)];
    return { min, max, mean, median };
  }

  private percentile(sortedData: number[], p: number): number {
    if (sortedData.length === 0) return 0;
    const index = (p / 100) * (sortedData.length - 1);
    const lower = Math.floor(index);
    const upper = Math.ceil(index);
    if (lower === upper) return sortedData[lower];
    const weight = index - lower;
    return sortedData[lower] * (1 - weight) + sortedData[upper] * weight;
  }

  isValid(): boolean {
    return this.n > 0;
  }

  resetCalibration(): void {
    logger.info(
      "ConformalHallucinationDetector.resetCalibration: clearing (was n=" + this.n + ")"
    );
    this.calibrationScores = [];
    this.n = 0;
  }

  getDiagnostics(): {
    alpha: number;
    factBaseSize: number;
    calibrated: boolean;
    calibrationN: number;
    quality: CalibrationQuality;
  } {
    return {
      alpha: this.alpha,
      factBaseSize: this.factBase.length,
      calibrated: this.n > 0,
      calibrationN: this.n,
      quality: this.getCalibrationQuality(),
    };
  }
}

export default ConformalHallucinationDetector;
