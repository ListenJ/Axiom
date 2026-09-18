/**
 * Verification Engine — 结果验证引擎
 *
 * 验证 TaskGraph 执行后的结果是否符合预期。
 * 是 ConstraintSolver 和 ReasoningGraph 的重要补充。
 *
 * 三层验证:
 * 1. Output — 输出格式/结构是否完整
 * 2. Constraint — 是否违反约束
 * 3. Reasoning — 推理链是否完整 (无 Gap, 无循环)
 */

import { logger } from "../../utils/logger.js";
import type { ConstraintSolver } from "../constraint/solver.js";
import type { ReasoningGraph } from "../reasoning/graph.js";

export type Verdict = "pass" | "fail" | "uncertain";

/**
 * Refine callback — 当 verifyResult 返回非 pass 时调用，用于 LLM 修正 result 后重新验证。
 * 接收当前 result 和验证报告，返回修正后的 result。
 */
export type RefineCallback = (
  result: unknown,
  report: VerificationReport,
) => Promise<unknown>;

export interface VerificationIssue {
  type: "output" | "constraint" | "reasoning" | "evidence";
  description: string;
  severity: number; // 1-10
  suggestion: string;
}

export interface VerificationReport {
  /** 执行 ID */
  executionId: string;
  /** 整体结论 */
  overallVerdict: Verdict;
  /** 整体置信度 0-1 */
  overallConfidence: number;
  /** 各项评分 */
  scores: {
    output: number;     // 输出完整性
    constraint: number;  // 约束满足度
    reasoning: number;   // 推理链完整度
    evidence: number;    // 证据充分度
  };
  /** 发现的问题 */
  issues: VerificationIssue[];
  /** 是否需要 LLM 辅助 */
  needsLLM: boolean;
  /** 时间戳 */
  timestamp: number;
  /** 验证耗时 ms */
  duration: number;
  /** refine 后的最终 result（未 refine 时等于传入的 result） */
  finalResult?: unknown;
  /** refine 实际迭代次数（未 refine 时为 0） */
  refineIterations?: number;
}

export interface VerificationConfig {
  /** 置信度阈值: 低于此值标记为 fail */
  confidenceThreshold: number;
  /** 是否需要 LLM 的置信度阈值: 低于此值启用 LLM 回退 */
  llmFallbackThreshold: number;
  /** 是否严格模式: 任何 issue 都标记 fail */
  strictMode: boolean;
  /** refineCallback 超时 ms (防止 LLM 挂起), 默认 30000 */
  refineTimeoutMs: number;
}

const DEFAULT_CONFIG: VerificationConfig = {
  confidenceThreshold: 0.6,
  llmFallbackThreshold: 0.5,
  strictMode: false,
  refineTimeoutMs: 30000,
};

class VerificationEngineImpl {
  private config: VerificationConfig;
  private stats = { verified: 0, passed: 0, failed: 0, uncertain: 0 };

  constructor(config?: Partial<VerificationConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * 验证推理结果（支持 refine 循环）
   *
   * 当 verdict != "pass" 且提供了 refineCallback 时，循环调用：
   *   refineCallback(result, report) → 修正后的 result → 重新 verifyOnce
   * 最多 maxRefine 次（默认 2），达上限或 verdict 变 pass 时返回最后报告。
   *
   * 三重死循环防护：
   * 1. maxRefine 上限
   * 2. 无进展退出（overallConfidence 未提升）
   * 3. refineCallback 抛异常时 try/catch 退出
   *
   * @param opts.constraintContext 上下文字段，会被各 dimension evaluator 读取
   *   （如 `{ intent, domain, action, environment }`）。调用方应传入完整上下文，
   *   而非 `{ dimension }` 这种过滤条件——ConstraintSolver.check 会遍历所有 enabled 约束。
   * @param opts.refineCallback 当 verdict != pass 时调用的 LLM 修正回调
   * @param opts.maxRefine 最大 refine 次数，默认 2
   */
  async verifyResult(
    executionId: string,
    result: unknown,
    opts?: {
      constraintSolver?: ConstraintSolver;
      reasoningGraph?: ReasoningGraph;
      expectedOutput?: unknown;
      constraintContext?: Record<string, unknown>;
      refineCallback?: RefineCallback;
      maxRefine?: number;
    }
  ): Promise<VerificationReport> {
    const maxRefine = opts?.maxRefine ?? 2;
    let current = result;
    let report = this.verifyOnce(executionId, current, opts);
    let iterations = 0;

    for (let i = 0; i < maxRefine; i++) {
      if (report.overallVerdict === "pass") break;
      if (!opts?.refineCallback) break;

      const prevConf = report.overallConfidence;
      try {
        current = await this.withTimeout(
          opts.refineCallback(current, report),
          this.config.refineTimeoutMs,
          `refineCallback iteration ${i + 1}`,
        );
      } catch (err) {
        logger.warn("[Verification] refineCallback failed", { error: (err as Error).message });
        break;
      }
      report = this.verifyOnce(executionId, current, opts);
      iterations = i + 1;

      if (report.overallConfidence <= prevConf) break;
    }

    this.stats.verified++;
    if (report.overallVerdict === "pass") this.stats.passed++;
    else if (report.overallVerdict === "fail") this.stats.failed++;
    else this.stats.uncertain++;

    report.finalResult = current;
    report.refineIterations = iterations;
    return report;
  }

  /**
   * 为 refineCallback 添加超时保护, 防止 LLM 挂起导致 refine 循环永久阻塞。
   */
  private async withTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number,
    label: string,
  ): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
        timeoutMs,
      );
    });
    try {
      return await Promise.race([promise, timeoutPromise]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * 单次验证（无循环、无 stats 计数）。
   * 私有方法，由 verifyResult 在 refine 循环中调用。
   */
  private verifyOnce(
    executionId: string,
    result: unknown,
    opts?: {
      constraintSolver?: ConstraintSolver;
      reasoningGraph?: ReasoningGraph;
      expectedOutput?: unknown;
      constraintContext?: Record<string, unknown>;
    }
  ): VerificationReport {
    const start = Date.now();
    const issues: VerificationIssue[] = [];
    let scores = { output: 1.0, constraint: 1.0, reasoning: 1.0, evidence: 1.0 };

    // 1. Output verification
    if (result == null) {
      issues.push({
        type: "output",
        description: "Result is null or undefined",
        severity: 10,
        suggestion: "Re-run the pipeline with more context",
      });
      scores.output = 0;
      scores.constraint = 0;
      scores.reasoning = 0;
      scores.evidence = 0;
    } else if (typeof result === "string" && result.length < 10) {
      issues.push({
        type: "output",
        description: `Result too short: ${result.length} chars`,
        severity: 5,
        suggestion: "LLM may need to elaborate",
      });
      scores.output = 0.3;
    }

    // 1b. Expected output validation (如果提供了 expectedOutput)
    if (opts?.expectedOutput !== undefined && result != null) {
      const mismatch = this.checkExpectedOutput(result, opts.expectedOutput);
      if (mismatch) {
        issues.push(mismatch);
        scores.output = Math.min(scores.output, 0.4);
      }
    }

    // 2. Constraint verification
    if (opts?.constraintSolver) {
      const action = typeof result === "object" ? JSON.stringify(result) : String(result).slice(0, 200);
      const constraintResult = opts.constraintSolver.check(action, opts.constraintContext);
      if (!constraintResult.satisfied) {
        scores.constraint = 0;
        for (const v of constraintResult.violations) {
          issues.push({
            type: "constraint",
            description: `${v.constraintName}: ${v.reason}`,
            severity: v.severity,
            suggestion: v.suggestion,
          });
        }
      } else {
        scores.constraint = 1.0;
      }
    }

    // 3. Reasoning chain verification
    if (opts?.reasoningGraph) {
      const stats = opts.reasoningGraph.getStats();
      if (stats.gaps > 0) {
        scores.reasoning = Math.max(0, 1 - stats.gaps / (stats.totalNodes || 1));
        if (stats.gaps >= 3) {
          issues.push({
            type: "reasoning",
            description: `Reasoning chain has ${stats.gaps} gaps out of ${stats.totalNodes} nodes`,
            severity: Math.min(10, stats.gaps * 2),
            suggestion: "LLM fallback needed to fill reasoning gaps",
          });
        }
      }
      if (stats.totalEdges > stats.totalNodes * 2) {
        issues.push({
          type: "reasoning",
          description: "Possible reasoning cycle detected (edges > 2 * nodes)",
          severity: 6,
          suggestion: "Break down the reasoning into smaller steps",
        });
        scores.reasoning = Math.max(0, scores.reasoning - 0.3);
      }
    }

    // 4. Evidence verification (字符串和对象均检查)
    scores.evidence = this.checkEvidence(result, issues, scores.evidence);

    const overallScore = (scores.output + scores.constraint + scores.reasoning + scores.evidence) / 4;

    let overallVerdict: Verdict;
    if (overallScore >= this.config.confidenceThreshold) {
      overallVerdict = "pass";
    } else if (overallScore >= this.config.llmFallbackThreshold) {
      overallVerdict = "uncertain";
    } else {
      overallVerdict = "fail";
    }

    // strictMode: 任何 issue 都标记为 fail (覆盖 score-based verdict)
    if (this.config.strictMode && issues.length > 0) {
      overallVerdict = "fail";
    }

    const needsLLM = overallVerdict === "fail" ||
      (overallVerdict === "uncertain" && issues.some((i) => i.severity >= 7));

    const duration = Date.now() - start;

    if (issues.length > 0) {
      logger.info("[Verification] Issues found", {
        executionId,
        count: issues.length,
        verdict: overallVerdict,
        confidence: overallScore.toFixed(2),
        needsLLM,
        duration,
        strictMode: this.config.strictMode,
      });
    }

    return {
      executionId,
      overallVerdict,
      overallConfidence: overallScore,
      scores,
      issues,
      needsLLM,
      timestamp: Date.now(),
      duration,
    };
  }

  /**
   * 检查 result 是否符合 expectedOutput:
   * - 字符串: 精确匹配或包含
   * - 对象: 检查 expectedOutput 的所有 key 是否存在于 result
   * - 数组: 检查长度是否匹配
   */
  private checkExpectedOutput(
    result: unknown,
    expected: unknown,
  ): VerificationIssue | null {
    if (typeof expected === "string") {
      const resultStr = typeof result === "string" ? result : JSON.stringify(result);
      if (!resultStr.includes(expected)) {
        return {
          type: "output",
          description: `Result does not contain expected output: "${expected.slice(0, 50)}"`,
          severity: 7,
          suggestion: "Ensure the output includes the expected content",
        };
      }
    } else if (Array.isArray(expected)) {
      const resultArr = Array.isArray(result) ? result : [];
      if (resultArr.length < expected.length) {
        return {
          type: "output",
          description: `Result array length ${resultArr.length} < expected ${expected.length}`,
          severity: 6,
          suggestion: "Ensure the output array has the expected number of items",
        };
      }
    } else if (typeof expected === "object" && expected !== null) {
      const expectedKeys = Object.keys(expected);
      if (typeof result === "object" && result !== null && !Array.isArray(result)) {
        const resultObj = result as Record<string, unknown>;
        const missingKeys = expectedKeys.filter((k) => !(k in resultObj));
        if (missingKeys.length > 0) {
          return {
            type: "output",
            description: `Result missing expected keys: ${missingKeys.join(", ")}`,
            severity: 7,
            suggestion: `Add the missing fields: ${missingKeys.join(", ")}`,
          };
        }
      } else {
        return {
          type: "output",
          description: "Expected object output but result is not an object",
          severity: 7,
          suggestion: "Ensure the result is a structured object",
        };
      }
    }
    return null;
  }

  /**
   * 证据验证 — 检查 result 是否包含证据引用
   * 字符串: 检查关键词 (evidence/source/node_id/参考)
   * 对象: 检查 evidence/sources/references/citations 字段
   */
  private checkEvidence(
    result: unknown,
    issues: VerificationIssue[],
    currentScore: number,
  ): number {
    if (typeof result === "string") {
      const hasEvidence = result.includes("evidence") || result.includes("source") ||
        result.includes("node_id") || result.includes("参考");
      if (!hasEvidence) {
        issues.push({
          type: "evidence",
          description: "Result lacks citations or evidence references",
          severity: 4,
          suggestion: "Include source references or knowledge node IDs",
        });
        return 0.3;
      }
      return currentScore;
    }

    if (typeof result === "object" && result !== null && !Array.isArray(result)) {
      const obj = result as Record<string, unknown>;
      const evidenceFields = ["evidence", "sources", "references", "citations", "evidence_refs"];
      const hasEvidence = evidenceFields.some(
        (f) => f in obj && obj[f] != null && (Array.isArray(obj[f]) ? obj[f].length > 0 : true),
      );
      if (!hasEvidence) {
        issues.push({
          type: "evidence",
          description: "Result object lacks evidence references (expected one of: evidence, sources, references, citations)",
          severity: 4,
          suggestion: "Add an evidence/sources/references field with source node IDs",
        });
        return 0.3;
      }
      return currentScore;
    }

    return currentScore;
  }

  /**
   * 快速验证 (仅检查输出完整性)
   */
  quickVerify(output: unknown): Verdict {
    if (output == null) return "fail";
    if (typeof output === "string" && output.length === 0) return "fail";
    if (typeof output === "object" && Object.keys(output as object).length === 0) return "uncertain";
    return "pass";
  }

  /**
   * 获取统计
   */
  getStats() {
    return { ...this.stats };
  }

  /**
   * 更新配置
   */
  updateConfig(config: Partial<VerificationConfig>): void {
    this.config = { ...this.config, ...config };
  }
}

/** 全局单例 */
export const verificationEngine = new VerificationEngineImpl();
