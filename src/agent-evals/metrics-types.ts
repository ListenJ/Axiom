/**
 * 评测结果入库共享类型 — 与 metrics.ts 解耦（registry 不依赖 metrics，避免循环引用）。
 *
 * 落行前显式把 TaskResult / MetricsSummary 抽取为存储形态（StoredTaskResult /
 * RunSummarySnapshot），隔离外部类型变化对 DB 层的影响。
 */
import type { TaskFamily } from "./tasks.js";

/** 单任务结果的存储形态（从 metrics.TaskResult 显式抽取） */
export interface StoredTaskResult {
  taskId: string;
  family: TaskFamily;
  split: "train" | "held-out";
  passed: boolean;
  reason?: string;
  latencyMs: number;
  outputLength: number;
  model?: string;
  injectedSkills?: string[];
  /** 执行错误（限流/传输等 provider 侧故障，非能力失败） */
  executionError?: boolean;
}

/** 单族统计（与 metrics.FamilyMetrics 同构，独立定义） */
export interface FamilySnapshot {
  total: number;
  passed: number;
  passRate: number; // 0-100
  /** 本族执行错误数 */
  executionErrors?: number;
}

/** 一轮评测 summary 的存储形态（与 metrics.MetricsSummary 同构，独立定义） */
export interface RunSummarySnapshot {
  total: number;
  passed: number;
  passRate: number;
  byFamily: Record<string, FamilySnapshot>;
  trainRate: number;
  heldOutRate: number;
  generalizationRatio: number | null;
  avgLatencyMs: number;
  avgOutputLength: number;
  /** 执行错误数（限流/传输等 provider 侧故障，非能力失败） */
  executionErrors?: number;
}

/** listRuns / getTrend 过滤条件 */
export interface RunFilter {
  family?: string;
  model?: string;
  limit?: number;
}

/** insertRun 元数据输入（除 summary/tasks 外的一轮属性） */
export interface RunMetadata {
  runTag: string;
  startedAt?: string;
  finishedAt?: string;
  model?: string;
  provider?: string;
  familyFilter?: string;
  splitFilter?: string;
  rerunEach?: number;
  evolvePhase?: string;
  gitCommit?: string;
  srcArgv?: string;
  srcDoc?: string;
  exitCode?: number;
}

/** 单轮运行（DB 行形态，查询返回） */
export interface RunRow {
  id: number;
  runTag: string;
  startedAt: string;
  finishedAt: string | null;
  model: string | null;
  provider: string | null;
  familyFilter: string | null;
  splitFilter: string | null;
  rerunEach: number;
  evolvePhase: string | null;
  gitCommit: string | null;
  srcArgv: string | null;
  srcDoc: string | null;
  summaryTotal: number;
  summaryPassed: number;
  summaryPassRate: number;
  summaryTrainRate: number;
  summaryHeldOutRate: number;
  summaryGeneralization: number | null;
  summaryAvgLatencyMs: number;
  summaryAvgOutputLen: number;
  summaryByFamily: Record<string, FamilySnapshot>;
  /** 本轮执行错误数（限流/传输等 provider 侧故障，非能力失败） */
  summaryExecutionErrors: number;
  exitCode: number | null;
}

/** 单任务结果行（DB 行形态，查询返回） */
export interface StoredTaskRow {
  id: number;
  runId: number;
  taskId: string;
  family: TaskFamily;
  split: "train" | "held-out";
  passed: boolean;
  reason: string | null;
  latencyMs: number;
  outputLen: number;
  model: string | null;
  injectedSkills: string[];
  /** 该任务是否执行错误（限流/传输等 provider 侧故障，非能力失败） */
  executionError: boolean;
}

/** compare(a, b) 的返回：两轮 summary 与分族差异 */
export interface RunComparison {
  a: RunRow;
  b: RunRow;
  summaryDiff: {
    passRate: number; // b.passRate - a.passRate
    totalDiff: number;
    generalizationDiff: number | null;
    avgLatencyDiff: number;
  };
  familyDiffs: Array<{
    family: string;
    a: FamilySnapshot | null;
    b: FamilySnapshot | null;
    passRateDiff: number | null; // b - a
  }>;
}
