/**
 * 测试节点抽象 —— 本地节点与远程节点
 *
 * BaseTestNode 定义节点通用状态与结果构造能力；
 * LocalTestNode 通过动态导入场景 runner 在本地执行；
 * RemoteTestNode 通过 SshExecutor 在远程执行 bun run。
 */
import { logger } from "../../utils/logger.js";
import { SshExecutor } from "./ssh-executor.js";
import type {
  ScenarioType,
  TaskStatus,
  TestError,
  TestMetrics,
  TestNodeConfig,
  TestNodeStatus,
  TestResult,
  TestTask,
} from "./types.js";

/** 场景 → runner 文件名 + 导出函数名映射（位于 ../scenarios/ 下） */
const scenarioMap: Record<ScenarioType, { file: string; fn: string } | null> = {
  "hallucination": { file: "hallucination-test", fn: "runHallucinationTest" },
  "cross-talk": { file: "cross-talk-test", fn: "runCrossTalkTest" },
  "concurrent-load": { file: "concurrent-load", fn: "runConcurrentLoad" },
  "stress": null,
  "custom": null,
};

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

export abstract class BaseTestNode {
  protected readonly config: TestNodeConfig;
  protected status: TestNodeStatus;

  constructor(config: TestNodeConfig) {
    this.config = config;
    this.status = {
      nodeId: config.id,
      status: "idle",
      activeTasks: 0,
      completedTasks: 0,
      failedTasks: 0,
      lastHeartbeat: Date.now(),
    };
  }

  /** 执行一个测试任务 */
  abstract executeTask(task: TestTask): Promise<TestResult>;

  /** 健康检查，返回节点最新状态 */
  abstract healthCheck(): Promise<TestNodeStatus>;

  /** 获取节点当前状态（快照） */
  getStatus(): TestNodeStatus {
    return { ...this.status };
  }

  /** 构造测试结果（nodeId 自动取本节点配置） */
  protected createResult(
    taskId: string,
    status: TaskStatus,
    metrics: TestMetrics,
    errors: TestError[],
    durationMs: number,
  ): TestResult {
    return {
      taskId,
      nodeId: this.config.id,
      status,
      metrics,
      errors,
      durationMs,
    };
  }

  /** 标记任务开始：增加活跃计数并置为 busy */
  protected beginTask(): void {
    this.status.activeTasks++;
    this.status.status = "busy";
  }

  /** 标记任务结束：减少活跃计数，更新完成/失败计数，空闲时回到 idle */
  protected endTask(success: boolean): void {
    this.status.activeTasks = Math.max(0, this.status.activeTasks - 1);
    if (success) {
      this.status.completedTasks++;
    } else {
      this.status.failedTasks++;
    }
    if (this.status.activeTasks === 0) {
      this.status.status = "idle";
    }
    this.status.lastHeartbeat = Date.now();
  }
}

/**
 * 本地测试节点
 *
 * executeTask 根据 task.scenario 动态导入 ../scenarios/ 下的 runner 并调用。
 * 若 runner 不存在或执行抛错，返回 failed 结果。
 */
export class LocalTestNode extends BaseTestNode {
  async executeTask(task: TestTask): Promise<TestResult> {
    const start = Date.now();
    this.beginTask();
    try {
      const entry = scenarioMap[task.scenario];
      if (!entry) {
        throw new Error(`场景 "${task.scenario}" 未实现 runner`);
      }
      // 动态导入：路径非字面量，TS 不做静态解析，运行时解析
      const mod: Record<string, unknown> =
        await import("../scenarios/" + entry.file + ".js");
      const fn = mod[entry.fn] as ((task: TestTask) => Promise<TestResult>) | undefined;
      if (typeof fn !== "function") {
        throw new Error(`场景模块 "${entry.file}" 未导出函数 "${entry.fn}"`);
      }
      const result = await fn(task);
      this.endTask(true);
      return result;
    } catch (err) {
      this.endTask(false);
      const error: TestError = {
        timestamp: Date.now(),
        type: "runtime",
        message: `本地任务执行失败: ${(err as Error).message}`,
      };
      logger.warn("本地节点任务失败", { taskId: task.id, nodeId: this.config.id, error: (err as Error).message });
      return this.createResult(task.id, "failed", emptyMetrics(), [error], Date.now() - start);
    }
  }

  async healthCheck(): Promise<TestNodeStatus> {
    this.status.status = "idle";
    this.status.lastHeartbeat = Date.now();
    return this.getStatus();
  }
}

/**
 * 远程测试节点
 *
 * 通过 SshExecutor 在远程执行 `bun run src/testing/remote-runner.ts <taskId>`，
 * 任务参数以 base64 经 stdin 传入远程，远程输出 JSON 结果后解析。
 */
export class RemoteTestNode extends BaseTestNode {
  private readonly ssh: SshExecutor;
  private readonly remoteWorkDir: string;

  constructor(config: TestNodeConfig) {
    super(config);
    if (!config.host || !config.sshUser) {
      throw new Error(`远程节点 ${config.id} 缺少 host 或 sshUser 配置`);
    }
    this.ssh = new SshExecutor(config.host, config.sshUser, {
      port: config.sshPort,
      keyPath: config.sshKeyPath,
    });
    this.remoteWorkDir = config.remoteWorkDir ?? "/tmp/openclaw-test";
  }

  async executeTask(task: TestTask): Promise<TestResult> {
    const start = Date.now();
    this.beginTask();
    try {
      // 将任务 JSON 以 base64 编码经 stdin 传入远程 bun 进程
      const taskJson = JSON.stringify(task);
      const b64 = Buffer.from(taskJson).toString("base64");
      const remoteCmd =
        `cd ${this.remoteWorkDir} 2>/dev/null; ` +
        `echo '${b64}' | base64 -d | bun run src/testing/remote-runner.ts ${task.id}`;
      const result = await this.ssh.exec(remoteCmd, task.timeout);

      if (result.exitCode !== 0) {
        throw new Error(`远程执行失败 (exit ${result.exitCode}): ${result.stderr.trim() || result.stdout.trim()}`);
      }

      // 解析远程返回的 JSON 结果
      const report = JSON.parse(result.stdout) as TestResult;
      this.endTask(true);
      return { ...report, nodeId: this.config.id };
    } catch (err) {
      this.endTask(false);
      const msg = (err as Error).message;
      const isTimeout = /SIGKILL|timeout|超时/i.test(msg);
      const error: TestError = {
        timestamp: Date.now(),
        type: "connection",
        message: `远程任务执行失败: ${msg}`,
      };
      logger.warn("远程节点任务失败", { taskId: task.id, nodeId: this.config.id, error: msg });
      const status: TaskStatus = isTimeout ? "timeout" : "failed";
      return this.createResult(task.id, status, emptyMetrics(), [error], Date.now() - start);
    }
  }

  async healthCheck(): Promise<TestNodeStatus> {
    try {
      const result = await this.ssh.exec("echo ok");
      if (result.exitCode === 0 && result.stdout.trim() === "ok") {
        this.status.status = this.status.activeTasks > 0 ? "busy" : "idle";
      } else {
        this.status.status = "error";
      }
    } catch {
      this.status.status = "offline";
    }
    this.status.lastHeartbeat = Date.now();
    return this.getStatus();
  }
}

/** 工厂函数：根据 config.type 创建本地或远程测试节点 */
export function createTestNode(config: TestNodeConfig): BaseTestNode {
  if (config.type === "remote") {
    return new RemoteTestNode(config);
  }
  return new LocalTestNode(config);
}
