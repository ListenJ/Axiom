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
  /** provider 返回的 token 用量（缺失时 null） */
  promptTokens?: number | null;
  completionTokens?: number | null;
  /** 单任务估算成本（美元；缺失时 null） */
  costUsd?: number | null;
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
  /** 成本/Token 维度（无数据时 null；可选，兼容旧调用方） */
  totalCostUsd?: number | null;
  avgCostUsd?: number | null;
  avgPromptTokens?: number | null;
  avgCompletionTokens?: number | null;
  /** 缓存命中 token（P0-A；provider 未返回时 null；可选，兼容旧调用方） */
  totalCacheHitTokens?: number | null;
  avgCacheHitTokens?: number | null;
  /** 延迟分位（ms；样本过少无有效分位时 null；可选，兼容旧调用方） */
  latencyP50?: number | null;
  latencyP95?: number | null;
  latencyP99?: number | null;
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
  /** 本轮成本/Token 聚合（DB 列，缺省 NULL） */
  summaryAvgCostUsd: number | null;
  summaryTotalCostUsd: number | null;
  /** 本轮缓存命中聚合（P0-A；DB 列，缺省 NULL） */
  summaryAvgCacheHitTokens: number | null;
  summaryTotalCacheHitTokens: number | null;
  /** 本轮延迟分位（ms；DB 列，缺省 NULL） */
  summaryLatencyP50: number | null;
  summaryLatencyP95: number | null;
  summaryLatencyP99: number | null;
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
  /** 单任务 token 用量/成本（DB 列，缺省 NULL） */
  promptTokens: number | null;
  completionTokens: number | null;
  costUsd: number | null;
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
