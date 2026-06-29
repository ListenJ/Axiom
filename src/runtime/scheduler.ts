/**
 * Scheduler — Unified Task Scheduling (Pure)
 *
 * Scheduler only handles "when" to run, not "what" to do.
 * Reasoning is handled by src/runtime/reasoner/reasoning-runtime.ts.
 *
 * Responsibilities:
 * - Task Queue with priority
 * - Resource awareness (CPU, memory, tokens)
 * - Agent allocation
 * - Deadline management
 * - Preemption for critical tasks
 */

import { logger } from "../utils/logger.js";
import { eventBus, worldState } from "./kernel.js";

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

function hasResources(budget: ResourceBudget): boolean {
  return (
    budget.currentTasks < budget.maxConcurrentTasks &&
    budget.currentTokensPerMinute < budget.maxTokensPerMinute &&
    budget.currentMemoryMB < budget.maxMemoryMB
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

// ─── Scheduler ─────────────────────────────────────────────────────────────

class SchedulerImpl {
  private queue: ScheduledTask[] = [];
  private running = new Map<string, ScheduledTask>();
  private completed: ScheduledTask[] = [];
  private maxCompleted = 100;
  private budget: ResourceBudget = {
    maxConcurrentTasks: 5,
    maxTokensPerMinute: 100000,
    maxMemoryMB: 4096,
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
   */
  getNext(): ScheduledTask | null {
    if (!hasResources(this.budget)) return null;

    for (let i = 0; i < this.queue.length; i++) {
      const task = this.queue[i];
      if (task.status !== "pending") continue;

      const depsSatisfied = task.dependencies.every((depId) =>
        this.completed.some((c) => c.id === depId && c.status === "completed")
      );

      if (depsSatisfied) {
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
    }

    return null;
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
    if (this.completed.length > this.maxCompleted) {
      this.completed.shift();
    }

    eventBus.publish({
      type: "task.completed",
      source: "scheduler",
      data: { id: task.id, name: task.name, duration: task.completedAt - (task.startedAt ?? task.createdAt) },
      priority: "normal",
    });
  }

  /**
   * Fail a task.
   */
  fail(taskId: string, error: string): void {
    const task = this.running.get(taskId);
    if (!task) return;

    task.retries++;
    this.running.delete(taskId);
    this.budget.currentTasks--;

    if (task.retries < task.maxRetries) {
      task.status = "pending";
      task.error = error;
      this.queue.push(task);
      this.queue.sort((a, b) => PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority]);

      eventBus.publish({
        type: "task.retrying",
        source: "scheduler",
        data: { id: task.id, retries: task.retries, error },
        priority: "normal",
      });
    } else {
      task.status = "failed";
      task.error = error;
      task.completedAt = Date.now();
      this.completed.push(task);

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
      return true;
    }

    return false;
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
    return {
      queued: this.queue.length,
      running: this.running.size,
      completed: this.completed.length,
      budget: { ...this.budget },
      tasks: [...this.queue, ...Array.from(this.running.values())],
    };
  }

  /**
   * Update resource budget.
   */
  setBudget(budget: Partial<ResourceBudget>): void {
    Object.assign(this.budget, budget);
  }
}

export const scheduler = new SchedulerImpl();

// ─── Re-export from Reasoning Runtime ──────────────────────────────────────

// The CognitivePipeline has been moved to src/runtime/reasoner/reasoning-runtime.ts
// for separation of concerns. Scheduler handles "when", Reasoner handles "what/how".
export { getReasoningRuntime } from "./reasoner/reasoning-runtime.js";
export type { PipelineStage, PipelineContext } from "./reasoner/reasoning-runtime.js";

// Backward compatibility: cognitivePipeline now delegates to ReasoningRuntime
import { getReasoningRuntime } from "./reasoner/reasoning-runtime.js";
export const cognitivePipeline = getReasoningRuntime();
