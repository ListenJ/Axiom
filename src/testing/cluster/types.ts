/**
 * 分布式测试集群 — 核心类型定义
 *
 * 三节点集群架构：
 *   Coordinator (本地) ──SSH──▶ Node-150 (服务器)
 *                ──SSH──▶ Node-021 (远程节点)
 *                ──本地──▶ Node-local (开发机)
 *
 * 任务分发模型：
 *   Coordinator 将 TestTask 分发给各 TestNode，收集 TestResult 汇总分析。
 */

// ═══════════════════════════════════════════════════════════════
// 节点类型
// ═══════════════════════════════════════════════════════════════

/** 节点类型 */
export type NodeType = "local" | "remote";

/** 节点状态 */
export type NodeStatus = "idle" | "busy" | "offline" | "error";

/** 测试节点配置 */
export interface TestNodeConfig {
  /** 节点 ID（唯一标识） */
  id: string;
  /** 节点名称 */
  name: string;
  /** 节点类型：本地 / 远程 */
  type: NodeType;
  /** 远程主机地址（type=remote 时必填） */
  host?: string;
  /** SSH 用户（type=remote 时必填） */
  sshUser?: string;
  /** SSH 端口（默认 22） */
  sshPort?: number;
  /** SSH 私钥路径（默认使用 ~/.ssh/id_rsa） */
  sshKeyPath?: string;
  /** 远程工作目录（默认 /tmp/openclaw-test） */
  remoteWorkDir?: string;
  /** 该节点的最大并发任务数 */
  maxConcurrency: number;
  /** 节点标签（用于任务路由，如 ["linux", "high-memory"]） */
  tags?: string[];
}

/** 节点运行时状态 */
export interface TestNodeStatus {
  nodeId: string;
  status: NodeStatus;
  /** 当前正在执行的任务数 */
  activeTasks: number;
  /** 已完成任务数 */
  completedTasks: number;
  /** 失败任务数 */
  failedTasks: number;
  /** 最后心跳时间 */
  lastHeartbeat: number;
  /** CPU 使用率 (0-1) */
  cpuUsage?: number;
  /** 内存使用率 (0-1) */
  memoryUsage?: number;
}

// ═══════════════════════════════════════════════════════════════
// 测试任务类型
// ═══════════════════════════════════════════════════════════════

/** 测试场景类型 */
export type ScenarioType =
  | "hallucination"    // 幻觉检测
  | "cross-talk"       // 对话串词检测
  | "concurrent-load"  // 并发负载
  | "stress"           // 极限压测
  | "custom";          // 自定义

/** 任务状态 */
export type TaskStatus = "pending" | "dispatched" | "running" | "completed" | "failed" | "timeout";

/** 测试任务定义 */
export interface TestTask {
  /** 任务 ID */
  id: string;
  /** 场景类型 */
  scenario: ScenarioType;
  /** 任务名称 */
  name: string;
  /** 目标节点 ID（未指定时由协调器分配） */
  assignedNodeId?: string;
  /** 并发用户数 */
  concurrency: number;
  /** 每用户请求数 */
  requestsPerUser: number;
  /** 任务超时（ms） */
  timeout: number;
  /** 场景参数 */
  params: Record<string, unknown>;
  /** 优先级（0=最高） */
  priority: number;
  /** 依赖的任务 ID（需先完成） */
  dependencies?: string[];
}

/** 测试结果 */
export interface TestResult {
  taskId: string;
  nodeId: string;
  status: TaskStatus;
  /** 总耗时 (ms) */
  durationMs: number;
  /** 场景特定指标 */
  metrics: TestMetrics;
  /** 错误信息 */
  errors: TestError[];
  /** 原始输出（可选，用于调试） */
  rawOutput?: string;
}

/** 测试指标 */
export interface TestMetrics {
  /** 总请求数 */
  totalRequests: number;
  /** 成功请求数 */
  successCount: number;
  /** 失败请求数 */
  failureCount: number;
  /** 平均响应时间 (ms) */
  avgResponseMs: number;
  /** P50 响应时间 (ms) */
  p50ResponseMs: number;
  /** P95 响应时间 (ms) */
  p95ResponseMs: number;
  /** P99 响应时间 (ms) */
  p99ResponseMs: number;
  /** 吞吐量 (req/s) */
  throughput: number;
  /** 幻觉检测：检测到的幻觉数 */
  hallucinationCount?: number;
  /** 幻觉检测：幻觉率 (0-1) */
  hallucinationRate?: number;
  /** 串词检测：检测到的串词数 */
  crossTalkCount?: number;
  /** 串词检测：串词率 (0-1) */
  crossTalkRate?: number;
  /** 错误率 (0-1) */
  errorRate: number;
}

/** 测试错误 */
export interface TestError {
  timestamp: number;
  type: "hallucination" | "cross-talk" | "timeout" | "connection" | "assertion" | "runtime";
  message: string;
  context?: Record<string, unknown>;
}

// ═══════════════════════════════════════════════════════════════
// 集群配置
// ═══════════════════════════════════════════════════════════════

/** 集群配置 */
export interface ClusterConfig {
  /** 集群名称 */
  name: string;
  /** 节点列表 */
  nodes: TestNodeConfig[];
  /** 协调器最大并发分发数 */
  maxDispatchConcurrency: number;
  /** 全局任务超时 (ms) */
  globalTimeout: number;
  /** 心跳间隔 (ms) */
  heartbeatInterval: number;
  /** 结果收集超时 (ms) */
  resultCollectionTimeout: number;
}

/** 预定义的三节点集群配置 */
export const DEFAULT_CLUSTER_CONFIG: ClusterConfig = {
  name: "openclaw-distributed-test",
  nodes: [
    {
      id: "local",
      name: "Local Dev Machine",
      type: "local",
      maxConcurrency: 8,
      tags: ["local", "dev"],
    },
    {
      id: "node-150",
      name: "Server 192.168.0.150",
      type: "remote",
      host: "192.168.0.150",
      sshUser: "data",
      sshPort: 22,
      remoteWorkDir: "/tmp/openclaw-test",
      maxConcurrency: 16,
      tags: ["server", "linux"],
    },
    {
      id: "node-021",
      name: "Remote Node 192.168.0.21",
      type: "remote",
      host: "192.168.0.21",
      sshUser: "git",
      sshPort: 22,
      remoteWorkDir: "/tmp/openclaw-test",
      maxConcurrency: 12,
      tags: ["remote", "linux"],
    },
  ],
  maxDispatchConcurrency: 32,
  globalTimeout: 300000,    // 5 分钟
  heartbeatInterval: 5000,  // 5 秒
  resultCollectionTimeout: 60000,
};

// ═══════════════════════════════════════════════════════════════
// RPC 协议（协调器 ↔ 节点）
// ═══════════════════════════════════════════════════════════════

/** 协调器 → 节点：执行任务指令 */
export interface ExecuteCommand {
  type: "execute";
  taskId: string;
  scenario: ScenarioType;
  params: Record<string, unknown>;
  concurrency: number;
  requestsPerUser: number;
  timeout: number;
}

/** 节点 → 协调器：任务结果 */
export interface ResultReport {
  type: "result";
  taskId: string;
  nodeId: string;
  status: TaskStatus;
  metrics: TestMetrics;
  errors: TestError[];
  durationMs: number;
}

/** 节点 → 协调器：心跳 */
export interface HeartbeatReport {
  type: "heartbeat";
  nodeId: string;
  status: NodeStatus;
  activeTasks: number;
  completedTasks: number;
  failedTasks: number;
  cpuUsage?: number;
  memoryUsage?: number;
}

/** RPC 消息联合类型 */
export type ClusterMessage = ExecuteCommand | ResultReport | HeartbeatReport;
