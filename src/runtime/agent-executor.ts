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

import { eventBus, worldState } from "./kernel.js";
import { constraintSolver } from "./constraint-solver.js";
import { capabilityRegistry } from "./capability-registry.js";
import { memoryEngine } from "./memory-engine.js";

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
      // Try to execute via real tool if available
      const result = await this.executeViaTool(capability.name, task);

      capabilityRegistry.recordResult(capability.id, true);

      // Learn from successful tool execution
      memoryEngine.learnFromToolExecution(
        capability.name,
        task.description,
        typeof result === "string" ? result : JSON.stringify(result ?? "").slice(0, 500),
        true,
      ).catch(() => { /* non-fatal */ });

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

      // Learn from failed tool execution
      memoryEngine.learnFromToolExecution(
        capability.name,
        task.description,
        (err as Error).message,
        false,
      ).catch(() => { /* non-fatal */ });

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
   * Execute via real MCP tool if available.
   */
  private async executeViaTool(capabilityName: string, task: AgentTask): Promise<unknown> {
    // Map capability names to tool names
    const toolMapping: Record<string, string> = {
      "code_analyze": "code_analyze",
      "code_diagnostics": "code_diagnostics",
      "memory_search": "memory_search",
      "planning": "planning",
      "constraint_solving": "constraint_solving",
      "code_generate": "code_generate",
      "code_review": "code_review",
      "web_search": "web_search",
      "fs_read": "fs_read",
      "terminal_exec": "terminal_exec",
      "git_status": "git_status",
    };

    const toolName = toolMapping[capabilityName] || capabilityName;

    // Try to import and use the tool handler
    try {
      // Check if it's an internal capability that we can execute directly
      if (capabilityName === "memory_search") {
        const results = memoryEngine.search(task.description);
        return { results: results.observations.slice(0, 5) };
      }

      if (capabilityName === "constraint_solving") {
        const entities = task.constraints || [];
        return constraintSolver.solve(entities);
      }

      if (capabilityName === "planning") {
        const { cognitivePipeline } = await import("./scheduler.js");
        return await cognitivePipeline.run(task.description);
      }

      if (capabilityName === "code_analyze" || capabilityName === "code_diagnostics") {
        // Delegate to knowledge network for code analysis
        const { knowledgeNetwork } = await import("./knowledge-network.js");
        const results = knowledgeNetwork.search(task.description, 5);
        return {
          findings: results.map((e) => ({ name: e.name, content: e.content.slice(0, 200), confidence: e.confidence })),
        };
      }

      if (capabilityName === "code_generate") {
        // Use cognitive pipeline for deterministic generation
        const { cognitivePipeline } = await import("./scheduler.js");
        return await cognitivePipeline.run(`generate: ${task.description}`);
      }

      if (capabilityName === "code_review") {
        const { knowledgeNetwork } = await import("./knowledge-network.js");
        const results = knowledgeNetwork.search(task.description, 5);
        return {
          reviewItems: results.map((e) => ({ entity: e.name, analysis: e.content.slice(0, 200) })),
        };
      }

      // For truly external tools, emit event for MCP server routing
      eventBus.publish({
        type: "tool.external_request",
        source: "agent-executor",
        data: { tool: toolName, task: task.description, capability: capabilityName },
        priority: "normal",
      });

      return {
        tool: toolName,
        task: task.description,
        result: `external_request_sent_to_${toolName}`,
        capability: capabilityName,
      };
    } catch (err) {
      throw new Error(`Tool execution failed: ${(err as Error).message}`);
    }
  }
}

export const agentExecutor = new AgentExecutorImpl();
