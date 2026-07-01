/**
 * VIB-Mem: Variational Information Bottleneck Memory Compressor
 * (变分信息瓶颈记忆压缩器)
 *
 * ============================= 数学原理 =============================
 *
 * 1. 信息瓶颈 (Information Bottleneck, IB) 目标函数:
 *
 *    min  I(X; Z) - beta * I(Z; Y)
 *     Z
 *
 *    其中:
 *      X : 原始记忆内容（高维、冗余）
 *      Z : 压缩后的表征（低维、精炼）
 *      Y : 下游任务的相关性信号
 *      I(.;.) : 互信息 (Mutual Information)
 *      beta : Lagrange 乘子，控制压缩-保留的权衡
 *
 *    直观解释:
 *      - I(X; Z) 越小 => Z 越压缩，丢弃了 X 中更多信息
 *      - I(Z; Y) 越大 => Z 越能保留与任务 Y 相关的信息
 *      - beta 越大 => 更强调保留任务相关信息，压缩更保守
 *      - beta -> 0  => 极限压缩，只保留最小充分统计量
 *      - beta -> inf => 不压缩，保留所有信息
 *
 * 2. 变分近似 (Variational Approximation):
 *
 *    直接优化 I(X;Z) 和 I(Z;Y) 需要计算真实分布 p(z|x) 和 p(y|z)，
 *    这是困难的。我们采用变分推断，引入参数化近似:
 *      - 编码器 q(z|x): 压缩映射
 *      - 解码器 p(y|z): 任务预测器
 *
 *    在实际系统中，我们无法对每条记忆运行完整的变分推断。
 *    因此引入基于惊异度 (Surprisal) 的工程近似。
 *
 * 3. 惊异度 (Surprisal):
 *
 *    信息论中，事件 x 的惊异度定义为:
 *
 *      S(x) = -log P(x)
 *
 *    其中 P(x) 是事件 x 在给定上下文/已有知识下的概率。
 *
 *    - 高惊异度 (surprisal 大) => 事件罕见、新颖 => 信息量大 => 应保留
 *    - 低惊异度 (surprisal 小) => 事件可预测、冗余 => 信息量小 => 可丢弃
 *
 * 4. 序列惊异度 (Token-level Surprisal):
 *
 *    一段文本 content = (w1, w2, ..., wT) 的总惊异度为:
 *
 *      S(content) = - sum_t log P(w_t | w1, ..., w_{t-1}, context)
 *                 ~ - sum_t log P(w_t | w_{t-n+1}, ..., w_{t-1}, context)
 *
 *    其中第二个等式使用了 n-阶马尔可夫假设 (n-gram 模型)。
 *
 * 5. 保留分数 (Retention Score):
 *
 *    对于每条记忆 m:
 *      retention_score(m) = S(m.content | existing_knowledge)
 *                         = - sum_t log P(token_t | context_ngrams)
 *
 *    然后按分数降序排列，保留 Top-K 条记忆。
 *
 * 6. n-gram 概率估计:
 *
 *    使用 Backoff + Add-k 平滑:
 *
 *    P(w_t | w_{t-n+1}^{t-1}) =
 *      (count(w_{t-n+1}^t) + k) / (count(w_{t-n+1}^{t-1}) + k * V)
 *
 *    如果 n-gram 不存在，回退到 (n-1)-gram，直到 unigram。
 *    其中 k 是平滑参数 (默认 0.01)，V 是词汇表大小。
 *
 * ============================= 使用示例 =============================
 *
 *   const compressor = new VIBCompressor({
 *     beta: 1.5,
 *     capacity: 50,
 *     existingMemory: ["已知事实A", "已知事实B"],
 *   });
 *
 *   const result = await compressor.compress(newMemories);
 *   console.log(result.retained);
 *   console.log(result.discarded);
 *   console.log(result.stats);
 */

import { logger } from "../utils/logger.js";

// ============================= 类型定义 =============================

/** 单条记忆项 */
export interface MemoryItem {
  /** 唯一标识符 */
  id: string;
  /** 记忆内容（文本） */
  content: string;
  /** 创建时间戳 (Unix ms) */
  timestamp: number;
  /** 记忆来源 (如 "user", "system", "tool", "observation") */
  source: string;
}

/** 压缩结果 */
export interface CompressedResult {
  /** 保留的记忆列表（按保留分数降序排列） */
  retained: MemoryItem[];
  /** 丢弃的记忆列表 */
  discarded: MemoryItem[];
  /** 压缩统计信息 */
  stats: CompressionStats;
}

/** 压缩统计 */
export interface CompressionStats {
  /** 输入记忆总数 */
  totalInput: number;
  /** 保留的记忆数 */
  totalRetained: number;
  /** 丢弃的记忆数 */
  totalDiscarded: number;
  /** 容量上限 */
  capacity: number;
  /** beta 值 */
  beta: number;
  /** 平均惊异度 (nats) */
  avgSurprisal: number;
  /** 保留记忆的平均惊异度 */
  avgRetainedSurprisal: number;
  /** 丢弃记忆的平均惊异度 */
  avgDiscardedSurprisal: number;
  /** 惊异度阈值 (保留/丢弃分界) */
  surprisalThreshold: number;
  /** 处理耗时 (ms) */
  processingTimeMs: number;
}

/** VIB 压缩器配置 */
export interface VIBConfig {
  /**
   * 压缩-保留权衡参数
   * - beta > 1: 更倾向保留新颖信息（高惊异度），压缩更保守
   * - beta = 1: 平衡模式（默认）
   * - beta < 1: 更激进的压缩，容忍丢弃更多信息
   */
  beta?: number;
  /** 最大保留记忆数 (容量上限)，默认 100 */
  capacity?: number;
  /** 已有记忆内容列表，用于构建 n-gram 背景模型 */
  existingMemory?: string[];
  /** n-gram 最大阶数，默认 3 (trigram) */
  maxNgramOrder?: number;
  /** Add-k 平滑参数，默认 0.01 */
  smoothingK?: number;
}

// ============================= 内部类型 =============================

type NgramCounts = Map<string, number>;

interface ScoredMemory {
  memory: MemoryItem;
  surprisal: number;
  effectiveScore: number;
}

// ============================= 主类 =============================

/**
 * VIB-Mem 变分信息瓶颈记忆压缩器
 *
 * 使用基于惊异度 (Surprisal) 的信息论方法来评估每条记忆的
 * "信息新颖性"，并据此决定保留或丢弃。
 */
export class VIBCompressor {
  private readonly beta: number;
  private readonly capacity: number;
  private readonly existingMemory: string[];
  private readonly maxNgramOrder: number;
  private readonly smoothingK: number;

  /** 从已有记忆中构建的 n-gram 模型缓存 */
  private ngramModel: {
    counts: Map<number, NgramCounts>;
    totalTokens: number;
    vocabSize: number;
    builtAt: number;
  } | null = null;

  constructor(config: VIBConfig = {}) {
    this.beta = config.beta ?? 1.0;
    this.capacity = config.capacity ?? 100;
    this.existingMemory = config.existingMemory ?? [];
    this.maxNgramOrder = config.maxNgramOrder ?? 3;
    this.smoothingK = config.smoothingK ?? 0.01;

    logger.debug("VIBCompressor 初始化", {
      beta: this.beta,
      capacity: this.capacity,
      existingMemoryCount: this.existingMemory.length,
      maxNgramOrder: this.maxNgramOrder,
      smoothingK: this.smoothingK,
    });

    if (this.existingMemory.length > 0) {
      this.buildNgramModel();
    }
  }

  // ======================= 公共方法 =======================

  /**
   * 压缩记忆列表
   *
   * 处理流程:
   *   1. 对每条记忆计算惊异度 (surprisal)
   *   2. 应用 beta 缩放: effective_score = surprisal^beta
   *   3. 按分数降序排序
   *   4. 选 Top-K (capacity) 条保留
   */
  async compress(memories: MemoryItem[]): Promise<CompressedResult> {
    const startTime = Date.now();

    logger.info("开始压缩 " + memories.length + " 条记忆", {
      capacity: this.capacity,
      beta: this.beta,
    });

    if (!this.ngramModel && this.existingMemory.length > 0) {
      this.buildNgramModel();
    }

    const context = this.existingMemory;

    // 计算每条记忆的惊异度并应用 beta 缩放
    const scored: ScoredMemory[] = [];
    for (const memory of memories) {
      const surprisal = this.estimateSurprisal(memory.content, context);
      const effectiveScore = Math.pow(Math.max(surprisal, 1e-10), this.beta);
      scored.push({ memory, surprisal, effectiveScore });
    }

    // 按有效分数降序排序
    scored.sort((a, b) => b.effectiveScore - a.effectiveScore);

    // 选 Top-K
    const retained = scored.slice(0, this.capacity);
    const discarded = scored.slice(this.capacity);

    // 计算统计
    const avg = (arr: number[]) =>
      arr.length > 0 ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;

    const allSurprisals = scored.map((s) => s.surprisal);
    const retainedSurprisals = retained.map((s) => s.surprisal);
    const discardedSurprisals = discarded.map((s) => s.surprisal);

    const surprisalThreshold =
      retained.length > 0
        ? retained[retained.length - 1].surprisal
        : Infinity;

    const stats: CompressionStats = {
      totalInput: memories.length,
      totalRetained: retained.length,
      totalDiscarded: discarded.length,
      capacity: this.capacity,
      beta: this.beta,
      avgSurprisal: Math.round(avg(allSurprisals) * 1000) / 1000,
      avgRetainedSurprisal: Math.round(avg(retainedSurprisals) * 1000) / 1000,
      avgDiscardedSurprisal: Math.round(avg(discardedSurprisals) * 1000) / 1000,
      surprisalThreshold: Math.round(surprisalThreshold * 1000) / 1000,
      processingTimeMs: Date.now() - startTime,
    };

    logger.info("压缩完成", stats);

    return {
      retained: retained.map((s) => s.memory),
      discarded: discarded.map((s) => s.memory),
      stats,
    };
  }

  /**
   * 估算文本内容的惊异度 (Surprisal)
   *
   * S(content) = - sum_t log P(w_t | w_{t-n+1}, ..., w_{t-1}, context)
   *
   * @param content 待评估的文本内容
   * @param context 背景上下文列表
   * @returns 总惊异度 (单位: nats)
   */
  estimateSurprisal(content: string, context: string[] = []): number {
    const tokens = this.tokenize(content);
    if (tokens.length === 0) return 0;

    let model = this.ngramModel;
    if (context.length > 0 && context !== this.existingMemory) {
      model = this.buildNgramModelFromTexts(context);
    }

    let totalSurprisal = 0;
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i];
      const prefixStart = Math.max(0, i - this.maxNgramOrder + 1);
      const prefix = tokens.slice(prefixStart, i);
      const prob = this.estimateProbability(token, prefix, model);
      totalSurprisal += -Math.log(Math.max(prob, 1e-10));
    }

    return totalSurprisal;
  }

  /**
   * 按保留分数选择 Top-K 条记忆
   */
  selectTopK(memories: MemoryItem[], K?: number): MemoryItem[] {
    const effectiveK = K ?? this.capacity;
    const scored = memories.map((m) => ({
      memory: m,
      score: this.estimateSurprisal(m.content, this.existingMemory),
    }));
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, effectiveK).map((s) => s.memory);
  }

  /**
   * 获取单条记忆的保留分数（原始惊异度）
   */
  getRetentionScore(memory: MemoryItem): number {
    return this.estimateSurprisal(memory.content, this.existingMemory);
  }

  // ======================= 内部方法 =======================

  private buildNgramModel(): void {
    this.ngramModel = this.buildNgramModelFromTexts(this.existingMemory);
    logger.debug("n-gram 模型已构建", {
      vocabSize: this.ngramModel.vocabSize,
      totalTokens: this.ngramModel.totalTokens,
    });
  }

  /**
   * 从文本列表构建 n-gram 频率模型
   */
  private buildNgramModelFromTexts(texts: string[]): {
    counts: Map<number, NgramCounts>;
    totalTokens: number;
    vocabSize: number;
    builtAt: number;
  } {
    const counts = new Map<number, NgramCounts>();
    const allTokens: string[] = [];

    for (let n = 1; n <= this.maxNgramOrder; n++) {
      counts.set(n, new Map());
    }

    for (const text of texts) {
      const tokens = this.tokenize(text);
      allTokens.push(...tokens);

      for (let n = 1; n <= this.maxNgramOrder; n++) {
        const ngramCounts = counts.get(n)!;
        for (let i = 0; i <= tokens.length - n; i++) {
          const ngram = tokens.slice(i, i + n).join(" ");
          ngramCounts.set(ngram, (ngramCounts.get(ngram) ?? 0) + 1);
        }
      }
    }

    const vocabSize = Math.max(new Set(allTokens).size, 1);

    return { counts, totalTokens: allTokens.length, vocabSize, builtAt: Date.now() };
  }

  /**
   * 使用 Backoff + Add-k 平滑估计条件概率
   *
   * P(w_t | w_{t-n+1}, ..., w_{t-1})
   *
   * 从最高阶 n-gram 开始尝试，若上下文不存在则回退到 (n-1)-gram，
   * 最终回退到 unigram。
   */
  private estimateProbability(
    token: string,
    prefix: string[],
    model: {
      counts: Map<number, NgramCounts>;
      totalTokens: number;
      vocabSize: number;
    } | null
  ): number {
    if (!model) return 1.0 / 1000;

    const { counts, totalTokens, vocabSize } = model;

    for (let n = this.maxNgramOrder; n >= 1; n--) {
      const ngramCounts = counts.get(n);
      if (!ngramCounts) continue;

      const contextTokens = prefix.slice(-(n - 1));

      if (n === 1) {
        // Unigram: P(token) = (count + k) / (totalTokens + k * V)
        const tokenCount = ngramCounts.get(token) ?? 0;
        return (tokenCount + this.smoothingK) / (totalTokens + this.smoothingK * vocabSize);
      }

      // n-gram (n >= 2)
      if (contextTokens.length > 0) {
        const fullNgram = [...contextTokens, token].join(" ");
        const contextNgram = contextTokens.join(" ");
        const contextCount = ngramCounts.get(contextNgram) ?? 0;

        if (contextCount > 0) {
          const fullCount = ngramCounts.get(fullNgram) ?? 0;
          return (fullCount + this.smoothingK) / (contextCount + this.smoothingK * vocabSize);
        }
      }
    }

    return 1.0 / Math.max(vocabSize, 1000);
  }

  /**
   * 简单分词器
   *
   * - 按空白字符分割
   * - 将标点符号作为独立 token
   * - 转为小写
   * - 过滤空 token
   */
  private tokenize(text: string): string[] {
    if (!text || text.trim().length === 0) return [];

    const withSpaces = text.replace(
      /([\u3000-\u303F\uFF00-\uFFEF.,!?;:"'\x60()\[\]{}<>\/\\\-])/g,
      " $1 "
    );

    return withSpaces.toLowerCase().split(/\s+/).filter((t) => t.length > 0);
  }
}
