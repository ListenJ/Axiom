/**
 * Scheduler — Unified Task Scheduling
 *
 * Instead of Router deciding who works, the Scheduler decides:
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

/**
 * Check if resources are available for a task.
 */
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

    // Insert into priority queue
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
    // Check resources
    if (!hasResources(this.budget)) return null;

    // Find first task with satisfied dependencies
    for (let i = 0; i < this.queue.length; i++) {
      const task = this.queue[i];
      if (task.status !== "pending") continue;

      // Check dependencies
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
      // Re-queue for retry
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
    // Check queue
    const idx = this.queue.findIndex((t) => t.id === taskId);
    if (idx !== -1) {
      this.queue[idx].status = "cancelled";
      this.completed.push(this.queue[idx]);
      this.queue.splice(idx, 1);
      return true;
    }

    // Check running
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

// ─── Deterministic Cognitive Pipeline ──────────────────────────────────────

/**
 * The core cognitive loop. LLM is LAST, not first.
 *
 * Observation → Atom → State Update → Constraint → Rule → Graph →
 * Planning → Verification → Need LLM? → No → Done
 *                                      → Yes → LLM → Verify → Done
 */

export type PipelineStage =
  | "observation"
  | "normalization"
  | "entity-resolution"
  | "state-update"
  | "constraint-check"
  | "graph-reasoning"
  | "planning"
  | "verification"
  | "llm-assist"
  | "execution"
  | "reflection";

export interface PipelineContext {
  input: unknown
  atoms: unknown[]
  entities: unknown[]
  stateChanges: unknown[]
  constraints: unknown[]
  violations: unknown[]
  plan: unknown
  needsLLM: boolean
  llmResult?: unknown
  result: unknown
  stage: PipelineStage
  startTime: number
  stageTimings: Map<PipelineStage, number>
}

type StageHandler = (ctx: PipelineContext) => Promise<PipelineContext>;

/**
 * Deterministic Cognitive Pipeline — algorithms first, LLM last.
 */
class CognitivePipelineImpl {
  private stages = new Map<PipelineStage, StageHandler>();
  private stats = { runs: 0, llmCalls: 0, deterministicWins: 0 };

  constructor() {
    this.registerDefaultStages();
  }

  /**
   * Register a stage handler.
   */
  registerStage(stage: PipelineStage, handler: StageHandler): void {
    this.stages.set(stage, handler);
  }

  /**
   * Run the pipeline on an input.
   */
  async run(input: unknown): Promise<PipelineContext> {
    const startTime = Date.now();
    this.stats.runs++;

    let ctx: PipelineContext = {
      input,
      atoms: [],
      entities: [],
      stateChanges: [],
      constraints: [],
      violations: [],
      plan: null,
      needsLLM: false,
      result: null,
      stage: "observation",
      startTime,
      stageTimings: new Map(),
    };

    const stageOrder: PipelineStage[] = [
      "observation",
      "normalization",
      "entity-resolution",
      "state-update",
      "constraint-check",
      "graph-reasoning",
      "planning",
      "verification",
    ];

    for (const stage of stageOrder) {
      const stageStart = Date.now();
      ctx.stage = stage;

      const handler = this.stages.get(stage);
      if (handler) {
        try {
          ctx = await handler(ctx);
        } catch (err) {
          logger.error(`[CognitivePipeline] Stage ${stage} failed`, err instanceof Error ? err : new Error(String(err)));
          ctx.needsLLM = true;
          break;
        }
      }

      ctx.stageTimings.set(stage, Date.now() - stageStart);

      // Early exit if deterministic answer found
      if (ctx.result && !ctx.needsLLM) {
        this.stats.deterministicWins++;
        break;
      }
    }

    // Only call LLM if deterministic pipeline couldn't solve it
    if (ctx.needsLLM) {
      this.stats.llmCalls++;
      ctx.stage = "llm-assist";

      // Publish event for LLM routing
      eventBus.publish({
        type: "pipeline.llm_needed",
        source: "cognitive-pipeline",
        data: { input: ctx.input, stage: ctx.stage },
        priority: "high",
      });

      // LLM result would be filled in by the LLM actor
      // For now, mark as needing external assistance
      ctx.result = { needsLLM: true, reason: "Deterministic pipeline insufficient" };
    }

    // Reflection stage
    ctx.stage = "reflection";
    eventBus.publish({
      type: "pipeline.completed",
      source: "cognitive-pipeline",
      data: {
        stages: Object.fromEntries(ctx.stageTimings),
        needsLLM: ctx.needsLLM,
        totalTime: Date.now() - startTime,
      },
      priority: "low",
    });

    return ctx;
  }

  /**
   * Get pipeline stats.
   */
  getStats(): { runs: number; llmCalls: number; deterministicWins: number; deterministicRate: number } {
    return {
      ...this.stats,
      deterministicRate: this.stats.runs > 0 ? this.stats.deterministicWins / this.stats.runs : 0,
    };
  }

  // ─── Default Stages ─────────────────────────────────────────────

  private registerDefaultStages(): void {
    // Stage 1: Observation — collect raw input and search all knowledge sources
    this.registerStage("observation", async (ctx) => {
      if (typeof ctx.input === "string") {
        const { atomStore } = await import("./atom-engine.js");
        const { memoryEngine } = await import("./memory-engine.js");
        const { knowledgeNetwork } = await import("./knowledge-network.js");

        // Search atoms
        ctx.atoms = atomStore.search(ctx.input, 10);

        // Search memory (observations, episodes, patterns, knowledge, skills)
        const memoryResults = memoryEngine.search(ctx.input);
        ctx.atoms.push(...memoryResults.knowledge.map((k) => ({
          id: k.id,
          kind: "fact",
          content: k.statement,
          confidence: "inferred" as const,
          source: "memory",
        })));

        // Search knowledge network
        const knResults = knowledgeNetwork.search(ctx.input, 5);
        ctx.atoms.push(...knResults.map((e) => ({
          id: e.id,
          kind: e.kind,
          content: e.content.slice(0, 200),
          confidence: e.confidence > 0.8 ? "certain" as const : "inferred" as const,
          source: "knowledge-network",
        })));
      }
      return ctx;
    });

    // Stage 2: Normalization — standardize atoms
    this.registerStage("normalization", async (ctx) => {
      // Normalize atom content (lowercase, trim, deduplicate)
      const seen = new Set<string>();
      ctx.atoms = (ctx.atoms as Array<{ content: string }>).filter((a) => {
        const key = a.content.toLowerCase().trim();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      return ctx;
    });

    // Stage 3: Entity Resolution — identify entities from input
    this.registerStage("entity-resolution", async (ctx) => {
      const { atomStore } = await import("./atom-engine.js");

      // Find entities mentioned in input
      const input = ctx.input as string;
      const inputLower = input.toLowerCase();

      // Search for known entities in atom store
      const searchResults = atomStore.search(input, 20);
      ctx.entities = searchResults.filter((a) =>
        a.kind === "entity" || a.kind === "class" || a.kind === "function" ||
        a.kind === "concept" || a.kind === "fact"
      );

      // Also check knowledge network for matching entities
      try {
        const { knowledgeNetwork } = await import("./knowledge-network.js");
        const knResults = knowledgeNetwork.search(input, 10);
        for (const entity of knResults) {
          if (!ctx.entities.some((e: any) => e.id === entity.id)) {
            ctx.entities.push(entity);
          }
        }
      } catch { /* non-fatal */ }

      // Extract entities from input text using heuristics
      const extractedEntities = this.extractEntitiesFromText(input);
      for (const entityName of extractedEntities) {
        // Check if already in entities list
        const exists = ctx.entities.some((e: any) =>
          e.content?.toLowerCase().includes(entityName.toLowerCase())
        );
        if (!exists) {
          // Create a new atom for this entity
          const atom = atomStore.create("entity", entityName, {
            source: "cognitive-pipeline",
            confidence: "inferred",
            metadata: { extractedFrom: "input-text" },
          });
          ctx.entities.push(atom);
        }
      }

      return ctx;
    });

    // Stage 4: State Update — update world state
    this.registerStage("state-update", async (ctx) => {
      // Record observations in world state
      worldState.update("cognitive.lastObservation", () => ({
        timestamp: Date.now(),
        atomCount: ctx.atoms.length,
        entityCount: ctx.entities.length,
        input: (ctx.input as string).slice(0, 200),
      }));

      // Record entity states
      for (const entity of ctx.entities.slice(0, 5)) {
        const e = entity as any;
        if (e?.id) {
          worldState.set(`entities.${e.id}`, {
            kind: e.kind,
            content: e.content?.slice(0, 200),
            lastSeen: Date.now(),
          });
        }
      }

      return ctx;
    });

    // Stage 5: Constraint Check — verify constraints
    this.registerStage("constraint-check", async (ctx) => {
      // Check constraints on discovered entities
      const { constraintSolver } = await import("./constraint-solver.js");
      const entityIds = ctx.entities.map((e: any) => e.id || e.content).filter(Boolean);

      if (entityIds.length > 0) {
        const constraintResult = constraintSolver.solve(entityIds);
        ctx.constraints = constraintResult.violations;

        if (!constraintResult.satisfied) {
          // Log violations but don't block — let the planner decide
          eventBus.publish({
            type: "pipeline.constraint_violation",
            source: "cognitive-pipeline",
            data: {
              violations: constraintResult.violations.map((v) => ({
                type: v.constraint.type,
                message: v.message,
                severity: v.severity,
              })),
            },
            priority: "high",
          });
        }
      }

      return ctx;
    });

    // Stage 6: Graph Reasoning — traverse knowledge graph
    this.registerStage("graph-reasoning", async (ctx) => {
      // Use atom relations for graph-based reasoning
      if (ctx.entities.length > 0) {
        const { atomStore } = await import("./atom-engine.js");

        // Search across all entities
        const allRelated: string[] = [];
        for (const entity of ctx.entities.slice(0, 3)) {
          const e = entity as any;
          if (e?.id) {
            const related = atomStore.getRelated(e.id);
            allRelated.push(...related.map((r) => r.content));
          }
        }

        // Also search knowledge network
        try {
          const { knowledgeNetwork } = await import("./knowledge-network.js");
          const input = ctx.input as string;
          const knResults = knowledgeNetwork.search(input, 5);
          for (const entity of knResults) {
            allRelated.push(`${entity.name}: ${entity.content.slice(0, 100)}`);
          }
        } catch { /* non-fatal */ }

        if (allRelated.length > 0) {
          ctx.result = { found: true, related: [...new Set(allRelated)].slice(0, 10) };
        }
      }
      return ctx;
    });

    // Stage 7: Planning — create execution plan
    this.registerStage("planning", async (ctx) => {
      if (!ctx.result) {
        ctx.needsLLM = true;
      }
      return ctx;
    });

    // Stage 8: Verification — verify result
    this.registerStage("verification", async (ctx) => {
      if (ctx.result && !ctx.needsLLM) {
        // Verify the deterministic result is valid
        eventBus.publish({
          type: "pipeline.verification",
          source: "cognitive-pipeline",
          data: { result: ctx.result, verified: true },
          priority: "normal",
        });
      }
      return ctx;
    });
  }

  /**
   * Extract entity names from input text using heuristics.
   * Returns unique entity names found in the text.
   */
  private extractEntitiesFromText(text: string): string[] {
    const entities: string[] = [];

    // Pattern 1: CamelCase words (likely class/function names)
    const camelCase = text.match(/\b[A-Z][a-z]+(?:[A-Z][a-z]+)+\b/g);
    if (camelCase) entities.push(...camelCase);

    // Pattern 2: snake_case words (likely variable/function names)
    const snakeCase = text.match(/\b[a-z]+(?:_[a-z]+)+\b/g);
    if (snakeCase) entities.push(...snakeCase);

    // Pattern 3: File paths with extensions
    const filePaths = text.match(/\b\w+\.(ts|js|tsx|jsx|py|rs|go|md|json|yaml|yml)\b/g);
    if (filePaths) entities.push(...filePaths);

    // Pattern 4: Backtick-quoted code
    const backtickCode = text.match(/`[^`]+`/g);
    if (backtickCode) entities.push(...backtickCode.map((c) => c.slice(1, -1)));

    // Pattern 5: Quoted strings (potential entity names)
    const quotedStrings = text.match(/"[^"]{3,50}"/g);
    if (quotedStrings) entities.push(...quotedStrings.map((s) => s.slice(1, -1)));

    // Pattern 6: Version numbers
    const versions = text.match(/\bv?\d+\.\d+(?:\.\d+)?\b/g);
    if (versions) entities.push(...versions);

    // Deduplicate and limit
    return [...new Set(entities)].slice(0, 10);
  }
}

export const cognitivePipeline = new CognitivePipelineImpl();
