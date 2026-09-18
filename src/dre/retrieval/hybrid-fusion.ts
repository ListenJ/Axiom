/**
 * 混合融合排序 — Layer 4
 *
 * 设计目标（对应用户方向四：混合检索 Hybrid Search——务实的"最优解"）：
 *   - 建立检索结果融合与排序机制，平衡精确匹配能力和语义泛化能力
 *   - 目标将系统召回率从 72% 提升至 94%
 *
 * 融合策略（确定性，零黑盒）：
 *   1. 多源去重：关键词(Layer 0) + 图谱(Layer 0/1) + Wiki(Layer 2) 结果按 ID 去重
 *   2. 验证加权：Layer 3 验证结论作为排序权重（verified 加分 / unverified 减分 / contradicted 重罚）
 *   3. 交叉来源加成：结果在多个来源中出现时加分（多源印证提升可信度）
 *   4. 来源多样性：hybrid 结果（关键词+图谱双来源）获得多样性加成
 *
 * 架构分层位置：
 *   Layer 0（检索）→ Layer 1（GraphRAG）→ Layer 2（Wiki）→ Layer 3（验证）
 *   → 本模块（Layer 4 融合）→ Layer 5（可观测性）
 *
 * 设计原则（遵循 AGENTS.md 规则 8 深模块设计）：
 *   - 小接口：fuse(input) 是唯一公开入口
 *   - 接受依赖不创建依赖：结果与验证结论作为参数传入，不内部调用引擎
 *   - 接口即测试面：全部可通过 fuse() 验证
 */

import type { RetrievalResult, EvidenceStep } from "./deterministic-retrieval-engine.js";
import type { VerificationVerdict, VerificationStatus } from "./verification-chain.js";
import { logger } from "../../utils/logger.js";

// ─── 公共类型 ────────────────────────────────────────────────────────────

/** 融合来源类型 */
export type FusionSourceType = "keyword" | "graph" | "wiki" | "graphrag";

/** 融合输入 */
export interface FusionInput {
  /** 原始查询 */
  query: string;
  /** 来自各来源的检索结果（可包含重复 ID） */
  results: RetrievalResult[];
  /** 可选：验证结论映射（key = result.id，value = verdict） */
  verdicts?: Map<string, VerificationVerdict>;
  /** 融合选项 */
  options?: Partial<FusionOptions>;
}

/** 融合选项 */
export interface FusionOptions {
  /** verified 加分比例（默认 0.1 = +10%） */
  verificationBoost: number;
  /** unverified 减分比例（默认 0.1 = -10%） */
  verificationPenalty: number;
  /** contradicted 减分比例（默认 0.5 = -50%） */
  contradictionPenalty: number;
  /** 交叉来源加成（默认 0.2 = +20%） */
  crossSourceBoost: number;
  /** 来源多样性加成（默认 0.15 = +15%） */
  diversityBoost: number;
  /** 最低得分阈值（低于此值的结果被过滤，默认 0） */
  minScore: number;
  /** 最大返回数（默认 20） */
  limit: number;
}

/** 融合结果 — 扩展 RetrievalResult，附加融合元数据 */
export interface FusionResult extends RetrievalResult {
  /** 融合后最终得分 */
  fusionScore: number;
  /** 各来源贡献 */
  sourceContributions: Array<{ source: FusionSourceType; score: number }>;
  /** 验证状态（若有） */
  verificationStatus?: VerificationStatus;
  /** 融合推理说明（人类可读） */
  fusionReasoning: string;
}

/** 融合性能指标 */
export interface FusionMetrics {
  /** 输入结果总数 */
  totalInput: number;
  /** 输出结果数 */
  totalOutput: number;
  /** 去重移除数 */
  duplicatesRemoved: number;
  /** 多源印证结果数（2+ 来源） */
  crossSourceCount: number;
  /** 已验证结果数 */
  verifiedCount: number;
  /** 矛盾结果数 */
  contradictedCount: number;
  /** 融合延迟（毫秒） */
  latencyMs: number;
}

/** 融合完整响应 */
export interface FusionResponse {
  results: FusionResult[];
  metrics: FusionMetrics;
}

// ─── 默认配置 ────────────────────────────────────────────────────────────

export const DEFAULT_FUSION_OPTIONS: FusionOptions = {
  verificationBoost: 0.1,
  verificationPenalty: 0.1,
  contradictionPenalty: 0.5,
  crossSourceBoost: 0.2,
  diversityBoost: 0.15,
  minScore: 0,
  limit: 20,
};

// ─── 混合融合器 ──────────────────────────────────────────────────────────

/**
 * 混合融合排序器 — 多源结果融合 + 验证加权 + 交叉来源加成
 *
 * 融合流程（确定性，可追溯）：
 *   1. 按 ID 分组，合并同 ID 结果（保留最高分 + 合并证据步骤）
 *   2. 检测交叉来源（同 ID 来自多种 source）
 *   3. 应用验证加权（verdicts 映射）
 *   4. 应用交叉来源 + 多样性加成
 *   5. 按 fusionScore 降序排列 + 过滤 + 截断
 */
export class HybridFusion {
  private readonly options: FusionOptions;

  constructor(opts: Partial<FusionOptions> = {}) {
    this.options = { ...DEFAULT_FUSION_OPTIONS, ...opts };
  }

  /**
   * 融合多源检索结果 — 唯一公开入口
   *
   * @param input 融合输入（结果 + 可选验证结论）
   * @returns 融合后的排序结果 + 指标
   */
  fuse(input: FusionInput): FusionResponse {
    const startTime = performance.now();
    const opts = { ...this.options, ...input.options };
    const { results, verdicts } = input;

    if (results.length === 0) {
      return {
        results: [],
        metrics: {
          totalInput: 0,
          totalOutput: 0,
          duplicatesRemoved: 0,
          crossSourceCount: 0,
          verifiedCount: 0,
          contradictedCount: 0,
          latencyMs: Math.round(performance.now() - startTime),
        },
      };
    }

    // 1. 按 ID 分组
    const groups = this.groupById(results);
    const duplicatesRemoved = results.length - groups.size;

    // 2. 合并同 ID 结果 + 检测来源
    const merged: FusionResult[] = [];
    let crossSourceCount = 0;
    let verifiedCount = 0;
    let contradictedCount = 0;

    for (const [id, group] of groups) {
      const fused = this.mergeGroup(id, group, verdicts, opts);

      if (fused.sourceContributions.length >= 2) crossSourceCount++;
      if (fused.verificationStatus === "verified") verifiedCount++;
      if (fused.verificationStatus === "contradicted") contradictedCount++;

      merged.push(fused);
    }

    // 3. 排序 + 过滤 + 截断
    const sorted = merged
      .filter((r) => r.fusionScore >= opts.minScore)
      .sort((a, b) => b.fusionScore - a.fusionScore)
      .slice(0, opts.limit);

    const metrics: FusionMetrics = {
      totalInput: results.length,
      totalOutput: sorted.length,
      duplicatesRemoved,
      crossSourceCount,
      verifiedCount,
      contradictedCount,
      latencyMs: Math.round(performance.now() - startTime),
    };

    logger.debug("[DRE/Fusion] 融合完成", {
      query: input.query.slice(0, 50),
      ...metrics,
    });

    return { results: sorted, metrics };
  }

  // ─── 私有：分组与合并 ─────────────────────────────────────────────────

  /** 按 ID 分组 */
  private groupById(results: RetrievalResult[]): Map<string, RetrievalResult[]> {
    const groups = new Map<string, RetrievalResult[]>();
    for (const r of results) {
      const group = groups.get(r.id);
      if (group) {
        group.push(r);
      } else {
        groups.set(r.id, [r]);
      }
    }
    return groups;
  }

  /**
   * 合并同 ID 的结果组 — 保留最高分 + 合并证据 + 计算融合得分
   */
  private mergeGroup(
    id: string,
    group: RetrievalResult[],
    verdicts: Map<string, VerificationVerdict> | undefined,
    opts: FusionOptions,
  ): FusionResult {
    // 取最高分结果作为基础
    const base = group.reduce((best, r) => (r.score > best.score ? r : best));

    // 合并所有证据步骤
    const allSteps: EvidenceStep[] = [];
    for (const r of group) {
      allSteps.push(...r.evidenceChain.steps);
    }
    // 去重证据步骤（按 type+target）
    const seen = new Set<string>();
    const dedupedSteps = allSteps.filter((s) => {
      const key = `${s.type}::${s.target}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    // 检测来源贡献
    const sourceContributions = this.detectSourceContributions(group);

    // 合并 reasons
    const allReasons = new Set<string>();
    for (const r of group) {
      for (const reason of r.reasons) allReasons.add(reason);
    }

    // 计算融合得分
    const verdict = verdicts?.get(id);
    const { fusionScore, reasoning } = this.computeFusionScore(
      base.score,
      sourceContributions,
      verdict,
      opts,
      base.source,
    );

    // 构建融合结果
    const fused: FusionResult = {
      ...base,
      evidenceChain: {
        ...base.evidenceChain,
        steps: dedupedSteps,
        totalConfidence: Math.max(...group.map((r) => r.evidenceChain.totalConfidence)),
      },
      reasons: Array.from(allReasons),
      source: group.length > 1 || sourceContributions.length >= 2 ? "hybrid" : base.source,
      fusionScore,
      sourceContributions,
      verificationStatus: verdict?.status,
      fusionReasoning: reasoning,
    };

    return fused;
  }

  /** 检测来源贡献 — 从结果组中提取各来源及其得分 */
  private detectSourceContributions(
    group: RetrievalResult[],
  ): Array<{ source: FusionSourceType; score: number }> {
    const contributions = new Map<FusionSourceType, number>();

    for (const r of group) {
      // 基于 source 字段
      if (r.source === "keyword" || r.notePath !== undefined) {
        contributions.set("keyword", Math.max(contributions.get("keyword") ?? 0, r.score));
      }
      if (r.source === "graph" || r.entityId !== undefined) {
        contributions.set("graph", Math.max(contributions.get("graph") ?? 0, r.score));
      }
      if (r.source === "hybrid") {
        contributions.set("keyword", Math.max(contributions.get("keyword") ?? 0, r.score));
        contributions.set("graph", Math.max(contributions.get("graph") ?? 0, r.score));
      }

      // 基于证据步骤类型检测来源
      for (const step of r.evidenceChain.steps) {
        if (step.type === "keyword_match") {
          contributions.set("keyword", Math.max(contributions.get("keyword") ?? 0, r.score));
        } else if (step.type === "graph_entity" || step.type === "graph_traverse" || step.type === "graph_link") {
          contributions.set("graph", Math.max(contributions.get("graph") ?? 0, r.score));
        }
      }
    }

    return Array.from(contributions.entries()).map(([source, score]) => ({ source, score }));
  }

  /**
   * 计算融合得分 — 基础分 + 验证加权 + 交叉来源加成 + 多样性加成
   */
  private computeFusionScore(
    baseScore: number,
    contributions: Array<{ source: FusionSourceType; score: number }>,
    verdict: VerificationVerdict | undefined,
    opts: FusionOptions,
    sourceType: RetrievalResult["source"],
  ): { fusionScore: number; reasoning: string } {
    let score = baseScore;
    const reasons: string[] = [`基础得分 ${baseScore.toFixed(1)}`];

    // 1. 验证加权
    if (verdict) {
      if (verdict.status === "verified") {
        score *= 1 + opts.verificationBoost;
        reasons.push(`验证通过 +${(opts.verificationBoost * 100).toFixed(0)}%`);
      } else if (verdict.status === "unverified") {
        score *= 1 - opts.verificationPenalty;
        reasons.push(`未验证 -${(opts.verificationPenalty * 100).toFixed(0)}%`);
      } else if (verdict.status === "contradicted") {
        score *= 1 - opts.contradictionPenalty;
        reasons.push(`存在矛盾 -${(opts.contradictionPenalty * 100).toFixed(0)}%`);
      }
    }

    // 2. 交叉来源加成（2+ 来源）
    if (contributions.length >= 2) {
      score *= 1 + opts.crossSourceBoost;
      reasons.push(`${contributions.length} 源印证 +${(opts.crossSourceBoost * 100).toFixed(0)}%`);
    }

    // 3. 来源多样性加成（hybrid 结果）
    if (sourceType === "hybrid") {
      score *= 1 + opts.diversityBoost;
      reasons.push(`混合来源 +${(opts.diversityBoost * 100).toFixed(0)}%`);
    }

    return {
      fusionScore: Math.round(score * 100) / 100,
      reasoning: reasons.join("；"),
    };
  }
}

// ─── 单例 ───────────────────────────────────────────────────────────────

let _instance: HybridFusion | null = null;

/** 获取融合器单例 */
export function getHybridFusion(): HybridFusion {
  if (!_instance) _instance = new HybridFusion();
  return _instance;
}

/** 测试用：重置单例 */
export function _resetHybridFusionForTest(): void {
  _instance = null;
}

/** 测试用：设置自定义实例 */
export function _setHybridFusionForTest(fusion: HybridFusion | null): void {
  _instance = fusion;
}
