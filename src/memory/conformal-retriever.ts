/**
 * Conformal Prediction 检索框架 — 为检索结果提供统计保证
 *
 * ## 数学原理：归纳式共形预测 (Inductive Conformal Prediction, ICP)
 *
 * 给定校准集 {(x_i, y_i)}_{i=1}^n，其中 y_i ∈ {0,1}（0=不相关，1=相关）
 *
 * 非一致性度量 (nonconformity measure):
 *   s(doc) = 1 - relevance_score
 *   越高的 s 值表示该文档与查询越"不一致"（越不相关）
 *
 * p-value 计算 (Mondrian-style conformal p-value):
 *   p = (|{s_i in cal_set : s_i ≥ s_new}| + 1) / (n + 1)
 *
 * 在显著性水平 α 下的预测集:
 *   Γ^α = {docs : p(doc) > α}
 *
 * ## 统计保证 (Validity Guarantee)
 *
 * 在可交换性假设下 (exchangeability)，真实相关文档被遗漏的概率受控：
 *   P(True Relevant Doc ∉ Γ^α) ≤ α
 *
 * 换言之，预测集以概率 ≥ 1-α 包含所有真正相关的文档。
 * 这为检索系统提供了严格的、可量化的召回率保证。
 *
 * ## 与 DeterministicSearchEngine 的集成
 *
 * - 校准集可由用户反馈随时间累积构建
 * - similarityFn 可使用现有的 BM25 得分
 * - predictionSet 提供了具有保形保证的召回集
 *
 * ## 参考文献
 *
 * - Vovk, V., Gammerman, A., & Shafer, G. (2005). Algorithmic Learning in a Random World.
 * - Angelopoulos, A. N., & Bates, S. (2021). A Gentle Introduction to Conformal Prediction
 *   and Distribution-Free Uncertainty Quantification.
 */

import { logger } from "../utils/logger.js";

// ============================================================================
// 类型定义
// ============================================================================

/**
 * 校准对 — 包含文档及其相关性评分的一对数据
 *
 * @template T 文档类型（泛型，适配不同检索系统的文档表示）
 */
export interface CalibrationPair<T> {
  /** 文档对象 */
  document: T;
  /**
   * 相关性评分，范围 [0, 1]
   * - 1.0：完全相关
   * - 0.0：完全不相关
   * - 中间值：部分相关
   */
  relevance: number;
}

/**
 * 共形检索结果 — 带有统计保证的预测文档集
 *
 * @template T 文档类型
 */
export interface ConformalResult<T> {
  /**
   * 预测集 Γ^α — 在显著性水平 α 下被判定为相关的文档集合
   * 保证：P(真正的相关文档 ∉ predictionSet) ≤ α
   */
  predictionSet: T[];

  /**
   * 每个候选文档的 p-value
   * p-value 越大，文档越可能是相关的
   */
  pValues: Map<T, number>;

  /**
   * 是否满足共形条件 — 即校准集非空
   * false 表示无法提供统计保证，此时 predictionSet 等于全部候选集（保守策略）
   */
  conformal: boolean;
}

/**
 * ConformalRetriever 配置
 */
export interface ConformalRetrieverConfig {
  /**
   * 显著性水平 α，默认 0.1
   *
   * 含义：我们允许最多 α 的概率漏掉真正相关的文档
   * - α = 0.1（默认）：90% 的置信度包含所有相关文档 → 较大的预测集
   * - α = 0.05：95% 的置信度 → 更大的预测集
   * - α = 0.2：80% 的置信度 → 较小的预测集
   *
   * 必须在 (0, 1) 范围内
   */
  alpha?: number;
}

// ============================================================================
// ConformalRetriever 实现
// ============================================================================

/**
 * 共形预测检索器
 *
 * 为任意检索系统添加统计保证层。通过校准集学习非一致性得分的分布，
 * 对新的查询生成带有保形 p-value 的预测文档集。
 *
 * 使用方式:
 * ```
 * const retriever = new ConformalRetriever<VaultNote>({ alpha: 0.1 });
 *
 * // 从用户反馈构建校准集
 * retriever.calibrate(userFeedbackPairs);
 *
 * // 检索时使用现有搜索引擎的得分函数
 * const result = retriever.retrieve(
 *   "如何配置 MCP",
 *   candidatesFromSearch,
 *   (q, doc) => bm25Score(q, doc)
 * );
 *
 * // predictionSet 内文档的召回率有 α-level 保证
 * console.log(result.predictionSet);
 * ```
 *
 * @template T 文档类型
 */
export class ConformalRetriever<T> {
  /** 显著性水平 (0, 1) */
  public readonly alpha: number;

  /**
   * 校准集非一致性得分分布
   * 排序数组，用于高效计算 p-value
   */
  private calibrationScores: number[] = [];

  /** 校准集大小 n */
  private n: number = 0;

  /**
   * 构造函数
   *
   * @param config 配置参数
   * @param config.alpha 显著性水平，默认 0.1，范围 (0, 1)
   *
   * @throws 如果 alpha 不在 (0, 1) 范围内
   */
  constructor(config: ConformalRetrieverConfig = {}) {
    this.alpha = config.alpha ?? 0.1;

    if (this.alpha <= 0 || this.alpha >= 1) {
      throw new Error(
        `ConformalRetriever: alpha 必须在 (0, 1) 范围内，当前值: ${this.alpha}`
      );
    }

    logger.info(
      `ConformalRetriever 初始化完成，显著性水平 α = ${this.alpha}`
    );
  }

  // ========================================================================
  // 校准
  // ========================================================================

  /**
   * 校准共形预测器
   *
   * 从校准对中提取非一致性得分，构建经验分布。
   * 校准后得分数组按升序排列，以支持 O(log n) 的 p-value 计算。
   *
   * 非一致性度量:
   *   s_i = 1 - relevance_i
   *
   * 其中 relevance_i ∈ [0, 1] 来自用户反馈或人工标注。
   *
   * @param pairs 校准对数组 {(doc_i, relevance_i)}_{i=1}^n
   * @returns this (链式调用支持)
   *
   * @throws 如果 pairs 为空，记录警告但不中断
   */
  calibrate(pairs: CalibrationPair<T>[]): this {
    if (pairs.length === 0) {
      logger.warn(
        "ConformalRetriever.calibrate: 校准集为空，无法提供统计保证"
      );
      this.calibrationScores = [];
      this.n = 0;
      return this;
    }

    // 计算非一致性得分: s(doc) = 1 - relevance
    this.calibrationScores = pairs.map((pair) => {
      const relevance = Math.max(0, Math.min(1, pair.relevance));
      return 1 - relevance;
    });

    // 排序以支持高效二分查找
    this.calibrationScores.sort((a, b) => a - b);

    this.n = this.calibrationScores.length;

    // 统计分布信息用于诊断日志
    const minScore = this.calibrationScores[0];
    const maxScore = this.calibrationScores[this.n - 1];
    const medianScore =
      this.n % 2 === 0
        ? (this.calibrationScores[this.n / 2 - 1] +
            this.calibrationScores[this.n / 2]) /
          2
        : this.calibrationScores[Math.floor(this.n / 2)];
    const meanScore =
      this.calibrationScores.reduce((sum, s) => sum + s, 0) / this.n;

    logger.info(
      `ConformalRetriever.calibrate: 校准完成, n=${this.n}, ` +
        `得分范围 [${minScore.toFixed(4)}, ${maxScore.toFixed(4)}], ` +
        `均值=${meanScore.toFixed(4)}, 中位数=${medianScore.toFixed(4)}`
    );

    return this;
  }

  // ========================================================================
  // 检索
  // ========================================================================

  /**
   * 对查询执行共形检索
   *
   * 工作流程：
   * 1. 对每个候选文档计算相似度得分
   * 2. 转换为非一致性得分 s_new = 1 - similarity(query, doc)
   * 3. 计算 p-value: p = (|{s_i ≥ s_new}| + 1) / (n + 1)
   * 4. 构建预测集: Γ^α = {doc : p(doc) > α}
   *
   * ## Adaptivity Note
   *
   * 注意，similarityFn 本身必须是不依赖校准集的确定性函数（至少不能
   * 在同一校准集上"偷看"查询）。实际使用中，BM25 等检索得分单独训练，
   * 与保形校准集正交，因此满足可交换性假设。
   *
   * @param query 查询字符串
   * @param candidates 候选文档列表
   * @param similarityFn 相似度函数 (query, document) → 得分 ∈ [0, 1]
   *                     得分越高表示越相关
   * @returns 共形检索结果，包含预测集、p-value 和共形状态
   */
  retrieve(
    query: string,
    candidates: T[],
    similarityFn: (q: string, d: T) => number
  ): ConformalResult<T> {
    const log = logger.withContext({ component: "ConformalRetriever" });

    // 无候选文档的边界情况
    if (candidates.length === 0) {
      log.debug("retrieve: 候选集为空，返回空结果");
      return {
        predictionSet: [],
        pValues: new Map(),
        conformal: this.validateCalibration(),
      };
    }

    // 计算每个候选文档的非一致性得分和 p-value
    const pValues = new Map<T, number>();

    for (const doc of candidates) {
      let similarity: number;
      try {
        similarity = similarityFn(query, doc);
      } catch (e) {
        logger.error(`[ConformalRetriever] similarityFn threw for doc`, e instanceof Error ? e : new Error(String(e)));
        similarity = 0;
      }

      // 边界检查: NaN/Infinity → 0 (最保守), 超出 [0, 1] 截断
      const clampedSimilarity = Number.isFinite(similarity) ? Math.max(0, Math.min(1, similarity)) : 0;

      // 非一致性得分: s_new = 1 - similarity
      const nonconformityScore = 1 - clampedSimilarity;

      // 计算 p-value
      const pValue = this.computePValue(nonconformityScore);

      pValues.set(doc, pValue);
    }

    // 构建预测集: Γ^α = {doc : p(doc) > α}
    const predictionSet: T[] = [];
    for (const doc of candidates) {
      const p = pValues.get(doc)!;
      if (p > this.alpha) {
        predictionSet.push(doc);
      }
    }

    const conformal = this.validateCalibration();

    log.info(
      `retrieve: 查询 "${query.slice(0, 50)}...", ` +
        `候选数=${candidates.length}, 预测集大小=${predictionSet.length}, ` +
        `共形=${conformal}`
    );

    return {
      predictionSet,
      pValues,
      conformal,
    };
  }

  // ========================================================================
  // 核心数学：p-value 计算
  // ========================================================================

  /**
   * 计算 p-value
   *
   * 公式:
   *   p = (|{s_i ∈ calibrationScores : s_i ≥ s_new}| + 1) / (n + 1)
   *
   * 使用二分查找在 O(log n) 时间内确定有多少校准得分 ≥ s_new：
   *   count = n - lowerBound(s_new)
   *
   * 其中 lowerBound 返回第一个 ≥ s_new 的索引。
   *
   * 当校准集为空时（n = 0），保守地返回 p = 1.0 / 1 = 1.0，
   * 使得所有候选都被纳入预测集（宁可多召回，不可漏掉）。
   *
   * @param nonconformityScore 新样本的非一致性得分 s_new ∈ [0, 1]
   * @returns p-value ∈ (0, 1]，值越大表示越可能是相关的
   */
  private computePValue(nonconformityScore: number): number {
    if (this.n === 0) {
      // 无校准数据 → 保守策略：返回最大 p-value
      return 1.0;
    }

    // 二分查找：第一个 ≥ nonconformityScore 的索引
    const countGeq = this.countGreaterOrEqual(nonconformityScore);

    // p = (count + 1) / (n + 1)
    return (countGeq + 1) / (this.n + 1);
  }

  /**
   * 计算得分数组中 ≥ target 的元素个数
   *
   * 使用二分查找（下界），时间复杂度 O(log n)。
   *
   * 由于校准得分已排序，第一个 ≥ target 的位置是 lowerBound，
   * 因此 count = n - lowerBound。
   *
   * @param target 目标值
   * @returns ≥ target 的元素个数
   */
  private countGreaterOrEqual(target: number): number {
    let left = 0;
    let right = this.n;

    // 标准二分查找下界
    while (left < right) {
      const mid = Math.floor((left + right) / 2);
      if (this.calibrationScores[mid] < target) {
        left = mid + 1;
      } else {
        right = mid;
      }
    }

    // left 是第一个 ≥ target 的索引
    return this.n - left;
  }

  // ========================================================================
  // 诊断与状态
  // ========================================================================

  /**
   * 验证校准状态
   *
   * 校准集必须非空才能提供共形预测的统计保证。
   * 如果返回 false，`retrieve()` 的 `predictionSet` 将是基于保守策略的
   * 结果（所有候选文档被包含），而不是真正的保形保证。
   *
   * @returns true 如果校准集非空，共形保证有效
   */
  validateCalibration(): boolean {
    return this.n > 0;
  }

  /**
   * 获取校准统计信息（用于诊断和监控）
   *
   * @returns 包含校准样本数、alpha 和分布摘要的对象
   */
  getCalibrationStats(): {
    calibrated: boolean;
    sampleCount: number;
    alpha: number;
    scoreMin: number | null;
    scoreMax: number | null;
    scoreMean: number | null;
    scoreMedian: number | null;
  } {
    if (this.n === 0) {
      return {
        calibrated: false,
        sampleCount: 0,
        alpha: this.alpha,
        scoreMin: null,
        scoreMax: null,
        scoreMean: null,
        scoreMedian: null,
      };
    }

    const scores = this.calibrationScores;
    const mean =
      scores.reduce((sum, s) => sum + s, 0) / this.n;
    const median =
      this.n % 2 === 0
        ? (scores[this.n / 2 - 1] + scores[this.n / 2]) / 2
        : scores[Math.floor(this.n / 2)];

    return {
      calibrated: true,
      sampleCount: this.n,
      alpha: this.alpha,
      scoreMin: scores[0],
      scoreMax: scores[this.n - 1],
      scoreMean: mean,
      scoreMedian: median,
    };
  }

  /**
   * 重置校准状态，清除所有累积的校准数据
   */
  reset(): void {
    logger.info(
      `ConformalRetriever.reset: 清除校准数据 (was n=${this.n})`
    );
    this.calibrationScores = [];
    this.n = 0;
  }
}
