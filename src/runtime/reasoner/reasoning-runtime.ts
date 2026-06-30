/**
 * Reasoning Runtime — 独立推理引擎
 *
 * 从 scheduler.ts 中拆分出来，独立负责"逻辑与真理"。
 * Scheduler 只负责"资源与时间"。
 *
 * 职责：
 * - 确定性推理管道 (Cognitive Pipeline)
 * - 推理图构建 (Reasoning Graph)
 * - 差距检测 (Gap Detection)
 * - LLM 碎片化调用
 *
 * 订阅 Event Bus 事件，不再由 Scheduler 直接调用。
 */

import { logger } from "../../utils/logger.js";
import { eventBus, worldState } from "../kernel.js";

export type PipelineStage =
  | "perception" | "memory_retrieval" | "reasoning" | "planning" | "verification" | "execution" | "consolidation"
  | "observation" | "normalization" | "entity-resolution" | "state-update" | "constraint-check" | "graph-reasoning"
  | "llm-assist" | "reflection";
export interface PipelineContext {
  stage: PipelineStage;
  input: string;
  output?: string;
  result?: unknown;
  needsLLM: boolean;
  stageTimings: Map<string, number>;
  startTime: number;
  atoms: unknown[];
  entities: unknown[];
  stateChanges: unknown[];
  constraints: unknown[];
  violations: unknown[];
  plan: unknown;
  metadata?: Record<string, unknown>;
}

type StageHandler = (ctx: PipelineContext) => Promise<PipelineContext>;

/**
 * Reasoning Runtime — 独立推理引擎
 */
export class ReasoningRuntime {
  private stages = new Map<PipelineStage, StageHandler>();
  private stats = { runs: 0, llmCalls: 0, deterministicWins: 0, gapsDetected: 0 };

  constructor() {
    this.registerDefaultStages();
    this.subscribeToEvents();
  }

  /**
   * Subscribe to Event Bus events.
   */
  private subscribeToEvents(): void {
    // Listen for reasoning requests
    eventBus.subscribe("reasoning.request", async (event) => {
      const { input, requestId } = event.data as { input: string; requestId: string };
      const result = await this.run(input);

      eventBus.publish({
        type: "reasoning.result",
        source: "reasoning-runtime",
        data: { requestId, result },
        priority: "normal",
        replyTo: event.id,
      });
    });
  }

  /**
   * Register a stage handler.
   */
  registerStage(stage: PipelineStage, handler: StageHandler): void {
    this.stages.set(stage, handler);
  }

  /**
   * Run the reasoning pipeline on an input.
   */
  async run(input: string): Promise<PipelineContext> {
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
          logger.error(`[ReasoningRuntime] Stage ${stage} failed`, err instanceof Error ? err : new Error(String(err)));
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
        source: "reasoning-runtime",
        data: { input: ctx.input, stage: ctx.stage },
        priority: "high",
      });

      // LLM result would be filled in by the LLM actor
      ctx.result = { needsLLM: true, reason: "Deterministic pipeline insufficient" };
    }

    // Reflection stage
    ctx.stage = "reflection";
    eventBus.publish({
      type: "pipeline.completed",
      source: "reasoning-runtime",
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
   * Get reasoning stats.
   */
  getStats(): { runs: number; llmCalls: number; deterministicWins: number; deterministicRate: number; gapsDetected: number } {
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
        const { atomStore } = await import("../atom-engine.js");
        const { memoryEngine } = await import("../memory-engine.js");
        const { knowledgeNetwork } = await import("../knowledge-network.js");

        // Search atoms
        ctx.atoms = atomStore.search(ctx.input, 10);

        // Search memory
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
      const { atomStore } = await import("../atom-engine.js");

      const input = ctx.input as string;

      // Search for known entities
      const searchResults = atomStore.search(input, 20);
      ctx.entities = searchResults.filter((a) =>
        a.kind === "entity" || a.kind === "class" || a.kind === "function" ||
        a.kind === "concept" || a.kind === "fact"
      );

      // Also check knowledge network
      try {
        const { knowledgeNetwork } = await import("../knowledge-network.js");
        const knResults = knowledgeNetwork.search(input, 10);
        for (const entity of knResults) {
          if (!ctx.entities.some((e: any) => e.id === entity.id)) {
            ctx.entities.push(entity);
          }
        }
      } catch { /* non-fatal */ }

      return ctx;
    });

    // Stage 4: State Update — update world state
    this.registerStage("state-update", async (ctx) => {
      worldState.update("cognitive.lastObservation", () => ({
        timestamp: Date.now(),
        atomCount: ctx.atoms.length,
        entityCount: ctx.entities.length,
        input: (ctx.input as string).slice(0, 200),
      }));

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
      const { constraintSolver } = await import("../constraint-solver.js");
      const entityIds = ctx.entities.map((e: any) => e.id || e.content).filter(Boolean);

      if (entityIds.length > 0) {
        const constraintResult = constraintSolver.solve(entityIds);
        ctx.constraints = constraintResult.violations;

        if (!constraintResult.satisfied) {
          eventBus.publish({
            type: "pipeline.constraint_violation",
            source: "reasoning-runtime",
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
      if (ctx.entities.length > 0) {
        const { atomStore } = await import("../atom-engine.js");

        const allRelated: string[] = [];
        for (const entity of ctx.entities.slice(0, 3)) {
          const e = entity as any;
          if (e?.id) {
            const related = atomStore.getRelated(e.id);
            allRelated.push(...related.map((r) => r.content));
          }
        }

        try {
          const { knowledgeNetwork } = await import("../knowledge-network.js");
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

    // Stage 7: Planning — attempt deterministic planning before LLM fallback
    this.registerStage("planning", async (ctx) => {
      if (!ctx.result) {
        // Try to decompose the input into sub-tasks
        const input = ctx.input as string;
        const subTasks: string[] = [];

        // Check if input contains multiple questions/requests
        const sentences = input.split(/[.!?;]\s+/).filter((s) => s.trim().length > 10);
        if (sentences.length > 1) {
          subTasks.push(...sentences.map((s) => s.trim()));
        }

        // Check if we can solve any sub-tasks deterministically
        try {
          const { knowledgeNetwork } = await import("../knowledge-network.js");
          const solvable: string[] = [];

          for (const task of subTasks.slice(0, 5)) {
            const results = knowledgeNetwork.search(task, 3);
            if (results.length > 0 && results[0].confidence > 0.7) {
              solvable.push(`${task} → ${results[0].name}`);
            }
          }

          if (solvable.length > 0) {
            ctx.result = {
              found: true,
              related: solvable,
              plan: { subTasks, solvable: solvable.length, total: subTasks.length },
            };
            return ctx;
          }
        } catch { /* non-fatal */ }

        // No deterministic solution found
        ctx.needsLLM = true;
      }
      return ctx;
    });

    // Stage 8: Verification — verify result using verification engine
    this.registerStage("verification", async (ctx) => {
      if (ctx.result && !ctx.needsLLM) {
        try {
          const { verificationEngine } = await import("../verification-engine.js");
          const report = verificationEngine.verifyResult(
            `pipeline_${Date.now()}`,
            JSON.stringify(ctx.result),
          );

          const verified = report.overallVerdict === "pass";
          const confidence = report.overallConfidence;

          eventBus.publish({
            type: "pipeline.verification",
            source: "reasoning-runtime",
            data: {
              result: ctx.result,
              verified,
              confidence,
              issues: report.issues.map((i) => i.description),
            },
            priority: "normal",
          });

          // If verification fails, mark as needing LLM
          if (!verified && confidence < 0.5) {
            ctx.needsLLM = true;
          }
        } catch {
          // Fallback: publish without verification
          eventBus.publish({
            type: "pipeline.verification",
            source: "reasoning-runtime",
            data: { result: ctx.result, verified: false, confidence: 0 },
            priority: "normal",
          });
        }
      }
      return ctx;
    });
  }
}

// ─── Singleton ─────────────────────────────────────────────────────────────

let _reasoningRuntime: ReasoningRuntime | null = null;

export function getReasoningRuntime(): ReasoningRuntime {
  if (!_reasoningRuntime) {
    _reasoningRuntime = new ReasoningRuntime();
  }
  return _reasoningRuntime;
}
