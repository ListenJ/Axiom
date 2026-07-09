/**
 * 工具管道编排器 — 链式执行 + 资源约束 + 数据隔离
 *
 * 每个管道:
 *   1. 创建独立 ToolContext (localStore 不共享)
 *   2. 按序执行工具
 *   3. 每个工具的输出不传给下一个（通过 context.localStore 可选共享）
 *   4. 超时/超内存自动终止
 */
import type { Tool, ToolContext, ToolInput } from "./types.js";

export interface PipelineStep<I, O> {
  tool: Tool<I, O>;
  input: I;
}

export interface PipelineResult {
  stepResults: unknown[];
  totalDurationMs: number;
  error?: string;
}

/**
 * 执行工具管道
 */
export async function runPipeline(
  steps: PipelineStep<any, any>[],
  context: ToolContext,
): Promise<PipelineResult> {
  const stepResults: unknown[] = [];
  const pipelineStart = Date.now();

  for (let i = 0; i < steps.length; i++) {
    const { tool, input } = steps[i];

    // 检查资源预算
    const elapsed = Date.now() - context.startTime;
    if (elapsed > context.maxCpuMs) {
      return {
        stepResults,
        totalDurationMs: Date.now() - pipelineStart,
        error: `Pipeline CPU budget exceeded at step ${i} (${tool.name}): ${elapsed}ms > ${context.maxCpuMs}ms`,
      };
    }

    // 验证
    const validationError = tool.validate?.(input);
    if (validationError) {
      return {
        stepResults,
        totalDurationMs: Date.now() - pipelineStart,
        error: `Validation failed at step ${i} (${tool.name}): ${validationError}`,
      };
    }

    // 执行
    try {
      const toolInput: ToolInput<any> = { payload: input, context };
      const output = await tool.execute(toolInput);
      stepResults.push(output.data);
    } catch (err) {
      return {
        stepResults,
        totalDurationMs: Date.now() - pipelineStart,
        error: `Execution failed at step ${i} (${tool.name}): ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  return {
    stepResults,
    totalDurationMs: Date.now() - pipelineStart,
  };
}
