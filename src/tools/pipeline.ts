/**
 * 工具管道编排器 v2 — 进度回调 + Token 预算 + 循环保护 + 超时终止
 */
import type { ToolContext, ToolInput } from "./types.js";
import { detectLoop, emitProgress, consumeTokens, estimateTokens } from "./types.js";

export interface PipelineStep<I, O> {
  tool: Tool<I, O>;
  input: I;
}

export interface PipelineResult {
  stepResults: unknown[];
  totalDurationMs: number;
  totalTokens: number;
  error?: string;
  aborted: boolean;
}

/** 导入 Tool 类型（避免循环引用） */
import type { Tool } from "./types.js";

export async function runPipeline(
  steps: PipelineStep<any, any>[],
  context: ToolContext,
): Promise<PipelineResult> {
  const stepResults: unknown[] = [];
  const pipelineStart = Date.now();
  let totalTokens = 0;

  for (let i = 0; i < steps.length; i++) {
    const { tool, input } = steps[i];

    // ── 终止检查 ──
    if (context.aborted) {
      return {
        stepResults,
        totalDurationMs: Date.now() - pipelineStart,
        totalTokens,
        error: "Pipeline aborted by resource limit",
        aborted: true,
      };
    }

    // ── CPU 预算检查 ──
    const elapsed = Date.now() - context.startTime;
    if (elapsed > context.maxCpuMs) {
      emitProgress(context, "timeout", tool.name, `CPU budget exceeded: ${elapsed}ms > ${context.maxCpuMs}ms`);
      return {
        stepResults,
        totalDurationMs: Date.now() - pipelineStart,
        totalTokens,
        error: `CPU budget exceeded at step ${i} (${tool.name}): ${elapsed}ms > ${context.maxCpuMs}ms`,
        aborted: true,
      };
    }

    // ── 深度检查 ──
    context.depth++;
    if (context.depth > context.maxDepth) {
      emitProgress(context, "loop-detected", tool.name, `Max depth exceeded: ${context.depth}`);
      return {
        stepResults,
        totalDurationMs: Date.now() - pipelineStart,
        totalTokens,
        error: `Max pipeline depth exceeded: ${context.depth} > ${context.maxDepth}`,
        aborted: true,
      };
    }

    // ── 循环检测 ──
    const inputStr = JSON.stringify(input).slice(0, 200);
    if (detectLoop(tool.name, inputStr)) {
      emitProgress(context, "loop-detected", tool.name, `Same input seen 5+ times in 60s`);
      return {
        stepResults,
        totalDurationMs: Date.now() - pipelineStart,
        totalTokens,
        error: `Loop detected: ${tool.name} called with same input 5+ times in 60s`,
        aborted: true,
      };
    }

    // ── Token 预算检查 ──
    if (!consumeTokens(context, inputStr)) {
      return {
        stepResults,
        totalDurationMs: Date.now() - pipelineStart,
        totalTokens,
        error: `Token budget exceeded at step ${i}`,
        aborted: true,
      };
    }

    // ── 验证 ──
    emitProgress(context, "validate", tool.name, `Validating input for ${tool.name}`, 0);
    const validationError = tool.validate?.(input);
    if (validationError) {
      return {
        stepResults,
        totalDurationMs: Date.now() - pipelineStart,
        totalTokens,
        error: `Validation failed at step ${i} (${tool.name}): ${validationError}`,
        aborted: true,
      };
    }

    // ── 执行 ──
    emitProgress(context, "execute", tool.name, `Executing ${tool.name}...`, Math.round((i / steps.length) * 100));
    const stepStart = Date.now();

    try {
      const toolInput: ToolInput<any> = { payload: input, context };
      const output = await tool.execute(toolInput);
      stepResults.push(output.data);
      totalTokens += output.metrics.tokensUsed;

      emitProgress(context, "complete", tool.name,
        `${tool.name} done in ${Date.now() - stepStart}ms, ${output.metrics.tokensUsed} tokens`,
        Math.round(((i + 1) / steps.length) * 100),
      );
    } catch (err: unknown) {
      emitProgress(context, "error", tool.name, err instanceof Error ? err.message : String(err));
      return {
        stepResults,
        totalDurationMs: Date.now() - pipelineStart,
        totalTokens,
        error: `Execution failed at step ${i} (${tool.name}): ${err instanceof Error ? err.message : String(err)}`,
        aborted: false,
      };
    }
  }

  emitProgress(context, "complete", "pipeline", `Pipeline done in ${Date.now() - pipelineStart}ms`, 100);

  return {
    stepResults,
    totalDurationMs: Date.now() - pipelineStart,
    totalTokens,
    aborted: false,
  };
}
