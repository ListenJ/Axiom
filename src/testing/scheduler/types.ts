/**
 * PCDA 调度器 — 类型定义
 *
 * PCDA 循环（Plan-Do-Check-Act）：
 *   Plan  → 定义测试矩阵（场景×并发级别×节点分配）
 *   Do    → 分发任务到各节点，并发执行
 *   Check → 收集结果，检测幻觉/串词/性能退化
 *   Act   → 根据结果决定：升级负载 / 降级重试 / 标记通过 / 标记失败
 */

import type { ScenarioType, TestTask, TestResult, TestNodeConfig } from "../cluster/types.js";

// ═══════════════════════════════════════════════════════════════
// PCDA 阶段
// ═══════════════════════════════════════════════════════════════

/** PCDA 四阶段 */
export type PCDAPhase = "plan" | "do" | "check" | "act";

/** 阶段状态 */
export type PhaseStatus = "pending" | "in_progress" | "completed" | "failed";

/** PCDA 循环状态 */
export type CycleStatus = "running" | "completed" | "failed" | "aborted";

// ═══════════════════════════════════════════════════════════════
// Plan 阶段
// ═══════════════════════════════════════════════════════════════

/** 负载级别（递增式压测） */
export interface LoadLevel {
  /** 级别名称 */
  name: string;
  /** 级别序号（1=最低） */
  level: number;
  /** 每节点并发用户数 */
  concurrencyPerNode: number;
  /** 每用户请求数 */
  requestsPerUser: number;
  /** 预期最大响应时间 (ms) */
  expectedMaxResponseMs: number;
  /** 幻觉率阈值（超过则降级） */
  hallucinationThreshold: number;
  /** 串词率阈值 */
  crossTalkThreshold: number;
  /** 错误率阈值 */
  errorRateThreshold: number;
}

/** 预定义负载级别（渐进式） */
export const LOAD_LEVELS: LoadLevel[] = [
  {
    name: "warmup",
    level: 1,
    concurrencyPerNode: 2,
    requestsPerUser: 5,
    expectedMaxResponseMs: 100,
    hallucinationThreshold: 0.0,
    crossTalkThreshold: 0.0,
    errorRateThreshold: 0.0,
  },
  {
    name: "normal",
    level: 2,
    concurrencyPerNode: 5,
    requestsPerUser: 10,
    expectedMaxResponseMs: 50,
    hallucinationThreshold: 0.05,
    crossTalkThreshold: 0.02,
    errorRateThreshold: 0.01,
  },
  {
    name: "high",
    level: 3,
    concurrencyPerNode: 10,
    requestsPerUser: 20,
    expectedMaxResponseMs: 30,
    hallucinationThreshold: 0.1,
    crossTalkThreshold: 0.05,
    errorRateThreshold: 0.02,
  },
  {
    name: "extreme",
    level: 4,
    concurrencyPerNode: 20,
    requestsPerUser: 50,
    expectedMaxResponseMs: 20,
    hallucinationThreshold: 0.15,
    crossTalkThreshold: 0.1,
    errorRateThreshold: 0.05,
  },
];

/** 测试计划 */
export interface TestPlan {
  /** 计划 ID */
  planId: string;
  /** 负载级别 */
  loadLevel: LoadLevel;
  /** 要执行的场景 */
  scenarios: ScenarioType[];
  /** 可用节点列表 */
  nodes: TestNodeConfig[];
  /** 生成的任务列表 */
  tasks: TestTask[];
  /** 计划创建时间 */
  createdAt: number;
}

// ═══════════════════════════════════════════════════════════════
// Check 阶段
// ═══════════════════════════════════════════════════════════════

/** 检查结果 */
export interface CheckResult {
  /** 所有任务结果 */
  results: TestResult[];
  /** 聚合指标 */
  aggregated: AggregatedMetrics;
  /** 检测到的问题 */
  issues: CheckIssue[];
  /** 是否通过 */
  passed: boolean;
}

/** 聚合指标（跨节点汇总） */
export interface AggregatedMetrics {
  /** 总请求数（所有节点之和） */
  totalRequests: number;
  /** 总成功数 */
  totalSuccess: number;
  /** 总失败数 */
  totalFailures: number;
  /** 平均响应时间 */
  avgResponseMs: number;
  /** P95 响应时间 */
  p95ResponseMs: number;
  /** P99 响应时间 */
  p99ResponseMs: number;
  /** 总吞吐量 */
  totalThroughput: number;
  /** 幻觉率（所有节点加权平均） */
  hallucinationRate: number;
  /** 串词率 */
  crossTalkRate: number;
  /** 错误率 */
  errorRate: number;
  /** 每节点指标 */
  perNode: Array<{ nodeId: string; metrics: TestResult["metrics"] }>;
}

/** 检查发现的问题 */
export interface CheckIssue {
  type: "hallucination" | "cross-talk" | "performance" | "error-rate" | "timeout" | "node-offline";
  severity: "low" | "medium" | "high" | "critical";
  message: string;
  nodeId?: string;
  taskId?: string;
  /** 实际值 */
  actualValue?: number;
  /** 阈值 */
  threshold?: number;
}

// ═══════════════════════════════════════════════════════════════
// Act 阶段
// ═══════════════════════════════════════════════════════════════

/** Act 决策类型 */
export type ActionType =
  | "escalate"    // 升级到下一负载级别
  | "retry"       // 同级别重试
  | "degrade"     // 降级到上一级别
  | "pass"        // 全部通过，结束
  | "fail"        // 严重问题，终止
  | "abort";      // 人工干预

/** Act 决策 */
export interface ActDecision {
  action: ActionType;
  reason: string;
  /** 下一负载级别（action=escalate/degrade 时） */
  nextLoadLevel?: LoadLevel;
  /** 参数调整建议 */
  adjustments?: Record<string, unknown>;
}

// ═══════════════════════════════════════════════════════════════
// PCDA 循环
// ═══════════════════════════════════════════════════════════════

/** 单次 PCDA 循环 */
export interface PCDACycle {
  /** 循环 ID */
  cycleId: number;
  /** 当前阶段 */
  currentPhase: PCDAPhase;
  /** 循环状态 */
  status: CycleStatus;
  /** 开始时间 */
  startedAt: number;
  /** 结束时间 */
  endedAt?: number;
  /** Plan 阶段产出 */
  plan?: TestPlan;
  /** Check 阶段产出 */
  checkResult?: CheckResult;
  /** Act 阶段产出 */
  decision?: ActDecision;
  /** 各阶段状态 */
  phaseStatus: Record<PCDAPhase, PhaseStatus>;
}

/** PCDA 运行配置 */
export interface PCDAConfig {
  /** 初始负载级别序号（默认 1=warmup） */
  initialLoadLevel: number;
  /** 最大循环次数 */
  maxCycles: number;
  /** 每循环超时 (ms) */
  cycleTimeout: number;
  /** 是否在通过后自动升级 */
  autoEscalate: boolean;
  /** 最大负载级别序号 */
  maxLoadLevel: number;
  /** 场景列表 */
  scenarios: ScenarioType[];
  /** 自定义负载级别（覆盖默认） */
  customLoadLevels?: LoadLevel[];
}

/** 默认 PCDA 配置 */
export const DEFAULT_PCDA_CONFIG: PCDAConfig = {
  initialLoadLevel: 1,
  maxCycles: 10,
  cycleTimeout: 120000,
  autoEscalate: true,
  maxLoadLevel: 4,
  scenarios: ["hallucination", "cross-talk", "concurrent-load"],
};
