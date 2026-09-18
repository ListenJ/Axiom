/**
 * 工具管道编排器 v3 — 缓存优先 + 区分 model token vs compute
 *
 * 核心原则:
 *   1. 工具执行 (read/write/query) → compute, 不消耗 model token
 *   2. 仅 Tool.consumesModelToken === true 时才计入 model token
 *   3. 缓存优先: 每次执行前先查归一化 query 缓存
 */
import type { ToolContext, ToolInput, Tool } from "./types.js";
import { detectLoop, emitProgress, normalizeQuery, trackModelTokens, recordCacheHit, recordCacheMiss, estimateModelTokens } from "./types.js";

export interface PipelineStep<I, O> {
  tool: Tool<I, O>;
  input: I;
}

export interface PipelineResult {
  stepResults: unknown[];
  totalDurationMs: number;
  computeUnits: number;
  modelTokensUsed: number;
  error?: string;
  aborted: boolean;
}

export async function runPipeline(
  steps: PipelineStep<any, any>[],
  context: ToolContext,
): Promise<PipelineResult> {
  const stepResults: unknown[] = [];
  const pipelineStart = Date.now();
  let computeUnits = 0;
  let modelTokensUsed = 0;

  for (let i = 0; i < steps.length; i++) {
    const { tool, input } = steps[i];

    if (context.aborted) {
      return { stepResults, totalDurationMs: Date.now() - pipelineStart, computeUnits, modelTokensUsed, error: "Aborted", aborted: true };
    }

    const elapsed = Date.now() - context.startTime;
    if (elapsed > context.maxCpuMs) {
      emitProgress(context, "timeout", tool.name, `CPU budget: ${elapsed}ms > ${context.maxCpuMs}ms`);
      return { stepResults, totalDurationMs: Date.now() - pipelineStart, computeUnits, modelTokensUsed, error: `CPU timeout at step ${i}`, aborted: true };
    }

    context.depth++;
    if (context.depth > context.maxDepth) {
      return { stepResults, totalDurationMs: Date.now() - pipelineStart, computeUnits, modelTokensUsed, error: `Max depth ${context.maxDepth}`, aborted: true };
    }

    const inputStr = JSON.stringify(input).slice(0, 200);
    if (detectLoop(tool.name, inputStr)) {
      return { stepResults, totalDurationMs: Date.now() - pipelineStart, computeUnits, modelTokensUsed, error: `Loop detected ${tool.name}`, aborted: true };
    }

    // 缓存优先: 对 query 类工具先查缓存
    if (context.cache && input.query) {
      const cacheKey = `tool:${normalizeQuery(String(input.query))}`;
      const cached = await context.cache.get(cacheKey).catch(() => null);
      if (cached !== null && cached !== undefined) {
        recordCacheHit();
        emitProgress(context, "cache-hit", tool.name, `Cache hit: ${cacheKey}`, Math.round(((i + 1) / steps.length) * 100));
        stepResults.push(cached);
        continue; // 跳过执行 → 不消耗任何 compute/model token
      }
      recordCacheMiss();
      emitProgress(context, "cache-miss", tool.name, `Cache miss: ${cacheKey}`, Math.round((i / steps.length) * 100));
    }

    // 验证
    emitProgress(context, "validate", tool.name, `Validating ${tool.name}...`);
    const validationError = tool.validate?.(input);
    if (validationError) {
      return { stepResults, totalDurationMs: Date.now() - pipelineStart, computeUnits, modelTokensUsed, error: `Validation: ${validationError}`, aborted: true };
    }

    // 执行
    emitProgress(context, "execute", tool.name, `Executing ${tool.name}...`, Math.round((i / steps.length) * 100));
    const stepStart = Date.now();

    try {
      const toolInput: ToolInput<any> = { payload: input, context };
      const output = await tool.execute(toolInput);
      stepResults.push(output.data);

      // 区分 model token vs compute
      if (tool.consumesModelToken) {
        const tokens = estimateModelTokens(JSON.stringify(input)) + estimateModelTokens(JSON.stringify(output.data));
        trackModelTokens(tokens);
        modelTokensUsed += tokens;
        context.modelCalled = true;
      } else {
        computeUnits += output.metrics.computeUnits;
      }

      // 写入缓存
      if (context.cache && tool.name === "query" && output.data?.results?.length > 0) {
        const cacheKey = `tool:${normalizeQuery(String(input.query))}`;
        context.cache.set(cacheKey, output.data, 300_000); // 5min TTL
      }

      emitProgress(context, "complete", tool.name, `${tool.name} done in ${Date.now() - stepStart}ms`);
    } catch (err: unknown) {
      emitProgress(context, "error", tool.name, err instanceof Error ? err.message : String(err));
      return { stepResults, totalDurationMs: Date.now() - pipelineStart, computeUnits, modelTokensUsed, error: `Execution failed: ${err instanceof Error ? err.message : String(err)}`, aborted: false };
    }
  }

  emitProgress(context, "complete", "pipeline", `Pipeline done. compute=${computeUnits} modelTokens=${modelTokensUsed}`, 100);
  return { stepResults, totalDurationMs: Date.now() - pipelineStart, computeUnits, modelTokensUsed, aborted: false };
}
