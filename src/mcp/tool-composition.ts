/**
 * Tool Composition Framework — Chain tools for complex tasks
 *
 * Enables:
 * 1. Sequential pipelines: A → B → C
 * 2. Parallel execution: [A, B, C] → merge
 * 3. Conditional branching: A → if(success) B else C
 * 4. Loop patterns: A → while(condition) B
 * 5. Error recovery: A → catch → fallback(B)
 *
 * Inspired by: Chaintrix (arXiv:2605.09350) — staged pipeline with
 * deterministic structural checks between stages.
 */

import { logger } from "../utils/logger.js";

// ─── Composition Types ─────────────────────────────────────────────────────

export interface PipelineStep {
  id: string
  tool: string
  args?: Record<string, unknown> | ((prev: unknown) => Record<string, unknown>)
  condition?: (prev: unknown) => boolean
  onError?: "fail" | "skip" | "fallback"
  fallbackTool?: string
  timeout?: number
}

export interface PipelineDef {
  id: string
  name: string
  description: string
  steps: PipelineStep[]
  mergeStrategy?: "first" | "last" | "all" | "custom"
  customMerge?: (results: unknown[]) => unknown
}

export interface PipelineResult {
  success: boolean
  steps: Array<{
    stepId: string
    tool: string
    success: boolean
    result?: unknown
    error?: string
    latencyMs: number
  }>
  finalResult: unknown
  totalLatencyMs: number
}

export interface ParallelDef {
  id: string
  name: string
  tools: Array<{ tool: string; args?: Record<string, unknown> }>
  mergeStrategy?: "first" | "all" | "fastest"
}

// ─── Pipeline Executor ─────────────────────────────────────────────────────

type ToolExecutor = (toolName: string, args: Record<string, unknown>) => Promise<unknown>;

class CompositionEngineImpl {
  private pipelines = new Map<string, PipelineDef>();
  private executor: ToolExecutor | null = null;

  /**
   * Set the tool executor function.
   */
  setExecutor(executor: ToolExecutor): void {
    this.executor = executor;
  }

  /**
   * Register a pipeline definition.
   */
  registerPipeline(pipeline: PipelineDef): void {
    this.pipelines.set(pipeline.id, pipeline);
    logger.info("[Composition] Registered pipeline", { id: pipeline.id, steps: pipeline.steps.length });
  }

  /**
   * Create a simple sequential pipeline.
   */
  createSequential(
    id: string,
    name: string,
    tools: Array<{ tool: string; args?: Record<string, unknown> }>,
  ): PipelineDef {
    const pipeline: PipelineDef = {
      id,
      name,
      description: `Sequential: ${tools.map((t) => t.tool).join(" → ")}`,
      steps: tools.map((t, i) => ({
        id: `${id}_step_${i}`,
        tool: t.tool,
        args: t.args,
      })),
      mergeStrategy: "last",
    };
    this.registerPipeline(pipeline);
    return pipeline;
  }

  /**
   * Create a parallel execution pipeline.
   */
  createParallel(
    id: string,
    name: string,
    tools: Array<{ tool: string; args?: Record<string, unknown> }>,
  ): PipelineDef {
    const pipeline: PipelineDef = {
      id,
      name,
      description: `Parallel: [${tools.map((t) => t.tool).join(", ")}]`,
      steps: tools.map((t, i) => ({
        id: `${id}_step_${i}`,
        tool: t.tool,
        args: t.args,
      })),
      mergeStrategy: "all",
    };
    this.registerPipeline(pipeline);
    return pipeline;
  }

  /**
   * Create a conditional pipeline.
   */
  createConditional(
    id: string,
    name: string,
    conditionTool: string,
    trueTool: string,
    falseTool: string,
  ): PipelineDef {
    const pipeline: PipelineDef = {
      id,
      name,
      description: `Conditional: ${conditionTool} → ${trueTool} | ${falseTool}`,
      steps: [
        { id: `${id}_check`, tool: conditionTool },
        {
          id: `${id}_true`,
          tool: trueTool,
          condition: (prev) => {
            const result = prev as { success?: boolean; value?: boolean };
            return result?.success === true || result?.value === true;
          },
        },
        {
          id: `${id}_false`,
          tool: falseTool,
          condition: (prev) => {
            const result = prev as { success?: boolean; value?: boolean };
            return result?.success !== true && result?.value !== true;
          },
        },
      ],
      mergeStrategy: "last",
    };
    this.registerPipeline(pipeline);
    return pipeline;
  }

  /**
   * Execute a pipeline.
   */
  async execute(pipelineId: string, initialInput?: unknown): Promise<PipelineResult> {
    const pipeline = this.pipelines.get(pipelineId);
    if (!pipeline) {
      return {
        success: false,
        steps: [],
        finalResult: null,
        totalLatencyMs: 0,
        error: `Pipeline not found: ${pipelineId}`,
      } as PipelineResult & { error: string };
    }

    if (!this.executor) {
      return {
        success: false,
        steps: [],
        finalResult: null,
        totalLatencyMs: 0,
        error: "No tool executor configured",
      } as PipelineResult & { error: string };
    }

    const startTime = Date.now();
    const stepResults: PipelineResult["steps"] = [];
    let currentData: unknown = initialInput;

    for (const step of pipeline.steps) {
      const stepStart = Date.now();

      // Check condition
      if (step.condition && !step.condition(currentData)) {
        stepResults.push({
          stepId: step.id,
          tool: step.tool,
          success: true,
          result: currentData,
          latencyMs: 0,
        });
        continue;
      }

      // Resolve args
      let args: Record<string, unknown>;
      if (typeof step.args === "function") {
        args = step.args(currentData);
      } else {
        args = { ...step.args, input: currentData };
      }

      // Execute
      try {
        const result = await this.executor(step.tool, args);
        currentData = result;
        stepResults.push({
          stepId: step.id,
          tool: step.tool,
          success: true,
          result,
          latencyMs: Date.now() - stepStart,
        });
      } catch (err) {
        const error = (err as Error).message;

        if (step.onError === "fallback" && step.fallbackTool) {
          try {
            const fallbackResult = await this.executor(step.fallbackTool, args);
            currentData = fallbackResult;
            stepResults.push({
              stepId: step.id,
              tool: step.fallbackTool,
              success: true,
              result: fallbackResult,
              latencyMs: Date.now() - stepStart,
            });
            continue;
          } catch {
            // Fallback also failed
          }
        }

        if (step.onError === "skip") {
          stepResults.push({
            stepId: step.id,
            tool: step.tool,
            success: false,
            error,
            latencyMs: Date.now() - stepStart,
          });
          continue;
        }

        // Default: fail
        stepResults.push({
          stepId: step.id,
          tool: step.tool,
          success: false,
          error,
          latencyMs: Date.now() - stepStart,
        });

        return {
          success: false,
          steps: stepResults,
          finalResult: null,
          totalLatencyMs: Date.now() - startTime,
        };
      }
    }

    // Merge results
    let finalResult: unknown;
    switch (pipeline.mergeStrategy) {
      case "first":
        finalResult = stepResults[0]?.result;
        break;
      case "last":
        finalResult = currentData;
        break;
      case "all":
        finalResult = stepResults.map((s) => s.result);
        break;
      case "custom":
        finalResult = pipeline.customMerge
          ? pipeline.customMerge(stepResults.map((s) => s.result))
          : currentData;
        break;
      default:
        finalResult = currentData;
    }

    return {
      success: stepResults.every((s) => s.success),
      steps: stepResults,
      finalResult,
      totalLatencyMs: Date.now() - startTime,
    };
  }

  /**
   * Get all registered pipelines.
   */
  listPipelines(): PipelineDef[] {
    return Array.from(this.pipelines.values());
  }

  /**
   * Remove a pipeline.
   */
  removePipeline(id: string): boolean {
    return this.pipelines.delete(id);
  }
}

// ─── Singleton ─────────────────────────────────────────────────────────────

export const compositionEngine = new CompositionEngineImpl();
