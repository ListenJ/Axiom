/**
 * Agent 评测指标聚合 — 全局/分族/分 split 成功率 + held-out 泛化率。
 */
import type { TaskFamily } from "./tasks.js";

export interface TaskResult {
  taskId: string;
  family: TaskFamily;
  split: "train" | "held-out";
  passed: boolean;
  reason?: string;
  latencyMs: number;
  outputLength: number;
  model?: string;
  /** 本次任务实际注入的 auto-* 技能 id 列表（无注入为空） */
  injectedSkills?: string[];
  /** 执行错误（限流/传输/空内容等 provider 侧故障，非能力失败）：不计入能力通过率分母 */
  executionError?: boolean;
}

export interface FamilyMetrics {
  total: number;
  passed: number;
  passRate: number; // 0-100
  /** 本族执行错误数（限流/传输等 provider 侧故障，非能力失败） */
  executionErrors: number;
}

export interface MetricsSummary {
  total: number;
  passed: number;
  passRate: number;
  byFamily: Record<string, FamilyMetrics>;
  trainRate: number;
  heldOutRate: number;
  /** held-out 成功率 / train 成功率；<1 表示过拟合训练分布 */
  generalizationRatio: number | null;
  avgLatencyMs: number;
  avgOutputLength: number;
  /** 执行错误数（限流/传输等 provider 侧故障，非能力失败） */
  executionErrors: number;
}

export function summarize(results: TaskResult[]): MetricsSummary {
  const byFamily: Record<string, FamilyMetrics> = {};
  for (const r of results) {
    const f = (byFamily[r.family] ??= { total: 0, passed: 0, passRate: 0, executionErrors: 0 });
    f.total++;
    if (r.executionError) f.executionErrors++;
    else if (r.passed) f.passed++;
    // 能力通过率：分母排除执行错误（限流/传输噪声不拉低能力基线）
    const capabilityDenom = f.total - f.executionErrors;
    f.passRate = capabilityDenom <= 0 ? 0 : Math.round((f.passed / capabilityDenom) * 1000) / 10;
  }
  const executionErrors = results.filter((r) => r.executionError).length;
  const capabilityTotal = results.length - executionErrors;
  // 与分族口径（byFamily 用 else-if 剔除执行错误）一致：执行错误样本不计入能力通过数
  const passed = results.filter((r) => r.passed && !r.executionError).length;
  const train = results.filter((r) => r.split === "train" && !r.executionError);
  const heldOut = results.filter((r) => r.split === "held-out" && !r.executionError);
  const rate = (arr: TaskResult[]) =>
    arr.length === 0 ? 0 : Math.round((arr.filter((r) => r.passed).length / arr.length) * 1000) / 10;
  const trainRate = rate(train);
  const heldOutRate = rate(heldOut);
  return {
    total: results.length,
    passed,
    passRate: capabilityTotal <= 0 ? 0 : Math.round((passed / capabilityTotal) * 1000) / 10,
    byFamily,
    trainRate,
    heldOutRate,
    generalizationRatio: trainRate === 0 ? null : Math.round((heldOutRate / trainRate) * 1000) / 1000,
    avgLatencyMs: results.length === 0 ? 0 : Math.round(results.reduce((a, b) => a + b.latencyMs, 0) / results.length),
    avgOutputLength: results.length === 0 ? 0 : Math.round(results.reduce((a, b) => a + b.outputLength, 0) / results.length),
    executionErrors,
  };
}

/**
 * 是否存在真实能力失败（非执行错误）：与 passRate 能力口径一致。
 * 执行错误（限流/传输等 provider 侧故障）不计为失败——run.ts 退出码用它判定，
 * 避免「一次限流让整场 eval 以失败退出」。全执行错误的 run 也不判失败（无能力信号）。
 */
export function hasCapabilityFailure(results: TaskResult[]): boolean {
  return results.some((r) => !r.passed && !r.executionError);
}
