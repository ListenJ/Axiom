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
}

export interface FamilyMetrics {
  total: number;
  passed: number;
  passRate: number; // 0-100
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
}

export function summarize(results: TaskResult[]): MetricsSummary {
  const byFamily: Record<string, FamilyMetrics> = {};
  for (const r of results) {
    const f = (byFamily[r.family] ??= { total: 0, passed: 0, passRate: 0 });
    f.total++;
    if (r.passed) f.passed++;
    f.passRate = Math.round((f.passed / f.total) * 1000) / 10;
  }
  const passed = results.filter((r) => r.passed).length;
  const train = results.filter((r) => r.split === "train");
  const heldOut = results.filter((r) => r.split === "held-out");
  const rate = (arr: TaskResult[]) =>
    arr.length === 0 ? 0 : Math.round((arr.filter((r) => r.passed).length / arr.length) * 1000) / 10;
  const trainRate = rate(train);
  const heldOutRate = rate(heldOut);
  return {
    total: results.length,
    passed,
    passRate: results.length === 0 ? 0 : Math.round((passed / results.length) * 1000) / 10,
    byFamily,
    trainRate,
    heldOutRate,
    generalizationRatio: trainRate === 0 ? null : Math.round((heldOutRate / trainRate) * 1000) / 1000,
    avgLatencyMs: results.length === 0 ? 0 : Math.round(results.reduce((a, b) => a + b.latencyMs, 0) / results.length),
    avgOutputLength: results.length === 0 ? 0 : Math.round(results.reduce((a, b) => a + b.outputLength, 0) / results.length),
  };
}
