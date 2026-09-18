/**
 * 分布式测试框架 — 模块入口
 *
 * 架构：
 *   src/testing/
 *   ├── cluster/       分布式测试集群（节点 + 协调器 + SSH）
 *   ├── scenarios/     测试场景（幻觉检测 + 串词检测 + 并发负载）
 *   ├── scheduler/     PCDA 循环调度器
 *   └── metrics/       指标收集与报告
 */

// ── 集群 ──────────────────────────────────────────────────────
export type {
  NodeType,
  NodeStatus,
  TestNodeConfig,
  TestNodeStatus,
  ScenarioType,
  TaskStatus,
  TestTask,
  TestResult,
  TestMetrics,
  TestError,
  ClusterConfig,
  ExecuteCommand,
  ResultReport,
  HeartbeatReport,
  ClusterMessage,
} from "./cluster/types.js";

export {
  DEFAULT_CLUSTER_CONFIG,
} from "./cluster/types.js";

export { SshExecutor, testSshConnectivity } from "./cluster/ssh-executor.js";
export { BaseTestNode, LocalTestNode, RemoteTestNode, createTestNode } from "./cluster/node.js";
export { ClusterCoordinator } from "./cluster/coordinator.js";

// ── 场景 ──────────────────────────────────────────────────────
export { runConcurrentLoad, calculatePercentiles } from "./scenarios/concurrent-load.js";
export { runHallucinationTest, DEFAULT_TEST_FACTS } from "./scenarios/hallucination-test.js";
export { runCrossTalkTest } from "./scenarios/cross-talk-test.js";

// ── 调度器 ────────────────────────────────────────────────────
export type {
  PCDAPhase,
  PhaseStatus,
  CycleStatus,
  LoadLevel,
  TestPlan,
  CheckResult,
  AggregatedMetrics,
  CheckIssue,
  ActionType,
  ActDecision,
  PCDACycle,
  PCDAConfig,
} from "./scheduler/types.js";

export {
  LOAD_LEVELS,
  DEFAULT_PCDA_CONFIG,
} from "./scheduler/types.js";

export { PCDAScheduler } from "./scheduler/pcda-scheduler.js";

// ── 指标 ──────────────────────────────────────────────────────
export { MetricsCollector } from "./metrics/collector.js";
export { DistributedTestReporter } from "./metrics/reporter.js";
