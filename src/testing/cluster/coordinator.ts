/**
 * 集群协调器 —— 任务分发与结果收集
 *
 * 分发策略：
 *   1. task.assignedNodeId 指定时，路由到该节点（信号量排队等待容量）。
 *   2. 未指定时，选最空闲（activeTasks 最少且有容量）的节点；全部满载则轮询兜底。
 * 并发控制：
 *   - 全局分发并发由 config.maxDispatchConcurrency 限制（dispatchSemaphore）。
 *   - 每节点并发由 node.maxConcurrency 限制（nodeSemaphores）。
 * 容错：
 *   - 节点执行抛错 → 任务标记 failed，附错误信息。
 *   - 任务超时 → 标记 timeout（底层执行不可取消，仅标记结果）。
 */
import { logger } from "../../utils/logger.js";
import { Semaphore } from "../../utils/concurrency/semaphore.js";
import { createTestNode, type BaseTestNode } from "./node.js";
import type {
  ClusterConfig,
  TestError,
  TestMetrics,
  TestNodeConfig,
  TestNodeStatus,
  TestResult,
  TestTask,
} from "./types.js";

/** 构造一个全零的空指标对象 */
function emptyMetrics(): TestMetrics {
  return {
    totalRequests: 0,
    successCount: 0,
    failureCount: 0,
    avgResponseMs: 0,
    p50ResponseMs: 0,
    p95ResponseMs: 0,
    p99ResponseMs: 0,
    throughput: 0,
    errorRate: 0,
  };
}

export class ClusterCoordinator {
  private readonly config: ClusterConfig;
  private readonly nodes: Map<string, BaseTestNode> = new Map();
  private readonly nodeConfigs: Map<string, TestNodeConfig> = new Map();
  private readonly nodeSemaphores: Map<string, Semaphore> = new Map();
  private readonly dispatchSemaphore: Semaphore;
  private rrIndex = 0; // 轮询兜底索引

  constructor(config: ClusterConfig) {
    this.config = config;
    this.dispatchSemaphore = new Semaphore(Math.max(1, config.maxDispatchConcurrency));
    for (const nodeCfg of config.nodes) {
      const node = createTestNode(nodeCfg);
      this.nodes.set(nodeCfg.id, node);
      this.nodeConfigs.set(nodeCfg.id, nodeCfg);
      this.nodeSemaphores.set(nodeCfg.id, new Semaphore(Math.max(1, nodeCfg.maxConcurrency)));
    }
  }

  /**
   * 批量分发任务，返回与入参顺序对应的结果数组。
   * 任务间并发受 dispatchSemaphore 与各节点 semaphore 共同约束。
   */
  async dispatch(tasks: TestTask[]): Promise<TestResult[]> {
    logger.info(`分发 ${tasks.length} 个任务到 ${this.nodes.size} 个节点`, {
      cluster: this.config.name,
    });
    const results = new Array<TestResult>(tasks.length);
    const promises = tasks.map((task, idx) =>
      this.dispatchSemaphore
        .withPermit(() => this.runTask(task))
        .then((r) => {
          results[idx] = r;
        }),
    );
    await Promise.all(promises);
    return results;
  }

  /** 分发单个任务 */
  async dispatchSingle(task: TestTask): Promise<TestResult> {
    return this.dispatchSemaphore.withPermit(() => this.runTask(task));
  }

  /** 获取所有节点当前状态快照 */
  getNodeStatuses(): TestNodeStatus[] {
    return Array.from(this.nodes.values()).map((n) => n.getStatus());
  }

  /** 关闭协调器，释放所有信号量等待者 */
  async shutdown(): Promise<void> {
    this.dispatchSemaphore.close("coordinator shutdown");
    for (const sem of this.nodeSemaphores.values()) {
      sem.close("coordinator shutdown");
    }
    logger.info("集群协调器已关闭", { cluster: this.config.name });
  }

  /** 运行单个任务：选节点 → 节点信号量准入 → 带超时执行 */
  private async runTask(task: TestTask): Promise<TestResult> {
    const start = Date.now();
    const nodeId = this.selectNode(task);
    if (!nodeId) {
      const error: TestError = {
        timestamp: Date.now(),
        type: "runtime",
        message: "无可用节点执行任务",
      };
      return {
        taskId: task.id,
        nodeId: "none",
        status: "failed",
        metrics: emptyMetrics(),
        errors: [error],
        durationMs: Date.now() - start,
      };
    }

    const sem = this.nodeSemaphores.get(nodeId)!;
    const node = this.nodes.get(nodeId)!;
    try {
      return await sem.withPermit(() => this.executeWithTimeout(node, task));
    } catch (err) {
      const error: TestError = {
        timestamp: Date.now(),
        type: "runtime",
        message: `任务分发异常: ${(err as Error).message}`,
      };
      return {
        taskId: task.id,
        nodeId,
        status: "failed",
        metrics: emptyMetrics(),
        errors: [error],
        durationMs: Date.now() - start,
      };
    }
  }

  /** 带超时执行节点任务：超时返回 timeout 结果（底层执行不可取消） */
  private executeWithTimeout(node: BaseTestNode, task: TestTask): Promise<TestResult> {
    const start = Date.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<TestResult>((resolve) => {
      timer = setTimeout(() => {
        const error: TestError = {
          timestamp: Date.now(),
          type: "timeout",
          message: `任务超时 (${task.timeout}ms)`,
        };
        resolve({
          taskId: task.id,
          nodeId: node.getStatus().nodeId,
          status: "timeout",
          metrics: emptyMetrics(),
          errors: [error],
          durationMs: Date.now() - start,
        });
      }, task.timeout);
    });
    return Promise.race([node.executeTask(task), timeoutPromise]).finally(() => {
      if (timer) clearTimeout(timer);
    });
  }

  /**
   * 选择执行节点：
   *   - assignedNodeId 指定 → 直接到该节点（信号量排队）。
   *   - 否则 → 选 activeTasks 最少且有容量的节点；全部满载则轮询兜底。
   */
  private selectNode(task: TestTask): string | undefined {
    if (task.assignedNodeId) {
      // 指定节点存在则路由（容量由信号量保证），不存在则失败
      return this.nodes.has(task.assignedNodeId) ? task.assignedNodeId : undefined;
    }

    const ids = Array.from(this.nodes.keys());
    if (ids.length === 0) return undefined;

    let best: string | undefined;
    let bestLoad = Infinity;
    for (const id of ids) {
      const st = this.nodes.get(id)!.getStatus();
      const cfg = this.nodeConfigs.get(id)!;
      if (st.activeTasks < cfg.maxConcurrency && st.activeTasks < bestLoad) {
        bestLoad = st.activeTasks;
        best = id;
      }
    }
    if (best) return best;

    // 全部满载：轮询兜底，任务将在某节点信号量上排队
    const id = ids[this.rrIndex % ids.length];
    this.rrIndex++;
    return id;
  }
}
