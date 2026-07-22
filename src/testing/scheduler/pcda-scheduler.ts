/**
 * PCDA 循环调度器 —— 编排整个分布式测试执行流程
 *
 * Plan-Do-Check-Act 四阶段循环：
 *   Plan  → 根据 当前负载级别 × 场景 × 节点 生成测试任务矩阵
 *   Do    → 通过 ClusterCoordinator 分发任务到各节点并发执行
 *   Check → 聚合跨节点指标，对照阈值检测幻觉/串词/性能/错误问题
 *   Act   → 依据问题严重度决策：升级 / 重试 / 降级 / 通过 / 失败 / 中止
 */

import { logger } from "../../utils/logger.js";
import type {
  ClusterConfig,
  TestTask,
  TestResult,
  ScenarioType,
} from "../cluster/types.js";
import {
  LOAD_LEVELS,
  type PCDACycle,
  type TestPlan,
  type LoadLevel,
  type CheckResult,
  type CheckIssue,
  type ActDecision,
  type AggregatedMetrics,
  type PCDAConfig,
} from "./types.js";

/** 问题严重度等级 */
type Severity = CheckIssue["severity"];

export class PCDAScheduler {
  private readonly config: PCDAConfig;
  private readonly clusterConfig: ClusterConfig;
  /** 负载级别序列（来自 config.customLoadLevels 或默认 LOAD_LEVELS） */
  private readonly loadLevels: LoadLevel[];
  /** 当前负载级别在 loadLevels 数组中的索引 */
  private currentLoadLevelIndex: number;
  /** 已完成循环计数器（也是下一个循环的 cycleId） */
  private cycleCounter: number;
  /** 所有已完成循环的记录 */
  private readonly cycles: PCDACycle[] = [];

  constructor(config: PCDAConfig, clusterConfig: ClusterConfig) {
    this.config = config;
    this.clusterConfig = clusterConfig;
    this.cycleCounter = 0;
    this.loadLevels = config.customLoadLevels ?? LOAD_LEVELS;
    const idx = this.loadLevels.findIndex((l) => l.level === config.initialLoadLevel);
    this.currentLoadLevelIndex = idx >= 0 ? idx : 0;
  }

  /**
   * 主入口：循环运行 PCDA 周期，直到满足终止条件
   *  - 所有负载级别通过（autoEscalate=true 时逐级升级到顶）
   *  - 达到 maxCycles
   *  - 某周期出现 critical 问题（fail）
   *  - 某周期被中止（abort）
   */
  async run(): Promise<PCDACycle[]> {
    while (this.cycleCounter < this.config.maxCycles) {
      const cycle = await this.runCycle();
      this.cycles.push(cycle);

      const decision = cycle.decision;
      if (!decision) {
        // 周期异常中断（无决策产出）
        logger.warn("PCDA run terminated: cycle produced no decision", {
          cycleId: cycle.cycleId,
          status: cycle.status,
        });
        break;
      }

      if (decision.action === "fail") {
        logger.warn("PCDA run terminated: critical issues detected", {
          cycleId: cycle.cycleId,
          reason: decision.reason,
        });
        break;
      }
      if (decision.action === "abort") {
        logger.warn("PCDA run aborted", {
          cycleId: cycle.cycleId,
          reason: decision.reason,
        });
        break;
      }
      if (decision.action === "pass") {
        logger.info("PCDA run completed: all load levels passed", {
          cycleId: cycle.cycleId,
          reason: decision.reason,
        });
        break;
      }

      // escalate / degrade：切换到下一负载级别
      if (decision.nextLoadLevel) {
        const nextIdx = this.loadLevels.findIndex(
          (l) => l.level === decision.nextLoadLevel!.level,
        );
        if (nextIdx >= 0) {
          this.currentLoadLevelIndex = nextIdx;
        }
      }
      // retry：保持当前级别，进入下一循环
    }

    return this.cycles;
  }

  /** 运行单次 PCDA 循环（依次走 Plan → Do → Check → Act） */
  async runCycle(): Promise<PCDACycle> {
    this.cycleCounter += 1;
    const cycleId = this.cycleCounter;
    const loadLevel = this.getCurrentLoadLevel();

    const cycle: PCDACycle = {
      cycleId,
      currentPhase: "plan",
      status: "running",
      startedAt: Date.now(),
      phaseStatus: {
        plan: "pending",
        do: "pending",
        check: "pending",
        act: "pending",
      },
    };

    logger.info("PCDA cycle started", { cycleId, loadLevel: loadLevel.name });

    try {
      // ── Plan ──
      cycle.currentPhase = "plan";
      cycle.phaseStatus.plan = "in_progress";
      const plan = await this.plan(loadLevel);
      cycle.plan = plan;
      cycle.phaseStatus.plan = "completed";

      // ── Do ──
      cycle.currentPhase = "do";
      cycle.phaseStatus.do = "in_progress";
      const results = await this.do(plan);
      cycle.phaseStatus.do = "completed";

      // ── Check ──
      cycle.currentPhase = "check";
      cycle.phaseStatus.check = "in_progress";
      const checkResult = this.check(results, loadLevel);
      cycle.checkResult = checkResult;
      cycle.phaseStatus.check = "completed";

      // ── Act ──
      cycle.currentPhase = "act";
      cycle.phaseStatus.act = "in_progress";
      const decision = this.act(checkResult, loadLevel);
      cycle.decision = decision;
      cycle.phaseStatus.act = "completed";

      // 依据决策设定周期状态
      if (decision.action === "fail") {
        cycle.status = "failed";
      } else if (decision.action === "abort") {
        cycle.status = "aborted";
      } else {
        cycle.status = "completed";
      }

      logger.info("PCDA cycle finished", {
        cycleId,
        loadLevel: loadLevel.name,
        action: decision.action,
        passed: checkResult.passed,
        issueCount: checkResult.issues.length,
      });
    } catch (err) {
      cycle.status = "failed";
      cycle.phaseStatus[cycle.currentPhase] = "failed";
      const errorObj = err instanceof Error ? err : new Error(String(err));
      logger.error("PCDA cycle failed unexpectedly", errorObj, {
        cycleId,
        phase: cycle.currentPhase,
      });
    }

    cycle.endedAt = Date.now();
    return cycle;
  }

  /**
   * Plan 阶段：为 当前负载级别 × 场景 × 节点 生成测试任务矩阵
   * 任务超时 = globalTimeout / 总任务数
   * 优先级：hallucination=1, cross-talk=2, concurrent-load=3，其余递增
   */
  async plan(loadLevel: LoadLevel): Promise<TestPlan> {
    const tasks: TestTask[] = [];
    const totalTasks = this.config.scenarios.length * this.clusterConfig.nodes.length;
    const timeout =
      totalTasks > 0
        ? Math.floor(this.clusterConfig.globalTimeout / totalTasks)
        : this.clusterConfig.globalTimeout;

    for (const scenario of this.config.scenarios) {
      const priority = this.getScenarioPriority(scenario);
      for (const node of this.clusterConfig.nodes) {
        const task: TestTask = {
          id: `task-${this.cycleCounter}-${scenario}-${node.id}`,
          scenario,
          name: `${scenario} @ ${loadLevel.name} on ${node.id}`,
          concurrency: loadLevel.concurrencyPerNode,
          requestsPerUser: loadLevel.requestsPerUser,
          timeout,
          assignedNodeId: node.id,
          params: {
            loadLevel: loadLevel.name,
            loadLevelNumber: loadLevel.level,
            concurrencyPerNode: loadLevel.concurrencyPerNode,
            requestsPerUser: loadLevel.requestsPerUser,
            expectedMaxResponseMs: loadLevel.expectedMaxResponseMs,
          },
          priority,
        };
        tasks.push(task);
      }
    }

    return {
      planId: `plan-${this.cycleCounter}-${loadLevel.name}`,
      loadLevel,
      scenarios: [...this.config.scenarios],
      nodes: [...this.clusterConfig.nodes],
      tasks,
      createdAt: Date.now(),
    };
  }

  /**
   * Do 阶段：动态导入 ClusterCoordinator 并分发全部任务
   * 协调器失败时返回空结果（错误已记录日志，Check 阶段会据此判定 node-offline）
   */
  async do(plan: TestPlan): Promise<TestResult[]> {
    try {
      // @ts-ignore — coordinator 由并行开发的其他 agent 提供，存在性不保证；
      //   用 @ts-ignore 而非 @ts-expect-error：后者在 coordinator 已存在时会触发 TS2578（未使用的指令），前者两种状态均安全。
      const { ClusterCoordinator } = await import("../cluster/coordinator.js");
      const coordinator = new ClusterCoordinator(this.clusterConfig);
      const results = await coordinator.dispatch(plan.tasks);
      return results;
    } catch (err) {
      const errorObj = err instanceof Error ? err : new Error(String(err));
      logger.error(
        "Failed to dispatch tasks via ClusterCoordinator",
        errorObj,
        { planId: plan.planId, taskCount: plan.tasks.length },
      );
      return [];
    }
  }

  /**
   * Check 阶段：聚合跨节点指标，对照负载级别阈值检测问题
   * 严重度分级（actual/threshold 比值）：<1.5x low, 1.5-2x medium, 2-5x high, >5x critical
   * passed = 无问题 或 仅有 low 严重度问题
   */
  check(results: TestResult[], loadLevel: LoadLevel): CheckResult {
    const aggregated = this.aggregateMetrics(results);
    const issues: CheckIssue[] = [];

    const reportingNodeIds = new Set(results.map((r) => r.nodeId));

    // 节点缺失检测
    if (results.length === 0) {
      issues.push({
        type: "node-offline",
        severity: "critical",
        message: "No test results received — all nodes failed to respond",
      });
    } else {
      for (const node of this.clusterConfig.nodes) {
        if (!reportingNodeIds.has(node.id)) {
          issues.push({
            type: "node-offline",
            severity: "high",
            message: `Node ${node.id} did not report any results`,
            nodeId: node.id,
          });
        }
      }
    }

    // 阈值检测（仅在有请求时进行）
    if (aggregated.totalRequests > 0) {
      if (aggregated.hallucinationRate > loadLevel.hallucinationThreshold) {
        issues.push({
          type: "hallucination",
          severity: this.severityFor(
            aggregated.hallucinationRate,
            loadLevel.hallucinationThreshold,
          ),
          message: `Hallucination rate ${aggregated.hallucinationRate.toFixed(4)} exceeds threshold ${loadLevel.hallucinationThreshold}`,
          actualValue: aggregated.hallucinationRate,
          threshold: loadLevel.hallucinationThreshold,
        });
      }
      if (aggregated.crossTalkRate > loadLevel.crossTalkThreshold) {
        issues.push({
          type: "cross-talk",
          severity: this.severityFor(
            aggregated.crossTalkRate,
            loadLevel.crossTalkThreshold,
          ),
          message: `Cross-talk rate ${aggregated.crossTalkRate.toFixed(4)} exceeds threshold ${loadLevel.crossTalkThreshold}`,
          actualValue: aggregated.crossTalkRate,
          threshold: loadLevel.crossTalkThreshold,
        });
      }
      if (aggregated.errorRate > loadLevel.errorRateThreshold) {
        issues.push({
          type: "error-rate",
          severity: this.severityFor(
            aggregated.errorRate,
            loadLevel.errorRateThreshold,
          ),
          message: `Error rate ${aggregated.errorRate.toFixed(4)} exceeds threshold ${loadLevel.errorRateThreshold}`,
          actualValue: aggregated.errorRate,
          threshold: loadLevel.errorRateThreshold,
        });
      }
      if (aggregated.p95ResponseMs > loadLevel.expectedMaxResponseMs) {
        issues.push({
          type: "performance",
          severity: this.severityFor(
            aggregated.p95ResponseMs,
            loadLevel.expectedMaxResponseMs,
          ),
          message: `P95 response ${aggregated.p95ResponseMs}ms exceeds expected max ${loadLevel.expectedMaxResponseMs}ms`,
          actualValue: aggregated.p95ResponseMs,
          threshold: loadLevel.expectedMaxResponseMs,
        });
      }
    }

    // 单任务失败 / 超时检测
    for (const r of results) {
      if (r.status === "failed") {
        issues.push({
          type: "node-offline",
          severity: "high",
          message: `Task ${r.taskId} on node ${r.nodeId} failed`,
          nodeId: r.nodeId,
          taskId: r.taskId,
        });
      }
      if (r.status === "timeout") {
        issues.push({
          type: "timeout",
          severity: "high",
          message: `Task ${r.taskId} on node ${r.nodeId} timed out`,
          nodeId: r.nodeId,
          taskId: r.taskId,
        });
      }
      for (const e of r.errors) {
        if (e.type === "timeout") {
          issues.push({
            type: "timeout",
            severity: "medium",
            message: e.message,
            nodeId: r.nodeId,
            taskId: r.taskId,
          });
        }
      }
    }

    const passed =
      issues.length === 0 || issues.every((i) => i.severity === "low");

    return { results, aggregated, issues, passed };
  }

  /**
   * Act 阶段：依据 Check 结果决策下一步动作
   *  - critical 问题 → fail
   *  - high 问题 → degrade（回退一级；已在最低级则 abort）
   *  - medium 问题且当前循环 > 2 → retry
   *  - low 或无问题 → escalate（未到顶且 autoEscalate）/ pass
   */
  act(checkResult: CheckResult, loadLevel: LoadLevel): ActDecision {
    const hasCritical = checkResult.issues.some((i) => i.severity === "critical");
    const hasHigh = checkResult.issues.some((i) => i.severity === "high");
    const hasMedium = checkResult.issues.some((i) => i.severity === "medium");

    if (hasCritical) {
      const types = checkResult.issues
        .filter((i) => i.severity === "critical")
        .map((i) => i.type)
        .join(", ");
      return {
        action: "fail",
        reason: `Critical issues detected: ${types}`,
      };
    }

    if (hasHigh) {
      const prevLevel = this.getPreviousLoadLevel(loadLevel);
      if (!prevLevel) {
        return {
          action: "abort",
          reason:
            "High severity issues at minimum load level — cannot degrade further, requires intervention",
        };
      }
      return {
        action: "degrade",
        reason: "High severity issues detected, degrading load level",
        nextLoadLevel: prevLevel,
      };
    }

    if (hasMedium && this.cycleCounter > 2) {
      return {
        action: "retry",
        reason: "Medium severity issues detected, retrying current load level",
      };
    }

    // 仅 low 或无问题
    if (this.config.autoEscalate && loadLevel.level < this.config.maxLoadLevel) {
      const nextLevel = this.getNextLoadLevel(loadLevel);
      if (nextLevel) {
        return {
          action: "escalate",
          reason: `Current load level passed, escalating to ${nextLevel.name}`,
          nextLoadLevel: nextLevel,
        };
      }
    }

    return {
      action: "pass",
      reason: "All load levels passed or max load level reached",
    };
  }

  /** 返回当前负载级别 */
  getCurrentLoadLevel(): LoadLevel {
    return this.loadLevels[this.currentLoadLevelIndex] ?? this.loadLevels[0];
  }

  /** 返回所有已完成循环 */
  getCycles(): PCDACycle[] {
    return this.cycles;
  }

  /**
   * 聚合多节点测试指标
   *  - 总量类指标直接求和
   *  - 响应时间、各类率值按 totalRequests 加权平均
   *  - p95 / p99 取各节点最大值（保守估计）
   */
  aggregateMetrics(results: TestResult[]): AggregatedMetrics {
    const perNode = results.map((r) => ({ nodeId: r.nodeId, metrics: r.metrics }));

    const totalRequests = results.reduce(
      (s, r) => s + r.metrics.totalRequests,
      0,
    );
    const totalSuccess = results.reduce(
      (s, r) => s + r.metrics.successCount,
      0,
    );
    const totalFailures = results.reduce(
      (s, r) => s + r.metrics.failureCount,
      0,
    );

    const weightedAvg = (selector: (m: TestResult["metrics"]) => number): number => {
      if (totalRequests <= 0) return 0;
      const sum = results.reduce(
        (s, r) => s + selector(r.metrics) * r.metrics.totalRequests,
        0,
      );
      return sum / totalRequests;
    };

    const avgResponseMs = weightedAvg((m) => m.avgResponseMs);
    const hallucinationRate = weightedAvg((m) => m.hallucinationRate ?? 0);
    const crossTalkRate = weightedAvg((m) => m.crossTalkRate ?? 0);
    const errorRate = weightedAvg((m) => m.errorRate);

    const p95ResponseMs = results.reduce(
      (m, r) => Math.max(m, r.metrics.p95ResponseMs),
      0,
    );
    const p99ResponseMs = results.reduce(
      (m, r) => Math.max(m, r.metrics.p99ResponseMs),
      0,
    );
    const totalThroughput = results.reduce(
      (s, r) => s + r.metrics.throughput,
      0,
    );

    return {
      totalRequests,
      totalSuccess,
      totalFailures,
      avgResponseMs,
      p95ResponseMs,
      p99ResponseMs,
      totalThroughput,
      hallucinationRate,
      crossTalkRate,
      errorRate,
      perNode,
    };
  }

  // ── 私有辅助方法 ──

  /** 依据实际值与阈值的比值判定严重度 */
  private severityFor(actual: number, threshold: number): Severity {
    if (threshold <= 0) {
      // 零阈值（如 warmup）：任何超出都至少 medium
      if (actual <= 0) return "low";
      if (actual > 0.5) return "critical";
      if (actual > 0.2) return "high";
      return "medium";
    }
    const ratio = actual / threshold;
    if (ratio > 5) return "critical";
    if (ratio > 2) return "high";
    if (ratio >= 1.5) return "medium";
    return "low";
  }

  /** 场景优先级映射 */
  private getScenarioPriority(scenario: ScenarioType): number {
    switch (scenario) {
      case "hallucination":
        return 1;
      case "cross-talk":
        return 2;
      case "concurrent-load":
        return 3;
      case "stress":
        return 4;
      case "custom":
        return 5;
      default:
        return 10;
    }
  }

  /** 取上一级负载级别（已在中最低级则返回 undefined） */
  private getPreviousLoadLevel(current: LoadLevel): LoadLevel | undefined {
    const idx = this.loadLevels.findIndex((l) => l.level === current.level);
    if (idx <= 0) return undefined;
    return this.loadLevels[idx - 1];
  }

  /** 取下一级负载级别（已在最高级则返回 undefined） */
  private getNextLoadLevel(current: LoadLevel): LoadLevel | undefined {
    const idx = this.loadLevels.findIndex((l) => l.level === current.level);
    if (idx < 0 || idx >= this.loadLevels.length - 1) return undefined;
    return this.loadLevels[idx + 1];
  }
}
