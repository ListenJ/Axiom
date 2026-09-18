/**
 * TaskGraph — 执行表示层 (Execution Representation)
 *
 * Task → Execution Graph → Rollback → Checkpoint → Resume
 *
 * 补全"三个缺失层"中的第三层:
 * - Knowledge Representation (KnowledgeStore)
 * - Reasoning Representation (ReasoningGraph)
 * - Execution Representation (TaskGraph)
 *
 * 设计原则:
 * - 不新增存储 — 通过 Checkpoint 写入 KnowledgeStore
 * - 不新增消息系统 — 通过 execute handler 与 Actor 系统对接
 * - 最小依赖 — 仅依赖 KnowledgeStore 的读写接口
 */

import type { KnowledgeStore } from "../storage/knowledge-store.js";
import { logger } from "../../utils/logger.js";

// ========== 类型定义 ==========

/** 工具执行器 — 使 TaskGraph 节点可以直接调用 MCP 工具 */
export type ToolExecutor = (toolName: string, args: Record<string, unknown>) => Promise<unknown>;

/** 任务状态 */
export type TaskStatus =
  | "pending"   // 初始
  | "ready"     // 依赖已满足，等待执行
  | "running"   // 执行中
  | "completed" // 成功
  | "failed"    // 失败
  | "rolling-back"  // 回滚中
  | "rolled-back";  // 已回滚

/** 任务 */
export interface Task {
  id: string;
  description: string;
  /** 依赖的任务 ID 列表 */
  dependsOn: string[];
  status: TaskStatus;
  /** 执行函数 */
  execute: () => Promise<unknown>;
  /** 回滚函数 (可选) */
  rollback?: () => Promise<void>;
  /** 执行结果 */
  result?: unknown;
  /** 错误消息 */
  error?: string;
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
}

/** TaskGraph 状态 */
export type TaskGraphStatus =
  | "running"
  | "completed"
  | "failed"
  | "rolled-back"
  | "partial";  // 部分成功

/** 序列化快照 (不含 execute/rollback 函数) */
export interface TaskGraphSnapshot {
  tasks: Array<{
    id: string;
    description: string;
    dependsOn: string[];
    status: TaskStatus;
    result?: unknown;
    error?: string;
    createdAt: number;
    startedAt?: number;
    completedAt?: number;
  }>;
  status: TaskGraphStatus;
  createdAt: number;
}

// ========== TaskGraph ==========

export class TaskGraph {
  private tasks = new Map<string, Task>();
  private _status: TaskGraphStatus = "running";
  private createdAt = Date.now();
  private completedIds = new Set<string>();
  private failedIds = new Set<string>();
  private toolExecutor: ToolExecutor | null = null;

  /**
   * 注册工具执行器 — TaskGraph 节点可通过 callTool() 调用 MCP 工具
   */
  setToolExecutor(executor: ToolExecutor): void {
    this.toolExecutor = executor;
  }

  /**
   * 调用 MCP 工具 (需先通过 setToolExecutor 注册执行器)
   */
  async callTool(toolName: string, args: Record<string, unknown> = {}): Promise<unknown> {
    if (!this.toolExecutor) {
      throw new Error(`ToolExecutor not set. Cannot call tool: ${toolName}`);
    }
    logger.info("[TaskGraph] Calling tool", { tool: toolName });
    return this.toolExecutor(toolName, args);
  }

  // ── 任务管理 ──

  addTask(
    id: string,
    description: string,
    execute: () => Promise<unknown>,
    opts?: { dependsOn?: string[]; rollback?: () => Promise<void> },
  ): Task {
    if (this.tasks.has(id)) {
      throw new Error(`Task already exists: ${id}`);
    }
    const task: Task = {
      id,
      description,
      dependsOn: opts?.dependsOn ?? [],
      status: "pending",
      execute,
      rollback: opts?.rollback,
      createdAt: Date.now(),
    };
    this.tasks.set(id, task);
    return task;
  }

  removeTask(id: string): boolean {
    return this.tasks.delete(id);
  }

  getTask(id: string): Task | undefined {
    return this.tasks.get(id);
  }

  getAllTasks(): Task[] {
    return Array.from(this.tasks.values());
  }

  getStatus(): TaskGraphStatus {
    return this._status;
  }

  isComplete(): boolean {
    return this._status === "completed" || this._status === "rolled-back";
  }

  // ── 拓扑排序 & DAG 执行 ──

  private getReadyTasks(): Task[] {
    return Array.from(this.tasks.values()).filter(
      (t) =>
        (t.status === "ready" || t.status === "pending") &&
        t.dependsOn.every((depId) => this.completedIds.has(depId)),
    );
  }

  private hasCycle(): boolean {
    const visited = new Set<string>();
    const inStack = new Set<string>();

    const dfs = (id: string): boolean => {
      if (inStack.has(id)) return true;
      if (visited.has(id)) return false;
      visited.add(id);
      inStack.add(id);
      const task = this.tasks.get(id);
      if (task) {
        for (const dep of task.dependsOn) {
          if (dfs(dep)) return true;
        }
      }
      inStack.delete(id);
      return false;
    };

    for (const id of this.tasks.keys()) {
      if (dfs(id)) return true;
    }
    return false;
  }

  /**
   * 执行所有就绪任务 (支持 Checkpoint/Resume)
   */
  async executeAll(): Promise<void> {
    if (this._status !== "running") {
      throw new Error(`TaskGraph status is ${this._status}, cannot execute`);
    }

    if (this.hasCycle()) {
      this._status = "failed";
      throw new Error("TaskGraph contains a cycle");
    }

    // 更新初始 pending 任务的依赖状态
    for (const task of this.tasks.values()) {
      if (task.dependsOn.length === 0 && task.status === "pending") {
        task.status = "ready";
      }
    }

    // 逐步执行: 每轮取所有就绪任务并行执行
    while (true) {
      const ready = this.getReadyTasks();
      if (ready.length === 0) break;

      const results = await Promise.all(
        ready.map(async (task) => {
          task.status = "running";
          task.startedAt = Date.now();
          try {
            task.result = await task.execute();
            task.status = "completed";
            task.completedAt = Date.now();
            this.completedIds.add(task.id);
            logger.info("[TaskGraph] Task completed", { id: task.id });
          } catch (err) {
            task.status = "failed";
            task.error = (err as Error).message;
            this.failedIds.add(task.id);
            logger.warn("[TaskGraph] Task failed", { id: task.id, error: task.error });
          }
        }),
      );

      // 如果有任务失败了 → 尝试回滚
      if (this.failedIds.size > 0) {
        const hasRollbacks = ready.some(
          (t) => t.status === "failed" && t.rollback,
        );
        if (hasRollbacks) {
          await this.rollbackAll();
        }
        this._status = this.completedIds.size > 0 ? "partial" : "failed";
        return;
      }

      // 更新新就绪任务的状态
      for (const task of this.tasks.values()) {
        if (
          task.status === "pending" &&
          task.dependsOn.every((depId) => this.completedIds.has(depId))
        ) {
          task.status = "ready";
        }
      }
    }

    // 检查是否全部完成
    if (this.completedIds.size === this.tasks.size) {
      this._status = "completed";
    } else if (this.failedIds.size > 0) {
      this._status = "partial";
    }
  }

  /**
   * 回滚所有已完成的任务 (反向依赖顺序)
   */
  async rollbackAll(): Promise<void> {
    // 拓扑排序的反向: 后完成先回滚
    const completed = Array.from(this.tasks.values())
      .filter((t) => t.status === "completed" && t.rollback)
      .sort((a, b) => (b.completedAt ?? 0) - (a.completedAt ?? 0));

    const failed = Array.from(this.tasks.values()).filter(
      (t) => t.status === "failed" && t.rollback,
    );

    const toRollback = [...failed, ...completed];

    for (const task of toRollback) {
      if (!task.rollback) continue;
      task.status = "rolling-back";
      try {
        await task.rollback();
        task.status = "rolled-back";
        logger.info("[TaskGraph] Task rolled back", { id: task.id });
      } catch (err) {
        logger.warn("[TaskGraph] Rollback failed", {
          id: task.id,
          error: (err as Error).message,
        });
      }
    }

    this._status = "rolled-back";
  }

  // ── Checkpoint / Resume ──

  /**
   * 保存检查点到 KnowledgeStore
   * 返回 checkpoint ID (用于 resume)
   */
  async checkpoint(store: KnowledgeStore): Promise<string> {
    const snapshot = this.toJSON();
    const checkpointId = `checkpoint-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    store.write({
      nodeId: `dre:procedure:${checkpointId}`,
      title: `TaskGraph Checkpoint ${checkpointId}`,
      content: JSON.stringify(snapshot),
      domain: "meta",
      paradigm: "procedure",
      confidence: 1.0,
      sourceType: "manual",
      schemaVersion: 1,
      isVerified: true,
    });

    logger.info("[TaskGraph] Checkpoint saved", { checkpointId, tasks: snapshot.tasks.length });
    return checkpointId;
  }

  /**
   * 从 KnowledgeStore 恢复检查点
   * 返回是否成功
   */
  async resume(store: KnowledgeStore, checkpointId: string): Promise<boolean> {
    const node = store.read(`dre:procedure:${checkpointId}`);
    if (!node) {
      logger.warn("[TaskGraph] Checkpoint not found", { checkpointId });
      return false;
    }

    try {
      const snapshot = JSON.parse(node.content) as TaskGraphSnapshot;
      this.fromJSON(snapshot);
      logger.info("[TaskGraph] Resumed from checkpoint", {
        checkpointId,
        tasks: snapshot.tasks.length,
        status: snapshot.status,
      });
      return true;
    } catch (err) {
      logger.warn("[TaskGraph] Resume failed", {
        checkpointId,
        error: (err as Error).message,
      });
      return false;
    }
  }

  // ── 序列化 ──

  toJSON(): TaskGraphSnapshot {
    return {
      tasks: Array.from(this.tasks.values()).map((t) => ({
        id: t.id,
        description: t.description,
        dependsOn: t.dependsOn,
        status: t.status,
        result: t.result,
        error: t.error,
        createdAt: t.createdAt,
        startedAt: t.startedAt,
        completedAt: t.completedAt,
      })),
      status: this._status,
      createdAt: this.createdAt,
    };
  }

  fromJSON(snapshot: TaskGraphSnapshot): void {
    this.tasks.clear();
    this.completedIds.clear();
    this.failedIds.clear();
    this._status = snapshot.status;
    this.createdAt = snapshot.createdAt;

    for (const t of snapshot.tasks) {
      const task: Task = {
        id: t.id,
        description: t.description,
        dependsOn: t.dependsOn,
        status: t.status,
        execute: async () => {
          throw new Error("Task function not available after deserialization");
        },
        createdAt: t.createdAt,
        startedAt: t.startedAt,
        completedAt: t.completedAt,
        result: t.result,
        error: t.error,
      };
      this.tasks.set(task.id, task);
      if (t.status === "completed") this.completedIds.add(t.id);
      if (t.status === "failed") this.failedIds.add(t.id);
    }
  }
}
