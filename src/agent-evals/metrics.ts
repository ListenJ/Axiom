/**
 * Agent 评测指标聚合 — 全局/分族/分 split 成功率 + held-out 泛化率 + 成本/Token 维度 + 延迟分位。
 */
import type { TaskFamily } from "./tasks.js";

/** provider 返回的 token 用量（OpenAI 兼容 usage；直连路径解析响应体，internalAgent 路径取 usage） */
export interface TokenUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

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
  /** 本次调用的 token 用量（provider 未返回时缺失；不阻断评测） */
  tokenUsage?: TokenUsage;
  /** 本次调用估算成本（美元；仅 internalAgent 路径可能提供，直连路径按 token 数展示） */
  costUsd?: number;
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
  /** 延迟分位（ms）：nearest-rank，见 percentileOf 口径说明 */
  latencyP50: number | null;
  latencyP95: number | null;
  latencyP99: number | null;
  avgOutputLength: number;
  /** 执行错误数（限流/传输等 provider 侧故障，非能力失败） */
  executionErrors: number;
  /** 成本/Token 维度：无任何成本数据时为 null（不阻断旧调用方），有部分数据时按有数据的样本平均 */
  totalCostUsd: number | null;
  avgCostUsd: number | null;
  avgPromptTokens: number | null;
  avgCompletionTokens: number | null;
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
  // 成本/Token 维度：按「有该字段数据」的样本聚合；全部缺失时为 null（不阻断旧调用方）。
  // 口径：成本与 token 消耗计入全部样本（含执行错误——限流/传输也会计费），不做能力分母剔除。
  const costed = results.filter((r) => typeof r.costUsd === "number");
  const tokened = results.filter((r) => r.tokenUsage && typeof r.tokenUsage.promptTokens === "number");
  const completionTokened = results.filter((r) => r.tokenUsage && typeof r.tokenUsage.completionTokens === "number");
  const totalCostUsd = costed.length === 0 ? null : round4(costed.reduce((a, b) => a + (b.costUsd as number), 0));
  const avgCostUsd = costed.length === 0 ? null : round4(totalCostUsd! / costed.length);
  // 延迟分位：全样本（含执行错误）升序取 nearest-rank，口径与 avgLatencyMs 一致。
  // n < 3 时 p95/p99 无统计意义回退 null；p50 为序统计量，n >= 1 始终有效。
  const latencies = results.map((r) => r.latencyMs).sort((a, b) => a - b);
  return {
    total: results.length,
    passed,
    passRate: capabilityTotal <= 0 ? 0 : Math.round((passed / capabilityTotal) * 1000) / 10,
    byFamily,
    trainRate,
    heldOutRate,
    generalizationRatio: trainRate === 0 ? null : Math.round((heldOutRate / trainRate) * 1000) / 1000,
    avgLatencyMs: results.length === 0 ? 0 : Math.round(results.reduce((a, b) => a + b.latencyMs, 0) / results.length),
    latencyP50: percentileOf(latencies, 50),
    latencyP95: percentileOf(latencies, 95, 3),
    latencyP99: percentileOf(latencies, 99, 3),
    avgOutputLength: results.length === 0 ? 0 : Math.round(results.reduce((a, b) => a + b.outputLength, 0) / results.length),
    executionErrors,
    totalCostUsd,
    avgCostUsd,
    avgPromptTokens: tokened.length === 0 ? null : Math.round(tokened.reduce((a, b) => a + (b.tokenUsage!.promptTokens as number), 0) / tokened.length),
    avgCompletionTokens:
      completionTokened.length === 0 ? null : Math.round(completionTokened.reduce((a, b) => a + (b.tokenUsage!.completionTokens as number), 0) / completionTokened.length),
  };
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

/**
 * nearest-rank 分位：输入须为升序数组，索引 = ceil(p/100 * n) - 1。
 *
 * 口径（计划 S2）：
 * - 分位对全部样本（含执行错误）计算——延迟是 provider 侧真实感知，与能力成败无关，与 avgLatencyMs 一致。
 * - p50 为序统计量，n >= 1 始终有效。
 * - 样本 n < 3 时 p95/p99 回退 null（样本太少无统计意义）；计划允许「回退 max 或 null」，此处取 null。
 * - 空数组所有分位为 null。
 */
function percentileOf(sortedAsc: number[], p: number, minSamples = 1): number | null {
  const n = sortedAsc.length;
  if (n < minSamples) return null;
  const rank = Math.ceil((p / 100) * n);
  return sortedAsc[rank - 1] ?? null;
}

/**
 * 是否存在真实能力失败（非执行错误）：与 passRate 能力口径一致。
 * 执行错误（限流/传输等 provider 侧故障）不计为失败——run.ts 退出码用它判定，
 * 避免「一次限流让整场 eval 以失败退出」。全执行错误的 run 也不判失败（无能力信号）。
 */
export function hasCapabilityFailure(results: TaskResult[]): boolean {
  return results.some((r) => !r.passed && !r.executionError);
}
