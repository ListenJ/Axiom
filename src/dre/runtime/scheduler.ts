/**
 * Scheduler — Unified Task Scheduling (Pure)
 *
 * Scheduler only handles "when" to run, not "what" to do.
 * Reasoning is handled by the DRE kernel.
 *
 * Responsibilities:
 * - Task Queue with priority
 * - Resource awareness (CPU, memory, tokens)
 * - Agent allocation
 * - Deadline management
 * - Preemption for critical tasks
 */

import { eventBus } from "./event-bus.js";
import { logger } from "../../utils/logger.js";
import { getResourceBudgetManager } from "../system-resource.js";

// ─── Task Types ────────────────────────────────────────────────────────────

export type TaskStatus = "pending" | "running" | "completed" | "failed" | "cancelled" | "preempted";
export type TaskPriority = "critical" | "high" | "normal" | "low" | "background";

export interface ScheduledTask {
  id: string
  name: string
  priority: TaskPriority
  status: TaskStatus
  payload: unknown
  assignedTo?: string
  createdAt: number
  startedAt?: number
  completedAt?: number
  deadline?: number
  retries: number
  maxRetries: number
  dependencies: string[]
  result?: unknown
  error?: string
  /** Earliest time this task can be re-attempted (set on retry backoff). */
  notBefore?: number
}

// ─── Resource Manager ──────────────────────────────────────────────────────

interface ResourceBudget {
  maxConcurrentTasks: number
  maxTokensPerMinute: number
  maxMemoryMB: number
  currentTasks: number
  currentTokensPerMinute: number
  currentMemoryMB: number
}

function getEffectiveMemoryUsageMB(): number {
  try {
    const mgr = getResourceBudgetManager();
    const res = mgr.getResource();
    const used = res.maxMemory - res.availableMemory;
    if (Number.isFinite(used) && used >= 0) return Math.round(used);
  } catch {}
  try {
    return Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
  } catch {
    return 0;
  }
}

function hasResources(budget: ResourceBudget): boolean {
  const effectiveCurrent = getEffectiveMemoryUsageMB();
  budget.currentMemoryMB = effectiveCurrent;
  try {
    const mgr = getResourceBudgetManager();
    const check = mgr.canRun();
    if (!check.canRun) return false;
  } catch {}
  return (
    budget.currentTasks < budget.maxConcurrentTasks &&
    budget.currentTokensPerMinute < budget.maxTokensPerMinute &&
    effectiveCurrent < budget.maxMemoryMB
  );
}

// ─── Priority Queue ────────────────────────────────────────────────────────

const PRIORITY_ORDER: Record<TaskPriority, number> = {
  critical: 0,
  high: 1,
  normal: 2,
  low: 3,
  background: 4,
};

/** Tasks with priority at or below this threshold are eligible to be preempted by critical tasks. */
const PREEMPTABLE_PRIORITY: TaskPriority[] = ["low", "background"];

// ─── Scheduler ─────────────────────────────────────────────────────────────

class SchedulerImpl {
  private queue: ScheduledTask[] = [];
  private running = new Map<string, ScheduledTask>();
  private completed: ScheduledTask[] = [];
  /** Max retained completed/cancelled/failed/preempted tasks before oldest are trimmed. */
  private maxCompletedHistory = 100;
  private budget: ResourceBudget = {
    maxConcurrentTasks: 5,
    maxTokensPerMinute: 100000,
    maxMemoryMB: getResourceBudgetManager().getResource().maxMemory,
    currentTasks: 0,
    currentTokensPerMinute: 0,
    currentMemoryMB: 0,
  };

  /**
   * Submit a task to the scheduler.
   */
  submit(task: Omit<ScheduledTask, "id" | "status" | "createdAt" | "retries">): ScheduledTask {
    const fullTask: ScheduledTask = {
      ...task,
      id: `task_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      status: "pending",
      createdAt: Date.now(),
      retries: 0,
    };

    this.queue.push(fullTask);
    this.queue.sort((a, b) => PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority]);

    eventBus.publish({
      type: "task.submitted",
      source: "scheduler",
      data: { id: fullTask.id, name: fullTask.name, priority: fullTask.priority },
      priority: "normal",
    });

    return fullTask;
  }

  /**
   * Get the next task to execute.
   * Skips expired tasks (deadline passed) and tasks whose retry backoff hasn't elapsed.
   */
  getNext(): ScheduledTask | null {
    // H-06 同源同步：每次调度前刷新 maxMemoryMB 以与 ResourceBudgetManager 保持一致
    try {
      this.budget.maxMemoryMB = getResourceBudgetManager().getResource().maxMemory;
    } catch {}
    // Auto-fail expired pending tasks
    this.expirePendingTasks();
    // M2 看门狗：超期 running 任务终结并释放并发槽位（旧实现只巡检排队队列）
    this.expireRunningTasks();

    if (!hasResources(this.budget)) {
      // Try preemption if a critical task is waiting and low-priority tasks are running
      const criticalWaiting = this.queue.some(
        (t) => t.status === "pending" && t.priority === "critical" && this.isReady(t),
      );
      if (criticalWaiting) {
        const preempted = this.preemptOne();
        if (!preempted) return null;
      } else {
        return null;
      }
    }

    for (let i = 0; i < this.queue.length; i++) {
      const task = this.queue[i];
      if (task.status !== "pending") continue;
      if (!this.isReady(task)) continue;

      this.queue.splice(i, 1);
      task.status = "running";
      task.startedAt = Date.now();
      this.running.set(task.id, task);
      this.budget.currentTasks++;

      eventBus.publish({
        type: "task.started",
        source: "scheduler",
        data: { id: task.id, name: task.name },
        priority: "normal",
      });

      return task;
    }

    return null;
  }

  /**
   * Preempt one running low/background-priority task to free a slot.
   * The preempted task is re-queued (status=pending) so it can resume later,
   * rather than being discarded. Returns true if a task was preempted.
   */
  private preemptOne(): boolean {
    for (const [id, task] of this.running) {
      if (!PREEMPTABLE_PRIORITY.includes(task.priority)) continue;

      this.running.delete(id);
      this.budget.currentTasks--;

      // Re-queue for later execution — preemption is pause, not cancellation
      task.status = "pending";
      task.error = `Preempted by critical task at ${new Date().toISOString()}`;
      this.queue.push(task);
      this.queue.sort((a, b) => PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority]);

      eventBus.publish({
        type: "task.preempted",
        source: "scheduler",
        data: { id: task.id, name: task.name, priority: task.priority, requeued: true },
        priority: "high",
      });

      logger.warn("[Scheduler] Preempted task (re-queued)", {
        preemptedId: task.id,
        preemptedPriority: task.priority,
      });
      return true;
    }
    return false;
  }

  /**
   * Check if a pending task is ready to run (dependencies satisfied, backoff elapsed).
   */
  private isReady(task: ScheduledTask): boolean {
    if (task.notBefore && Date.now() < task.notBefore) return false;

    return task.dependencies.every((depId) =>
      this.completed.some((c) => c.id === depId && c.status === "completed"),
    );
  }

  /**
   * Mark pending tasks whose deadline has passed as failed.
   */
  private expirePendingTasks(): void {    const now = Date.now();
    for (let i = this.queue.length - 1; i >= 0; i--) {
      const task = this.queue[i];
      if (task.status !== "pending") continue;
      if (task.deadline && now > task.deadline) {
        task.status = "failed";
        task.error = `Deadline exceeded (${task.deadline})`;
        task.completedAt = now;
        this.completed.push(task);
        this.queue.splice(i, 1);

        eventBus.publish({
          type: "task.failed",
          source: "scheduler",
          data: { id: task.id, error: task.error, reason: "deadline_exceeded" },
          priority: "high",
        });
      }
    }
    this.trimCompleted();
  }

  /**
   * M2 审计修复：终结已超期的 running 任务并释放并发槽位。
   * 看门狗强制终态 failed（不重试）—— 挂死的执行体重试大概率再次挂死，
   * 重试留给可快速失败的显式错误路径。
   */
  private expireRunningTasks(): void {
    const now = Date.now();
    for (const [id, task] of this.running) {
      if (!task.deadline || now <= task.deadline) continue;
      this.running.delete(id);
      this.budget.currentTasks--;
      task.status = "failed";
      task.error = `Deadline exceeded while running (deadline=${task.deadline})`;
      task.completedAt = now;
      this.completed.push(task);
      this.trimCompleted();

      eventBus.publish({
        type: "task.failed",
        source: "scheduler",
        data: { id: task.id, error: task.error, reason: "running_deadline_exceeded" },
        priority: "high",
      });
      logger.warn("[Scheduler] Running task exceeded deadline — force failed", { id });
    }
  }

  /**
   * Complete a task.
   */
  complete(taskId: string, result: unknown): void {
    const task = this.running.get(taskId);
    if (!task) return;

    task.status = "completed";
    task.completedAt = Date.now();
    task.result = result;
    this.running.delete(taskId);
    this.budget.currentTasks--;

    this.completed.push(task);
    this.trimCompleted();

    eventBus.publish({
      type: "task.completed",
      source: "scheduler",
      data: { id: task.id, name: task.name, duration: task.completedAt - (task.startedAt ?? task.createdAt) },
      priority: "normal",
    });
  }

  /**
   * Fail a task. With retry backoff (exponential: 100ms × 2^attempt, capped at 5000ms).
   * `maxRetries` semantics match LLMClient: N = number of retries allowed (excluding
   * the initial attempt). So maxRetries=0 = 1 attempt, maxRetries=2 = 3 attempts.
   */
  fail(taskId: string, error: string): void {
    const task = this.running.get(taskId);
    if (!task) return;

    task.retries++;
    this.running.delete(taskId);
    this.budget.currentTasks--;

    if (task.retries <= task.maxRetries) {
      task.status = "pending";
      task.error = error;
      // Exponential backoff: 100ms, 200ms, 400ms, ... capped at 5s
      const backoff = Math.min(100 * Math.pow(2, task.retries - 1), 5000);
      task.notBefore = Date.now() + backoff;
      this.queue.push(task);
      this.queue.sort((a, b) => PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority]);

      eventBus.publish({
        type: "task.retrying",
        source: "scheduler",
        data: { id: task.id, retries: task.retries, error, backoffMs: backoff },
        priority: "normal",
      });
    } else {
      task.status = "failed";
      task.error = error;
      task.completedAt = Date.now();
      this.completed.push(task);
      this.trimCompleted();

      eventBus.publish({
        type: "task.failed",
        source: "scheduler",
        data: { id: task.id, error },
        priority: "high",
      });
    }
  }

  /**
   * Cancel a task.
   */
  cancel(taskId: string): boolean {
    const idx = this.queue.findIndex((t) => t.id === taskId);
    if (idx !== -1) {
      this.queue[idx].status = "cancelled";
      this.completed.push(this.queue[idx]);
      this.trimCompleted();
      this.queue.splice(idx, 1);
      return true;
    }

    const task = this.running.get(taskId);
    if (task) {
      task.status = "cancelled";
      task.completedAt = Date.now();
      this.running.delete(taskId);
      this.budget.currentTasks--;
      this.completed.push(task);
      this.trimCompleted();
      return true;
    }

    return false;
  }

  /**
   * Look up a task by ID (any state).
   */
  getTask(taskId: string): ScheduledTask | undefined {
    const queued = this.queue.find((t) => t.id === taskId);
    if (queued) return queued;

    const running = this.running.get(taskId);
    if (running) return running;

    return this.completed.find((t) => t.id === taskId);
  }

  /**
   * Get queue status.
   */
  getStatus(): {
    queued: number
    running: number
    completed: number
    budget: ResourceBudget
    tasks: ScheduledTask[]
  } {
    // 同源同步：maxMemoryMB 始终以 ResourceBudgetManager 为权威源（H-06 双轨统一）
    let liveMax = this.budget.maxMemoryMB;
    try {
      liveMax = getResourceBudgetManager().getResource().maxMemory;
    } catch {}
    return {
      queued: this.queue.length,
      running: this.running.size,
      completed: this.completed.length,
      budget: { ...this.budget, maxMemoryMB: liveMax },
      tasks: [...this.queue, ...Array.from(this.running.values())],
    };
  }

  /**
   * Update resource budget.
   */
  setBudget(budget: Partial<ResourceBudget>): void {
    // H-06 双轨统一：若设置 maxMemoryMB 则同步至权威源 ResourceBudgetManager
    if (budget.maxMemoryMB !== undefined) {
      try {
        getResourceBudgetManager().updateResource({ maxMemory: budget.maxMemoryMB });
      } catch {}
      const { maxMemoryMB, ...rest } = budget;
      Object.assign(this.budget, rest);
      try {
        this.budget.maxMemoryMB = getResourceBudgetManager().getResource().maxMemory;
      } catch {
        this.budget.maxMemoryMB = maxMemoryMB;
      }
      return;
    }
    Object.assign(this.budget, budget);
  }

  /**
   * Reset all scheduler state. Useful for tests.
   */
  reset(): void {
    this.queue = [];
    this.running.clear();
    this.completed = [];
    let liveMax = 4096;
    try {
      liveMax = getResourceBudgetManager().getResource().maxMemory;
    } catch {}
    this.budget = {
      maxConcurrentTasks: 5,
      maxTokensPerMinute: 100000,
      maxMemoryMB: liveMax,
      currentTasks: 0,
      currentTokensPerMinute: 0,
      currentMemoryMB: 0,
    };
  }

  private trimCompleted(): void {
    while (this.completed.length > this.maxCompletedHistory) {
      this.completed.shift();
    }
  }
}

export const scheduler = new SchedulerImpl();
