/**
 * Agent Executor — 纯执行体 (Observe → Execute → Report)
 *
 * Agent 不做任何决策。
 * Runtime 告诉 Agent：Task + Resources + Constraint + Goal
 * Agent 只执行。
 *
 * Agent 应该越来越"傻"。
 * 所有智能都在 Runtime 中。
 */

import { logger } from "../utils/logger.js";
import { eventBus, worldState } from "./kernel.js";
import { scheduler } from "./scheduler.js";
import { constraintSolver } from "./constraint-solver.js";
import { capabilityRegistry } from "./capability-registry.js";

// ─── Agent Types ───────────────────────────────────────────────────────────

export type AgentState = "idle" | "observing" | "executing" | "reporting" | "error" | "sleeping";

export interface AgentTask {
  id: string
  description: string
  resources: string[]
  constraints: string[]
  goal: string
  priority: "critical" | "high" | "normal" | "low"
  metadata: Record<string, unknown>
}

export interface AgentObservation {
  taskId: string
  input: string
  context: Record<string, unknown>
  constraints: Array<{ id: string; satisfied: boolean; reason: string }>
  timestamp: number
}

export interface AgentExecution {
  taskId: string
  action: string
  tool?: string
  args?: Record<string, unknown>
  result?: unknown
  success: boolean
  error?: string
  latencyMs: number
}

export interface AgentReport {
  taskId: string
  status: "completed" | "failed" | "needs_input"
  result: unknown
  observations: AgentObservation[]
  executions: AgentExecution[]
  totalTimeMs: number
}

// ─── Agent Executor ────────────────────────────────────────────────────────

class AgentExecutorImpl {
  private state: AgentState = "idle";
  private currentTask: AgentTask | null = null;
  private observations: AgentObservation[] = [];
  private executions: AgentExecution[] = [];
  private stats = { tasks: 0, successes: 0, failures: 0 };

  /**
   * Execute a task. This is the ONLY public method.
   * The agent does NOT decide what to do. It just executes.
   */
  async execute(task: AgentTask): Promise<AgentReport> {
    const startTime = Date.now();
    this.currentTask = task;
    this.observations = [];
    this.executions = [];
    this.stats.tasks++;

    eventBus.publish({
      type: "agent.started",
      source: "agent-executor",
      data: { taskId: task.id, description: task.description },
      priority: "normal",
    });

    try {
      // Step 1: Observe
      this.state = "observing";
      const observation = await this.observe(task);
      this.observations.push(observation);

      // Step 2: Execute
      this.state = "executing";
      const execution = await this.executeTask(task, observation);
      this.executions.push(execution);

      // Step 3: Report
      this.state = "reporting";
      const report: AgentReport = {
        taskId: task.id,
        status: execution.success ? "completed" : "failed",
        result: execution.result,
        observations: this.observations,
        executions: this.executions,
        totalTimeMs: Date.now() - startTime,
      };

      if (execution.success) {
        this.stats.successes++;
      } else {
        this.stats.failures++;
      }

      eventBus.publish({
        type: "agent.completed",
        source: "agent-executor",
        data: { taskId: task.id, status: report.status, totalTimeMs: report.totalTimeMs },
        priority: "normal",
      });

      this.state = "idle";
      this.currentTask = null;
      return report;

    } catch (err) {
      this.state = "error";
      this.stats.failures++;

      const report: AgentReport = {
        taskId: task.id,
        status: "failed",
        result: null,
        observations: this.observations,
        executions: this.executions,
        totalTimeMs: Date.now() - startTime,
      };

      eventBus.publish({
        type: "agent.failed",
        source: "agent-executor",
        data: { taskId: task.id, error: (err as Error).message },
        priority: "high",
      });

      this.state = "idle";
      this.currentTask = null;
      return report;
    }
  }

  /**
   * Get current agent state.
   */
  getState(): AgentState {
    return this.state;
  }

  /**
   * Get stats.
   */
  getStats(): { state: AgentState; tasks: number; successes: number; failures: number } {
    return { state: this.state, ...this.stats };
  }

  // ─── Private: Observe ────────────────────────────────────────────

  private async observe(task: AgentTask): Promise<AgentObservation> {
    // Check constraints
    const constraintResult = constraintSolver.solve(task.constraints);

    const observation: AgentObservation = {
      taskId: task.id,
      input: task.description,
      context: {
        resources: task.resources,
        goal: task.goal,
        constraints: constraintResult,
      },
      constraints: constraintResult.violations.map((v) => ({
        id: v.constraint.id,
        satisfied: false,
        reason: v.message,
      })),
      timestamp: Date.now(),
    };

    // Update world state
    worldState.set("agent.lastObservation", {
      timestamp: Date.now(),
      taskId: task.id,
      constraintViolations: constraintResult.violations.length,
    });

    return observation;
  }

  // ─── Private: Execute ────────────────────────────────────────────

  private async executeTask(task: AgentTask, observation: AgentObservation): Promise<AgentExecution> {
    const startTime = Date.now();

    // If there are constraint violations, don't execute
    if (observation.constraints.some((c) => !c.satisfied)) {
      return {
        taskId: task.id,
        action: "blocked",
        success: false,
        error: `Blocked by constraints: ${observation.constraints.filter((c) => !c.satisfied).map((c) => c.reason).join("; ")}`,
        latencyMs: Date.now() - startTime,
      };
    }

    // Find the best capability for this task
    const capability = capabilityRegistry.select(task.description);

    if (!capability) {
      return {
        taskId: task.id,
        action: "no_capability",
        success: false,
        error: "No capability found for this task",
        latencyMs: Date.now() - startTime,
      };
    }

    // Execute via the capability
    try {
      // In a real system, this would call the capability's actual implementation
      // For now, we simulate execution
      const result = await this.simulateCapabilityExecution(capability.name, task);

      capabilityRegistry.recordResult(capability.id, true);

      return {
        taskId: task.id,
        action: capability.name,
        tool: capability.name,
        result,
        success: true,
        latencyMs: Date.now() - startTime,
      };
    } catch (err) {
      capabilityRegistry.recordResult(capability.id, false);

      return {
        taskId: task.id,
        action: capability.name,
        tool: capability.name,
        success: false,
        error: (err as Error).message,
        latencyMs: Date.now() - startTime,
      };
    }
  }

  /**
   * Simulate capability execution. In production, this would be real.
   */
  private async simulateCapabilityExecution(capabilityName: string, task: AgentTask): Promise<unknown> {
    // Simulate some work
    await new Promise((resolve) => setTimeout(resolve, 10));

    return {
      capability: capabilityName,
      task: task.description,
      result: "simulated execution result",
    };
  }
}

export const agentExecutor = new AgentExecutorImpl();
