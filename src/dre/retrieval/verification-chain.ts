/**
 * 证据验证链 — Layer 3 可验证性
 *
 * 设计目标（对应用户方向三：强化可验证性与可观测性）：
 *   1. 证据验证链（StillMe）：构建包含引用、证据重叠、来源多样性、数值一致性
 *      等多层验证的"验证链"，确保每个回答有据可查。
 *   2. 置信度触发（ConfRAG）：评估结果集不确定性，仅在置信度不足时触发深度检索，
 *      目标将幻觉率从 20-40% 降至 5% 以下。
 *
 * 设计原则（遵循 AGENTS.md 规则 8 深模块设计）：
 *   - 小接口：verifyResult() / verifyBatch() / shouldTriggerDeepRetrieval() 三方法覆盖
 *   - 零 LLM 调用：纯确定性验证（与 Layer 0/1 一致，消除"黑盒套黑盒"）
 *   - 接口即测试面：全部可通过公共接口验证
 *   - 多视角"辩论"：4 项独立检查并行评估，等价于多智能体投票（Debate 的确定性实现）
 *
 * 架构分层位置：
 *   Layer 0/1（检索 + GraphRAG）→ 本模块（Layer 3 验证）→ Layer 4（融合排序）
 *   验证结论可被上层用于排序加权与深度检索触发。
 */

import type { RetrievalResult } from "./deterministic-retrieval-engine.js";
import { logger } from "../../utils/logger.js";

// ─── 公共类型 ────────────────────────────────────────────────────────────

/** 验证检查项名称 */
export type VerificationCheckName =
  | "citation"
  | "evidence_overlap"
  | "source_diversity"
  | "numerical_consistency";

/** 单项验证检查结果 */
export interface VerificationCheck {
  /** 检查名称 */
  name: VerificationCheckName;
  /** 是否通过 */
  passed: boolean;
  /** 检查得分 0-1 */
  score: number;
  /** 人类可读的检查详情 */
  detail: string;
}

/** 验证结论状态 */
export type VerificationStatus = "verified" | "unverified" | "contradicted";

/** 验证结论 — 单个结果的完整验证输出 */
export interface VerificationVerdict {
  /** 验证状态 */
  status: VerificationStatus;
  /** 综合置信度 0-1（结合检查得分与原始证据链置信度） */
  overallConfidence: number;
  /** 各项检查结果 */
  checks: VerificationCheck[];
  /** 综合推理说明（人类可读，可追溯） */
  reasoning: string;
}

/** 验证选项 */
export interface VerificationOptions {
  /** 综合置信度阈值，>= 该值才视为 verified（默认 0.6） */
  confidenceThreshold?: number;
  /** 是否启用数值一致性检查（默认 true） */
  enableNumericalCheck?: boolean;
}

/** ConfRAG 触发判断结果 */
export interface ConfRAGTriggerResult {
  /** 是否应触发深度检索 */
  trigger: boolean;
  /** 已验证结果占比 */
  verifiedRate: number;
  /** 平均综合置信度 */
  avgConfidence: number;
  /** 触发或不触发的人类可读原因 */
  reason: string;
}

/** 批量验证条目 */
export interface BatchVerificationEntry {
  result: RetrievalResult;
  verdict: VerificationVerdict;
}

// ─── 验证链 ──────────────────────────────────────────────────────────────

/**
 * 证据验证链 — 对检索结果进行多层确定性验证
 *
 * 验证维度（4 项独立检查，等价于多智能体"辩论"投票）：
 *   1. citation（引用存在性）：结果是否有可追溯来源（entityId 或 notePath）
 *   2. evidence_overlap（证据重叠）：多个证据步骤是否相互印证
 *   3. source_diversity（来源多样性）：是否有多个独立来源（多种步骤类型/来源）
 *   4. numerical_consistency（数值一致性）：内容数值在证据步骤间是否一致
 */
export class VerificationChain {
  private readonly confidenceThreshold: number;
  private readonly enableNumericalCheck: boolean;

  constructor(opts: VerificationOptions = {}) {
    this.confidenceThreshold = opts.confidenceThreshold ?? 0.6;
    this.enableNumericalCheck = opts.enableNumericalCheck ?? true;
  }

  /**
   * 验证单个检索结果 — 返回完整验证结论
   *
   * 流程（可追溯）：
   *   1. 引用存在性检查
   *   2. 证据重叠检查
   *   3. 来源多样性检查
   *   4. 数值一致性检查（可选）
   *   5. 综合置信度计算 + 状态判定 + 推理编译
   */
  verifyResult(result: RetrievalResult): VerificationVerdict {
    const checks: VerificationCheck[] = [];

    checks.push(this.checkCitation(result));
    checks.push(this.checkEvidenceOverlap(result));
    checks.push(this.checkSourceDiversity(result));
    if (this.enableNumericalCheck) {
      checks.push(this.checkNumericalConsistency(result));
    }

    const overallConfidence = this.computeOverallConfidence(checks, result);

    // 状态判定：数值不一致 → contradicted；否则按阈值
    const hasContradiction = checks.some(
      (c) => c.name === "numerical_consistency" && !c.passed && c.score === 0,
    );
    const status: VerificationStatus = hasContradiction
      ? "contradicted"
      : overallConfidence >= this.confidenceThreshold
        ? "verified"
        : "unverified";

    const reasoning = this.compileReasoning(result, checks, status, overallConfidence);

    logger.debug("[DRE/Verification] 验证完成", {
      resultId: result.id,
      status,
      overallConfidence: Number(overallConfidence.toFixed(3)),
      checksPassed: checks.filter((c) => c.passed).length,
      checksTotal: checks.length,
    });

    return { status, overallConfidence, checks, reasoning };
  }

  /**
   * 批量验证 — 对结果集逐条验证
   *
   * @returns 每条结果对应的验证结论（保持顺序）
   */
  verifyBatch(results: RetrievalResult[]): BatchVerificationEntry[] {
    return results.map((result) => ({
      result,
      verdict: this.verifyResult(result),
    }));
  }

  /**
   * ConfRAG：判断是否需要触发深度检索
   *
   * 策略（可配置）：
   *   - 当 verified 结果占比 < minVerifiedRate（默认 0.5）→ 触发
   *   - 当平均综合置信度 < minAvgConfidence（默认 0.5）→ 触发
   *   - 空结果集 → 触发
   *
   * @param results 检索结果集
   * @param opts 触发阈值（可覆盖默认值）
   */
  shouldTriggerDeepRetrieval(
    results: RetrievalResult[],
    opts: { minVerifiedRate?: number; minAvgConfidence?: number } = {},
  ): ConfRAGTriggerResult {
    const minVerifiedRate = opts.minVerifiedRate ?? 0.5;
    const minAvgConfidence = opts.minAvgConfidence ?? 0.5;

    if (results.length === 0) {
      return {
        trigger: true,
        verifiedRate: 0,
        avgConfidence: 0,
        reason: "无检索结果，需触发深度检索",
      };
    }

    const verdicts = results.map((r) => this.verifyResult(r));
    const verifiedCount = verdicts.filter((v) => v.status === "verified").length;
    const verifiedRate = verifiedCount / results.length;
    const avgConfidence =
      verdicts.reduce((sum, v) => sum + v.overallConfidence, 0) / verdicts.length;

    const trigger = verifiedRate < minVerifiedRate || avgConfidence < minAvgConfidence;
    const reason = trigger
      ? `验证率 ${verifiedRate.toFixed(2)} < ${minVerifiedRate} 或平均置信度 ${avgConfidence.toFixed(2)} < ${minAvgConfidence}，触发深度检索`
      : `验证率 ${verifiedRate.toFixed(2)} >= ${minVerifiedRate} 且平均置信度 ${avgConfidence.toFixed(2)} >= ${minAvgConfidence}，无需深度检索`;

    return { trigger, verifiedRate, avgConfidence, reason };
  }

  // ─── 各项检查（私有，纯函数式）────────────────────────────────────────

  /**
   * 检查 1：引用存在性 — 结果是否有可追溯来源
   *
   * 通过条件：(entityId 或 notePath 存在) 且 至少一条证据步骤
   */
  private checkCitation(result: RetrievalResult): VerificationCheck {
    const hasEntity = result.entityId !== undefined && result.entityId.length > 0;
    const hasNote = result.notePath !== undefined && result.notePath.length > 0;
    const hasSteps = result.evidenceChain.steps.length > 0;

    const passed = (hasEntity || hasNote) && hasSteps;
    const score = passed ? 1.0 : hasSteps ? 0.5 : 0;

    const sources: string[] = [];
    if (hasEntity) sources.push(`实体:${result.entityId}`);
    if (hasNote) sources.push(`笔记:${result.notePath}`);

    return {
      name: "citation",
      passed,
      score,
      detail: passed
        ? `引用来源：${sources.join("；")}，证据步骤 ${result.evidenceChain.steps.length} 条`
        : "无可追溯来源（缺失 entityId 和 notePath）",
    };
  }

  /**
   * 检查 2：证据重叠 — 多个证据步骤是否相互印证
   *
   * 通过条件：多个步骤指向同一目标，或多步骤置信度一致（差异 <= 0.5）
   */
  private checkEvidenceOverlap(result: RetrievalResult): VerificationCheck {
    const steps = result.evidenceChain.steps;
    if (steps.length === 0) {
      return { name: "evidence_overlap", passed: false, score: 0, detail: "无证据步骤" };
    }
    if (steps.length === 1) {
      return {
        name: "evidence_overlap",
        passed: false,
        score: 0.3,
        detail: "仅一条证据步骤，无重叠印证",
      };
    }

    // 检查是否有多个步骤指向同一目标（相互印证）
    const targetCounts = new Map<string, number>();
    for (const step of steps) {
      targetCounts.set(step.target, (targetCounts.get(step.target) ?? 0) + 1);
    }
    const overlappingTargets = Array.from(targetCounts.values()).filter((c) => c > 1).length;

    // 检查证据步骤间的置信度一致性
    const confidences = steps.map((s) => s.confidence);
    const maxConf = Math.max(...confidences);
    const minConf = Math.min(...confidences);
    const consistencyOk = maxConf - minConf <= 0.5;

    const passed = overlappingTargets > 0 || consistencyOk;
    const score = passed ? Math.min(0.5 + overlappingTargets * 0.25, 1) : 0.4;

    return {
      name: "evidence_overlap",
      passed,
      score,
      detail: passed
        ? `${overlappingTargets} 个目标被多次指向，置信度差异 ${(maxConf - minConf).toFixed(2)}`
        : `证据步骤间无重叠，置信度差异 ${(maxConf - minConf).toFixed(2)} 过大`,
    };
  }

  /**
   * 检查 3：来源多样性 — 是否有多个独立来源
   *
   * 通过条件：来源类型 >= 2（关键词 + 图谱），或证据步骤类型 >= 2
   */
  private checkSourceDiversity(result: RetrievalResult): VerificationCheck {
    const stepTypes = new Set(result.evidenceChain.steps.map((s) => s.type));
    const sourceTypes = new Set<string>();
    if (result.source === "hybrid" || result.notePath !== undefined) sourceTypes.add("keyword");
    if (result.source === "hybrid" || result.entityId !== undefined) sourceTypes.add("graph");

    const passed = sourceTypes.size >= 2 || stepTypes.size >= 2;
    const score = Math.min((sourceTypes.size + stepTypes.size) / 4, 1);

    return {
      name: "source_diversity",
      passed,
      score,
      detail: passed
        ? `来源类型 ${sourceTypes.size}（${Array.from(sourceTypes).join("/")}），步骤类型 ${stepTypes.size}（${Array.from(stepTypes).join("/")}）`
        : `来源单一（${Array.from(sourceTypes).join("/") || "无"}），步骤类型 ${stepTypes.size}`,
    };
  }

  /**
   * 检查 4：数值一致性 — 内容中的数值在证据步骤间是否一致
   *
   * 通过条件：excerpt 中所有数值都能在证据步骤推理说明中找到（>= 50% 匹配率），
   * 或内容中无数值。
   * 失败且 score=0 → 触发 contradicted 状态
   */
  private checkNumericalConsistency(result: RetrievalResult): VerificationCheck {
    const excerptNums = this.extractNumbers(result.excerpt);

    // 收集证据步骤中的所有数值
    const stepNums = new Set<number>();
    for (const step of result.evidenceChain.steps) {
      for (const n of this.extractNumbers(step.reasoning)) {
        stepNums.add(n);
      }
    }

    if (excerptNums.length === 0) {
      return {
        name: "numerical_consistency",
        passed: true,
        score: 1,
        detail: "无数值需验证",
      };
    }

    let matched = 0;
    for (const n of excerptNums) {
      if (stepNums.has(n)) matched++;
    }
    const matchRate = matched / excerptNums.length;
    const passed = matchRate >= 0.5;
    // score=0 表示完全矛盾（用于触发 contradicted）
    const score = matchRate === 0 ? 0 : Math.max(matchRate, 0.3);

    return {
      name: "numerical_consistency",
      passed,
      score,
      detail: `${matched}/${excerptNums.length} 个数值在证据中找到`,
    };
  }

  // ─── 辅助方法 ─────────────────────────────────────────────────────────

  /** 从文本中提取正数值（忽略 0） */
  private extractNumbers(text: string): number[] {
    if (!text) return [];
    const matches = text.match(/\d+(?:\.\d+)?/g);
    if (!matches) return [];
    return matches.map(Number).filter((n) => n > 0);
  }

  /**
   * 计算综合置信度
   *
   * 加权策略：
   *   - citation 0.3（最关键：无引用则不可信）
   *   - evidence_overlap 0.25
   *   - source_diversity 0.25
   *   - numerical_consistency 0.2
   *
   * 最终综合：检查得分 0.6 + 原始证据链置信度 0.4
   */
  private computeOverallConfidence(checks: VerificationCheck[], result: RetrievalResult): number {
    const weights: Record<VerificationCheckName, number> = {
      citation: 0.3,
      evidence_overlap: 0.25,
      source_diversity: 0.25,
      numerical_consistency: 0.2,
    };

    let sum = 0;
    let weightSum = 0;
    for (const check of checks) {
      const w = weights[check.name] ?? 0;
      sum += check.score * w;
      weightSum += w;
    }

    const checksConfidence = weightSum > 0 ? sum / weightSum : 0;
    const evidenceConfidence = result.evidenceChain.totalConfidence;

    // 综合：检查得分 0.6 + 证据置信度 0.4
    return Math.min(checksConfidence * 0.6 + evidenceConfidence * 0.4, 1);
  }

  /** 编译人类可读的推理说明（可追溯） */
  private compileReasoning(
    result: RetrievalResult,
    checks: VerificationCheck[],
    status: VerificationStatus,
    overallConfidence: number,
  ): string {
    const passed = checks.filter((c) => c.passed);
    const failed = checks.filter((c) => !c.passed);
    const parts: string[] = [];

    parts.push(`结果 "${result.title}" 验证状态：${status}（综合置信度 ${overallConfidence.toFixed(2)}）`);
    if (passed.length > 0) {
      parts.push(`通过：${passed.map((c) => c.name).join("、")}`);
    }
    if (failed.length > 0) {
      parts.push(`未通过：${failed.map((c) => `${c.name}（${c.detail}）`).join("；")}`);
    }

    return parts.join("；");
  }
}

// ─── 单例 ───────────────────────────────────────────────────────────────

let _instance: VerificationChain | null = null;

/** 获取验证链单例（默认配置） */
export function getVerificationChain(): VerificationChain {
  if (!_instance) _instance = new VerificationChain();
  return _instance;
}

/** 测试用：重置单例 */
export function _resetVerificationChainForTest(): void {
  _instance = null;
}

/** 测试用：设置自定义实例 */
export function _setVerificationChainForTest(chain: VerificationChain | null): void {
  _instance = chain;
}
