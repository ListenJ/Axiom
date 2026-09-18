/**
 * Rate-Distortion Context Compressor
 * Based on Rate-Distortion Theory for context compression with distortion guarantees.
 *
 * Core Math:
 *   Rate:       R = compressed_tokens / original_tokens
 *   Distortion: D = KL[P_LLM(output|full_context) || P_LLM(output|compressed_context)]
 *   Optimization: min R(D) = min compression rate subject to D <= D_max
 *
 * Progressive Compression:
 *   Layer 1: Drop low-relevance items (relevance < 0.1)
 *   Layer 2: Truncate long items (keep first N sentences)
 *   Layer 3: Merge similar items (Jaccard > 0.7)
 *   After each layer, estimate distortion -> stop if exceeds D_max
 *
 * Distortion estimation (lightweight, no LLM needed):
 *   - Jaccard proxy: distortion ~= 1 - Jaccard(original_summary, compressed_summary)
 *   - Key sentence preservation: fraction of key sentences retained
 */

import { logger } from "../utils/logger.js";

// ================================================================
// Type Definitions
// ================================================================

/** Context item representing an independent content fragment */
export interface ContextItem {
  id: string;
  content: string;
  relevance: number;
  tokens: number;
  metadata?: Record<string, unknown>;
}

/** Compressed context result */
export interface CompressedContext {
  items: ContextItem[];
  rate: number;
  distortion: number;
  stats: CompressionStats;
  appliedLayers: CompressionLayer[];
}

/** Compression statistics */
export interface CompressionStats {
  originalTokens: number;
  compressedTokens: number;
  rate: number;
  estimatedDistortion: number;
  compressionRatio: number;
  droppedItems: number;
  truncatedItems: number;
  mergedItems: number;
}

/** Compression layer identifier */
export type CompressionLayer = "drop-low-relevance" | "truncate-long" | "merge-similar";

/** Rate-Distortion compressor configuration */
export interface RateDistortionConfig {
  maxDistortion: number;
  minRate: number;
  verificationModel?: string;
  lowRelevanceThreshold?: number;
  truncateSentenceCount?: number;
  mergeSimilarityThreshold?: number;
  maxDistortionIncrement?: number;
}

// ================================================================
// Rate-Distortion Compressor
// ================================================================

export class RateDistortionCompressor {
  private readonly config: Required<RateDistortionConfig>;

  constructor(config: Partial<RateDistortionConfig> = {}) {
    this.config = {
      maxDistortion: config.maxDistortion ?? 0.15,
      minRate: config.minRate ?? 0.5,
      verificationModel: config.verificationModel ?? "",
      lowRelevanceThreshold: config.lowRelevanceThreshold ?? 0.1,
      truncateSentenceCount: config.truncateSentenceCount ?? 3,
      mergeSimilarityThreshold: config.mergeSimilarityThreshold ?? 0.7,
      maxDistortionIncrement: config.maxDistortionIncrement ?? 0.05,
    };
  }

  /**
   * Compress context - main entry point.
   * Progressively applies compression layers, estimating distortion at each step.
   */
  async compress(context: ContextItem[]): Promise<CompressedContext> {
    if (context.length === 0) {
      return this.emptyResult();
    }

    const originalTokens = this.totalTokens(context);
    logger.info("[RateDistortion] Starting compression", {
      itemCount: context.length,
      originalTokens,
    });

    let currentItems = [...context];
    let currentDistortion = 0;
    const appliedLayers: CompressionLayer[] = [];
    let droppedItems = 0;
    let truncatedItems = 0;
    let mergedItems = 0;

    const originalSummary = this.buildSummary(context);

    const layers: Array<{
      name: CompressionLayer;
      fn: (items: ContextItem[]) => ContextItem[];
    }> = [
      { name: "drop-low-relevance", fn: (items) => this.dropLowRelevance(items) },
      { name: "truncate-long", fn: (items) => this.truncateLongItems(items) },
      { name: "merge-similar", fn: (items) => this.mergeSimilarItems(items) },
    ];

    for (const layer of layers) {
      const currentRate = this.totalTokens(currentItems) / originalTokens;
      if (currentRate <= this.config.minRate) {
        logger.info("[RateDistortion] Target rate reached, stopping", { rate: currentRate });
        break;
      }

      const beforeCount = currentItems.length;
      const nextItems = layer.fn(currentItems);
      const afterCount = nextItems.length;

      if (beforeCount === afterCount && layer.name !== "truncate-long") {
        continue;
      }

      if (layer.name === "truncate-long") {
        const beforeTokens = this.totalTokens(currentItems);
        const afterTokens = this.totalTokens(nextItems);
        if (afterTokens >= beforeTokens * 0.95) {
          continue;
        }
      }

      const newDistortion = await this.estimateDistortion(
        context,
        nextItems,
        originalSummary
      );

      const distortionIncrement = newDistortion - currentDistortion;

      logger.info("[RateDistortion] Layer evaluation", {
        layer: layer.name,
        distortionIncrement: distortionIncrement.toFixed(4),
        totalDistortion: newDistortion.toFixed(4),
        maxDistortion: this.config.maxDistortion,
      });

      if (newDistortion > this.config.maxDistortion) {
        logger.warn("[RateDistortion] Distortion exceeded threshold", {
          layer: layer.name,
          distortion: newDistortion,
          max: this.config.maxDistortion,
          action: "rolling back",
        });
        break;
      }

      if (distortionIncrement > this.config.maxDistortionIncrement) {
        logger.warn("[RateDistortion] Distortion increment too large", {
          layer: layer.name,
          increment: distortionIncrement,
          max: this.config.maxDistortionIncrement,
          action: "skipping layer",
        });
        continue;
      }

      currentItems = nextItems;
      currentDistortion = newDistortion;
      appliedLayers.push(layer.name);

      if (layer.name === "drop-low-relevance") {
        droppedItems = beforeCount - afterCount;
      } else if (layer.name === "truncate-long") {
        truncatedItems = this.countTruncated(context, currentItems);
      } else if (layer.name === "merge-similar") {
        mergedItems = beforeCount - afterCount;
      }
    }

    const compressedTokens = this.totalTokens(currentItems);
    const rate = compressedTokens / originalTokens;
    const compressionRatio = originalTokens / Math.max(compressedTokens, 1);

    const stats: CompressionStats = {
      originalTokens,
      compressedTokens,
      rate,
      estimatedDistortion: currentDistortion,
      compressionRatio,
      droppedItems,
      truncatedItems,
      mergedItems,
    };

    logger.info("[RateDistortion] Compression complete", {
      originalTokens,
      compressedTokens,
      rate: rate.toFixed(3),
      distortion: currentDistortion.toFixed(4),
      ratio: compressionRatio.toFixed(2),
      layers: appliedLayers,
    });

    return {
      items: currentItems,
      rate,
      distortion: currentDistortion,
      stats,
      appliedLayers,
    };
  }

  /**
   * Estimate distortion between original and compressed contexts.
   * Uses Jaccard proxy + key sentence retention, no LLM needed.
   */
  async estimateDistortion(
    original: ContextItem[],
    compressed: ContextItem[],
    queryOrOriginalSummary?: string
  ): Promise<number> {
    const originalSummary =
      queryOrOriginalSummary || this.buildSummary(original);
    const compressedSummary = this.buildSummary(compressed);

    const jaccardDistortion = this.jaccardDistortion(
      originalSummary,
      compressedSummary
    );

    const keySentenceDistortion = this.keySentenceDistortion(
      original,
      compressed
    );

    const originalTokens = this.totalTokens(original);
    const compressedTokens = this.totalTokens(compressed);
    const tokenRatio = compressedTokens / Math.max(originalTokens, 1);
    const tokenDistortion = Math.max(0, Math.min(1, 1 - tokenRatio));

    const distortion =
      0.5 * jaccardDistortion +
      0.3 * keySentenceDistortion +
      0.2 * tokenDistortion;

    logger.debug("[RateDistortion] Distortion estimate", {
      jaccard: jaccardDistortion.toFixed(4),
      keySentence: keySentenceDistortion.toFixed(4),
      token: tokenDistortion.toFixed(4),
      combined: distortion.toFixed(4),
    });

    return Math.max(0, Math.min(1, distortion));
  }

  /**
   * Progressive compress - apply compression until target distortion is reached.
   */
  async progressiveCompress(
    items: ContextItem[],
    targetDistortion: number
  ): Promise<ContextItem[]> {
    const compressor = new RateDistortionCompressor({
      ...this.config,
      maxDistortion: targetDistortion,
    });

    const result = await compressor.compress(items);
    return result.items;
  }

  // Layer 1: Drop low relevance items
  private dropLowRelevance(items: ContextItem[]): ContextItem[] {
    const threshold = this.config.lowRelevanceThreshold;
    const kept = items.filter((item) => item.relevance >= threshold);
    const dropped = items.length - kept.length;

    logger.debug("[RateDistortion] Layer 1: Drop low relevance", {
      total: items.length,
      kept: kept.length,
      dropped,
      threshold,
    });

    if (kept.length === 0 && items.length > 0) {
      const top = items.reduce((a, b) => (a.relevance > b.relevance ? a : b));
      return [top];
    }

    return kept;
  }

  // Layer 2: Truncate long items
  private truncateLongItems(items: ContextItem[]): ContextItem[] {
    const sentenceCount = this.config.truncateSentenceCount;

    return items.map((item) => {
      const sentences = this.splitSentences(item.content);
      if (sentences.length <= sentenceCount) {
        return item;
      }

      const truncated = sentences.slice(0, sentenceCount).join(" ");
      const truncatedTokens = this.estimateTokens(truncated);

      return {
        ...item,
        content: truncated,
        tokens: truncatedTokens,
        metadata: {
          ...item.metadata,
          truncated: true,
          originalTokens: item.tokens,
          originalSentenceCount: sentences.length,
        },
      };
    });
  }

  // Layer 3: Merge similar items
  private mergeSimilarItems(items: ContextItem[]): ContextItem[] {
    const threshold = this.config.mergeSimilarityThreshold;
    const merged: ContextItem[] = [];
    const used = new Set<string>();

    for (let i = 0; i < items.length; i++) {
      if (used.has(items[i].id)) continue;

      let representative = items[i];
      const similarGroup: ContextItem[] = [items[i]];
      used.add(items[i].id);

      for (let j = i + 1; j < items.length; j++) {
        if (used.has(items[j].id)) continue;

        const similarity = this.jaccardSimilarity(
          items[i].content,
          items[j].content
        );

        if (similarity >= threshold) {
          similarGroup.push(items[j]);
          used.add(items[j].id);
        }
      }

      if (similarGroup.length > 1) {
        representative = similarGroup.reduce((longest, current) =>
          current.content.length > longest.content.length ? current : longest
        );

        representative = {
          ...representative,
          relevance: Math.max(...similarGroup.map((x) => x.relevance)),
          tokens: this.estimateTokens(representative.content),
          metadata: {
            ...representative.metadata,
            merged: true,
            mergedCount: similarGroup.length,
            mergedIds: similarGroup.map((x) => x.id),
          },
        };
      }

      merged.push(representative);
    }

    logger.debug("[RateDistortion] Layer 3: Merge similar", {
      original: items.length,
      merged: merged.length,
      reduction: items.length - merged.length,
      threshold,
    });

    return merged;
  }

  // Distortion estimation methods

  private jaccardDistortion(textA: string, textB: string): number {
    const similarity = this.jaccardSimilarity(textA, textB);
    return 1 - similarity;
  }

  private jaccardSimilarity(textA: string, textB: string): number {
    const tokensA = this.tokenize(textA);
    const tokensB = this.tokenize(textB);

    const setA = new Set(tokensA);
    const setB = new Set(tokensB);
    const intersection1g = new Set([...setA].filter((x) => setB.has(x)));
    const union1g = new Set([...setA, ...setB]);
    const jaccard1g = union1g.size > 0 ? intersection1g.size / union1g.size : 0;

    const bigramsA = this.bigrams(tokensA);
    const bigramsB = this.bigrams(tokensB);
    const bigramSetA = new Set(bigramsA);
    const bigramSetB = new Set(bigramsB);
    const intersection2g = new Set(
      [...bigramSetA].filter((x) => bigramSetB.has(x))
    );
    const union2g = new Set([...bigramSetA, ...bigramSetB]);
    const jaccard2g = union2g.size > 0 ? intersection2g.size / union2g.size : 0;

    return 0.6 * jaccard1g + 0.4 * jaccard2g;
  }

  private keySentenceDistortion(
    original: ContextItem[],
    compressed: ContextItem[]
  ): number {
    const originalKeySentences = this.extractKeySentences(original);
    const compressedKeySentences = this.extractKeySentences(compressed);

    if (originalKeySentences.length === 0) return 0;

    let preserved = 0;
    for (const origKey of originalKeySentences) {
      if (this.hasApproximateMatch(origKey, compressedKeySentences, 0.5)) {
        preserved++;
      }
    }

    return 1 - preserved / originalKeySentences.length;
  }

  // Utility methods

  private totalTokens(items: ContextItem[]): number {
    return items.reduce((sum, item) => sum + item.tokens, 0);
  }

  private estimateTokens(text: string): number {
    const chineseChars = (text.match(/[\u4e00-\u9fff\u3400-\u4dbf]/g) || []).length;
    const otherChars = Math.max(0, text.length - chineseChars);
    return Math.ceil(chineseChars / 1.5 + otherChars / 4);
  }

  private splitSentences(text: string): string[] {
    const sentences = text
      .split(/(?<=[.!?.!?\n])\s*/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    return sentences.length > 0 ? sentences : [text];
  }

  private tokenize(text: string): string[] {
    return text
      .toLowerCase()
      .split(/[\s,.;:!?()\[\]{}"'\u3000-\u303f\uff00-\uffef]+/)
      .filter((t) => t.length > 0);
  }

  private bigrams(tokens: string[]): string[] {
    const result: string[] = [];
    for (let i = 0; i < tokens.length - 1; i++) {
      result.push(tokens[i] + "|" + tokens[i + 1]);
    }
    return result;
  }

  private extractKeySentences(items: ContextItem[]): string[] {
    const keySentences: string[] = [];
    for (const item of items) {
      const sentences = this.splitSentences(item.content);
      if (sentences.length > 0) {
        keySentences.push(sentences[0]);
        if (sentences.length > 1) {
          keySentences.push(sentences[sentences.length - 1]);
        }
      }
    }
    return keySentences;
  }

  private hasApproximateMatch(
    target: string,
    candidates: string[],
    threshold: number
  ): boolean {
    return candidates.some(
      (candidate) => this.jaccardSimilarity(target, candidate) >= threshold
    );
  }

  private buildSummary(items: ContextItem[]): string {
    return items.map((item) => item.content.slice(0, 200)).join("\n");
  }

  private countTruncated(
    original: ContextItem[],
    compressed: ContextItem[]
  ): number {
    let count = 0;
    const compressedMap = new Map(compressed.map((c) => [c.id, c]));

    for (const orig of original) {
      const comp = compressedMap.get(orig.id);
      if (comp && comp.content.length < orig.content.length) {
        count++;
      }
    }

    return count;
  }

  private emptyResult(): CompressedContext {
    return {
      items: [],
      rate: 0,
      distortion: 0,
      stats: {
        originalTokens: 0,
        compressedTokens: 0,
        rate: 0,
        estimatedDistortion: 0,
        compressionRatio: 1,
        droppedItems: 0,
        truncatedItems: 0,
        mergedItems: 0,
      },
      appliedLayers: [],
    };
  }
}

// ================================================================
// Convenience Functions
// ================================================================

/**
 * Quick context compression with default config.
 */
export async function compressContext(
  items: ContextItem[],
  options?: Partial<RateDistortionConfig>
): Promise<CompressedContext> {
  const compressor = new RateDistortionCompressor(options);
  return compressor.compress(items);
}

/**
 * Estimate distortion between two context item sets.
 */
export async function estimateDistortion(
  original: ContextItem[],
  compressed: ContextItem[],
  query?: string
): Promise<number> {
  const compressor = new RateDistortionCompressor();
  return compressor.estimateDistortion(original, compressed, query);
}

// ================================================================
// Information Theory Utility Functions
// ================================================================

/**
 * Calculate the theoretical lower bound of the rate-distortion function R(D).
 *
 * For Gaussian source: R(D) = 0.5 * log2(sigma^2 / D) for D >= 0
 * For Bernoulli source: R(D) = H(p) - H(D) for D <= min(p, 1-p)
 *
 * Engineering approximation: R(D) ~= -alpha * log(D + epsilon)
 *
 * @param distortion - Target distortion D
 * @param alpha - Source complexity parameter, default 0.3
 * @param epsilon - Numerical stability constant, default 0.001
 * @returns Theoretical minimum rate R
 */
export function theoreticalRateBound(
  distortion: number,
  alpha: number = 0.3,
  epsilon: number = 0.001
): number {
  const d = Math.max(distortion, epsilon);
  return Math.max(0, -alpha * Math.log2(d));
}

/**
 * Calculate Shannon entropy of context.
 *
 * H(X) = -SUM p(x) * log2(p(x))
 *
 * Estimates information content based on word frequency distribution.
 *
 * @param items - Context items
 * @returns Entropy in bits
 */
export function contextEntropy(items: ContextItem[]): number {
  const combinedText = items.map((i) => i.content).join(" ");
  const tokens = combinedText
    .toLowerCase()
    .split(/[\s,.;:!?()\[\]{}"']+/)
    .filter((t) => t.length > 0);

  if (tokens.length === 0) return 0;

  const freq = new Map<string, number>();
  for (const token of tokens) {
    freq.set(token, (freq.get(token) || 0) + 1);
  }

  const N = tokens.length;
  let entropy = 0;
  for (const count of freq.values()) {
    const p = count / N;
    entropy -= p * Math.log2(p);
  }

  return entropy;
}

/**
 * Calculate context redundancy.
 *
 * Redundancy = 1 - H_actual / H_max
 *
 * Higher redundancy means more compression potential.
 *
 * @param items - Context items
 * @returns Redundancy [0, 1]
 */
export function contextRedundancy(items: ContextItem[]): number {
  const H = contextEntropy(items);
  const uniqueTokens = new Set(
    items
      .map((i) => i.content.toLowerCase())
      .join(" ")
      .split(/[\s,.;:!?()\[\]{}"']+/)
      .filter((t) => t.length > 0)
  ).size;

  if (uniqueTokens <= 1) return 0;

  const Hmax = Math.log2(uniqueTokens);
  return Hmax > 0 ? 1 - H / Hmax : 0;
}

/**
 * Calculate mutual information proxy between two context sets.
 *
 * Uses normalized Jaccard similarity as an estimate of mutual information.
 * I(X; Y) ~= -log(1 - Jaccard(X, Y) + epsilon)
 *
 * @param setA - Context set A
 * @param setB - Context set B
 * @returns Mutual information estimate
 */
export function mutualInformationProxy(
  setA: ContextItem[],
  setB: ContextItem[]
): number {
  const tokensA = setA
    .map((i) => i.content)
    .join(" ")
    .toLowerCase()
    .split(/[\s,.;:!?()\[\]{}"']+/)
    .filter((t) => t.length > 0);
  const tokensB = setB
    .map((i) => i.content)
    .join(" ")
    .toLowerCase()
    .split(/[\s,.;:!?()\[\]{}"']+/)
    .filter((t) => t.length > 0);

  const setAUniq = new Set(tokensA);
  const setBUniq = new Set(tokensB);
  const intersection = new Set([...setAUniq].filter((x) => setBUniq.has(x)));
  const union = new Set([...setAUniq, ...setBUniq]);

  const jaccard = union.size > 0 ? intersection.size / union.size : 0;
  const epsilon = 0.001;

  return Math.max(0, -Math.log2(1 - jaccard + epsilon));
}
