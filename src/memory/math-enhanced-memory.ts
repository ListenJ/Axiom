/**
 * MathEnhancedMemory — 数学增强记忆管线
 *
 * 将 VIBCompressor (信息瓶颈压缩)、ConformalRetriever (共形检索)
 * 和 ConformalHallucinationDetector (共形幻觉检测) 整合为统一的
 * 记忆处理管线，提供具备统计保证的端到端记忆管理。
 *
 * ## 管线流程
 *
 *   remember(items)
 *     └─ VIBCompressor.compress() → 按惊异度保留 Top-K
 *     └─ 存储到内部记忆库
 *     └─ 返回 CompressionStats
 *
 *   search(query)
 *     └─ DeterministicSearchEngine.search() → 候选集
 *     └─ ConformalRetriever.retrieve() → 共形预测集
 *     └─ 返回 ConformalResult<VaultNote>
 *
 *   verify(statement)
 *     └─ ConformalHallucinationDetector.verify() → HallucinationVerdict
 *
 *   processContent(content, source)
 *     └─ 创建 MemoryItem → remember() → verify()
 *     └─ 返回完整的管线结果
 */

import { logger } from "../utils/logger.js";
import { DeterministicSearchEngine, type SearchResult, type VaultNote } from "./deterministic-search.js";
import {
  VIBCompressor,
  type MemoryItem,
  type CompressedResult,
  type CompressionStats,
  type VIBConfig,
} from "./vib-compressor.js";
import {
  ConformalRetriever,
  type ConformalResult,
  type ConformalRetrieverConfig,
  type CalibrationPair as RetrieverCalibrationPair,
} from "./conformal-retriever.js";
import {
  ConformalHallucinationDetector,
  type FactEntry,
  type HallucinationVerdict,
  type HallucinationDetectorConfig,
  type CalibrationPair as HallucinationCalibrationPair,
} from "./hallucination-detector.js";

// ============================================================================
// 类型定义
// ============================================================================

/** MathEnhancedMemory 配置 */
export interface MathEnhancedMemoryConfig {
  /** Vault 路径（用于 DeterministicSearchEngine） */
  vaultPath: string;
  /** VIB 压缩器配置 */
  vibConfig?: VIBConfig;
  /** 共形检索器配置 */
  conformalConfig?: ConformalRetrieverConfig;
  /** 幻觉检测器配置 */
  hallucinationConfig?: HallucinationDetectorConfig;
}

/** processContent 的完整管线结果 */
export interface ProcessContentResult {
  /** 压缩结果 */
  compression: CompressedResult;
  /** 幻觉检测结果 */
  hallucination: HallucinationVerdict;
  /** 是否被保留（未被 VIB 丢弃） */
  wasRetained: boolean;
  /** 处理耗时 (ms) */
  processingTimeMs: number;
}

/** 记忆统计快照 */
export interface MemoryPipelineStats {
  /** VIB 压缩器状态 */
  compressor: {
    beta: number;
    capacity: number;
    existingMemoryCount: number;
    modelBuilt: boolean;
  };
  /** 检索器状态 */
  retriever: {
    alpha: number;
    calibrated: boolean;
    calibrationSize: number;
  };
  /** 幻觉检测器状态 */
  hallucinationDetector: {
    alpha: number;
    factBaseSize: number;
    calibrated: boolean;
    calibrationSize: number;
  };
  /** 搜索引擎状态 */
  searchEngine: ReturnType<DeterministicSearchEngine["stats"]>;
  /** 内部记忆库大小 */
  totalMemoriesStored: number;
}

// ============================================================================
// MathEnhancedMemory 实现
// ============================================================================

/**
 * 数学增强记忆管线
 *
 * 整合三大数学模块，提供端到端的记忆压缩、检索和幻觉检测。
 *
 * 使用示例:
 * ```typescript
 * const mem = new MathEnhancedMemory({
 *   vaultPath: "./my-vault",
 *   vibConfig: { beta: 1.2, capacity: 50 },
 *   conformalConfig: { alpha: 0.1 },
 *   hallucinationConfig: { alpha: 0.05 },
 * });
 *
 * // 记忆
 * const result = await mem.remember([
 *   { id: "1", content: "信息", timestamp: Date.now(), source: "user" },
 * ]);
 *
 * // 检索
 * const searchResult = await mem.search("关键词");
 *
 * // 验证
 * const verdict = await mem.verify("陈述");
 *
 * // 完整管线
 * const pipelineResult = await mem.processContent("内容", "user");
 * ```
 */
export class MathEnhancedMemory {
  // ===================== 子模块 =====================
  private readonly compressor: VIBCompressor;
  private readonly searchEngine: DeterministicSearchEngine;
  private readonly retriever: ConformalRetriever<VaultNote>;
  private readonly hallucinationDetector: ConformalHallucinationDetector;

  // ===================== 内部状态 =====================
  /** 内部记忆库：存储所有通过 VIB 压缩后保留的记忆 */
  private memoryStore: MemoryItem[] = [];
  /** 配置快照 */
  private readonly config: MathEnhancedMemoryConfig;

  constructor(config: MathEnhancedMemoryConfig) {
    this.config = config;

    // 初始化 VIB 压缩器
    this.compressor = new VIBCompressor({
      beta: config.vibConfig?.beta,
      capacity: config.vibConfig?.capacity,
      maxNgramOrder: config.vibConfig?.maxNgramOrder,
      smoothingK: config.vibConfig?.smoothingK,
      existingMemory: config.vibConfig?.existingMemory,
    });

    // 初始化确定性搜索引擎
    this.searchEngine = new DeterministicSearchEngine(config.vaultPath);

    // 初始化共形检索器
    this.retriever = new ConformalRetriever<VaultNote>({
      alpha: config.conformalConfig?.alpha,
    });

    // 初始化幻觉检测器
    this.hallucinationDetector = new ConformalHallucinationDetector({
      alpha: config.hallucinationConfig?.alpha,
      factBase: config.hallucinationConfig?.factBase,
      minTokenOverlap: config.hallucinationConfig?.minTokenOverlap,
    });

    logger.info("MathEnhancedMemory 初始化完成", {
      vaultPath: config.vaultPath,
      conformalAlpha: config.conformalConfig?.alpha ?? 0.1,
      hallucinationAlpha: config.hallucinationConfig?.alpha ?? 0.05,
    } as Record<string, unknown>);
  }

  // ========================================================================
  // 核心管线方法
  // ========================================================================

  /**
   * 记忆 — 压缩 + 存储
   *
   * 流程:
   *   1. 通过 VIBCompressor 计算每条记忆的惊异度
   *   2. 按有效分数 (surprisal^beta) 排序
   *   3. 保留 Top-K (capacity) 条
   *   4. 将保留的记忆存入内部记忆库
   *
   * @param items 待记忆的条目列表
   * @returns 压缩统计信息
   */
  async remember(items: MemoryItem[]): Promise<CompressionStats> {
    if (items.length === 0) {
      logger.debug("remember: 输入为空，跳过");
      return {
        totalInput: 0,
        totalRetained: 0,
        totalDiscarded: 0,
        capacity: this.config.vibConfig?.capacity ?? 100,
        beta: this.config.vibConfig?.beta ?? 1.0,
        avgSurprisal: 0,
        avgRetainedSurprisal: 0,
        avgDiscardedSurprisal: 0,
        surprisalThreshold: Infinity,
        processingTimeMs: 0,
      };
    }

    logger.info("remember: 处理 " + items.length + " 条记忆");

    const result: CompressedResult = await this.compressor.compress(items);

    // 将保留的记忆加入内部记忆库（去重：相同 id 覆盖）
    const retainedIds = new Set(result.retained.map(function(m) { return m.id; }));
    this.memoryStore = this.memoryStore.filter(function(m) {
      return !retainedIds.has(m.id);
    }).concat(result.retained);

    logger.info(
      "remember: 完成 — 保留 " + result.stats.totalRetained +
      ", 丢弃 " + result.stats.totalDiscarded +
      ", 库存总计 " + this.memoryStore.length
    );

    return result.stats;
  }

  /**
   * 搜索 — 确定性检索 + 共形预测包装
   *
   * 流程:
   *   1. 使用 DeterministicSearchEngine 执行关键词搜索
   *   2. 将候选结果送入 ConformalRetriever
   *   3. 返回带有统计保证的共形预测集
   *
   * 注意：ConformalRetriever 需要先 calibrate() 才能提供统计保证。
   *       否则，predictionSet 将包含所有候选（保守策略）。
   *
   * @param query 查询字符串
   * @param limit 最大候选数（默认 20）
   * @returns 共形检索结果
   */
  async search(
    query: string,
    limit?: number,
  ): Promise<ConformalResult<VaultNote>> {
    logger.info("search: \"" + query.slice(0, 60) + "\"");

    // Step 1: 确定性搜索获取候选集
    const searchResults: SearchResult[] = this.searchEngine.search(query, {
      limit: limit ?? 20,
      includeReasons: true,
    });

    const candidates: VaultNote[] = searchResults.map(function(r) { return r.note; });

    logger.debug(
      "search: 确定性搜索返回 " + candidates.length + " 个候选"
    );

    // Step 2: 共形检索 — 定义相似度函数 (基于搜索得分归一化)
    const maxScore = searchResults.length > 0
      ? Math.max.apply(null, searchResults.map(function(r) { return r.score; }))
      : 1;

    const similarityFn = function(_q: string, doc: VaultNote): number {
      const found = searchResults.find(function(r) { return r.note.path === doc.path; });
      if (!found) return 0;
      return maxScore > 0 ? Math.min(found.score / maxScore, 1) : 0;
    };

    const conformalResult = this.retriever.retrieve(
      query,
      candidates,
      similarityFn,
    );

    logger.info(
      "search: 共形预测集大小 " + conformalResult.predictionSet.length +
      ", 共形=" + conformalResult.conformal
    );

    return conformalResult;
  }

  /**
   * 验证 — 幻觉检测
   *
   * 对陈述进行事实核查，基于共形预测判断是否为幻觉。
   *
   * @param statement 待验证的陈述
   * @param context 可选的上下文（用于辅助判断）
   * @returns 幻觉判定结果
   */
  async verify(statement: string, context?: string): Promise<HallucinationVerdict> {
    logger.info("verify: \"" + statement.slice(0, 60) + "\"");

    const verdict = this.hallucinationDetector.verify(statement, context);

    logger.info(
      "verify: isHallucination=" + verdict.isHallucination +
      ", pValue=" + verdict.pValue.toFixed(4) +
      ", confidence=" + verdict.confidence.toFixed(4)
    );

    return verdict;
  }

  /**
   * 内容处理 — 完整管线: 压缩 + 存储 + 验证
   *
   * 将原始内容转换为记忆条目，通过 VIB 压缩决定是否保留，
   * 然后对内容进行幻觉检测。
   *
   * @param content 原始文本内容
   * @param source 内容来源 (如 "user", "system", "tool")
   * @returns 完整管线结果
   */
  async processContent(
    content: string,
    source: string,
  ): Promise<ProcessContentResult> {
    const startTime = Date.now();

    logger.info("processContent: 来源=\"" + source + "\", 长度=" + content.length);

    // Step 1: 创建 MemoryItem
    const item: MemoryItem = {
      id: "mem_" + Date.now() + "_" + Math.random().toString(36).slice(2, 9),
      content: content,
      timestamp: Date.now(),
      source: source,
    };

    // Step 2: 压缩 + 存储
    const compressionStats = await this.remember([item]);

    // 判断是否被保留
    const wasRetained = compressionStats.totalRetained > 0;

    // Step 3: 幻觉检测
    const hallucination = await this.verify(content);

    const processingTimeMs = Date.now() - startTime;

    logger.info(
      "processContent: 完成 — " +
      "retained=" + wasRetained +
      ", hallucination=" + hallucination.isHallucination +
      ", 耗时=" + processingTimeMs + "ms"
    );

    // 构造完整的管线压缩结果
    const compression: CompressedResult = {
      retained: wasRetained ? [item] : [],
      discarded: wasRetained ? [] : [item],
      stats: compressionStats,
    };

    return {
      compression: compression,
      hallucination: hallucination,
      wasRetained: wasRetained,
      processingTimeMs: processingTimeMs,
    };
  }

  // ========================================================================
  // 校准方法
  // ========================================================================

  /**
   * 校准共形检索器
   *
   * 提供校准对以训练共形预测模型。校准后，search() 的
   * predictionSet 将具有 alpha-level 的统计保证。
   *
   * @param pairs 校准对数组
   */
  calibrateRetriever(pairs: RetrieverCalibrationPair<VaultNote>[]): void {
    logger.info("calibrateRetriever: " + pairs.length + " 对");
    this.retriever.calibrate(pairs);
  }

  /**
   * 校准幻觉检测器
   *
   * @param pairs 校准对数组
   */
  calibrateHallucinationDetector(pairs: HallucinationCalibrationPair[]): void {
    logger.info("calibrateHallucinationDetector: " + pairs.length + " 对");
    this.hallucinationDetector.calibrate(pairs);
  }

  /**
   * 设置幻觉检测器的事实库
   *
   * @param facts 事实条目列表
   */
  setFactBase(facts: FactEntry[]): void {
    logger.info("setFactBase: " + facts.length + " 条事实");
    this.hallucinationDetector.setFactBase(facts);
  }

  /**
   * 向事实库添加事实
   *
   * @param fact 事实条目
   */
  addFact(fact: FactEntry): void {
    this.hallucinationDetector.addFact(fact);
  }

  /**
   * 批量添加事实
   *
   * @param facts 事实条目列表
   */
  addFacts(facts: FactEntry[]): void {
    this.hallucinationDetector.addFacts(facts);
  }

  // ========================================================================
  // 统计与诊断
  // ========================================================================

  /**
   * 获取记忆管线的完整统计信息
   *
   * @returns 包含所有子模块状态的统计快照
   */
  getStats(): MemoryPipelineStats {
    const retrieverCalStats = this.retriever.getCalibrationStats();
    const hallucinationDiag = this.hallucinationDetector.getDiagnostics();

    return {
      compressor: {
        beta: this.config.vibConfig?.beta ?? 1.0,
        capacity: this.config.vibConfig?.capacity ?? 100,
        existingMemoryCount: (this.config.vibConfig?.existingMemory ?? []).length,
        modelBuilt: (this.config.vibConfig?.existingMemory ?? []).length > 0,
      },
      retriever: {
        alpha: retrieverCalStats.alpha,
        calibrated: retrieverCalStats.calibrated,
        calibrationSize: retrieverCalStats.sampleCount,
      },
      hallucinationDetector: {
        alpha: hallucinationDiag.alpha,
        factBaseSize: hallucinationDiag.factBaseSize,
        calibrated: hallucinationDiag.calibrated,
        calibrationSize: hallucinationDiag.calibrationN,
      },
      searchEngine: this.searchEngine.stats(),
      totalMemoriesStored: this.memoryStore.length,
    };
  }

  /**
   * 获取当前存储的所有记忆
   */
  get memories(): MemoryItem[] {
    return this.memoryStore.slice();
  }

  /**
   * 获取内部搜索引擎实例（供高级用法）
   */
  get engine(): DeterministicSearchEngine {
    return this.searchEngine;
  }

  /**
   * 获取 VIB 压缩器实例（供高级用法）
   */
  get vibCompressor(): VIBCompressor {
    return this.compressor;
  }

  /**
   * 获取共形检索器实例（供高级用法）
   */
  get conformalRetriever(): ConformalRetriever<VaultNote> {
    return this.retriever;
  }

  /**
   * 获取幻觉检测器实例（供高级用法）
   */
  get hallucinationDetectorInstance(): ConformalHallucinationDetector {
    return this.hallucinationDetector;
  }

  /**
   * 清空内部记忆库（不重置外部模块状态）
   */
  clearMemories(): void {
    const count = this.memoryStore.length;
    this.memoryStore = [];
    logger.info("clearMemories: 清空 " + count + " 条记忆");
  }

  /**
   * 重置所有校准状态
   */
  resetCalibration(): void {
    this.retriever.reset();
    this.hallucinationDetector.resetCalibration();
    logger.info("resetCalibration: 已重置检索器和幻觉检测器的校准状态");
  }
}

export default MathEnhancedMemory;
