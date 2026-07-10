/**
 * adaptTool — 将 src/tools/ Tool<I,O> 适配到 src/mcp/ ToolDef
 *
 * 桥接两个工具系统，使 Pipeline 的缓存优先/循环检测/进度/资源限制
 * 在实际 MCP 工具调用中生效。
 */
import { z } from "zod";
import type { Tool } from "../tools/types.js";
import type { ToolDef } from "./tool-registry.js";
import { createToolContext } from "../tools/types.js";
import { logger } from "../utils/logger.js";

/**
 * 将一个 Tool<I,O> 适配为 MCP ToolDef。
 * handler 内部调用 tool.execute，并通过 validate 做运行时校验。
 */
export function adaptTool<I, O>(
  tool: Tool<I, O>,
  overrides?: Partial<Pick<ToolDef, "tags" | "format">>,
): ToolDef {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: z.object({}).passthrough(),
    handler: async (args: Record<string, unknown>): Promise<O> => {
      // 运行时校验
      if (tool.validate) {
        const err = tool.validate(args as I);
        if (err) throw new Error(`Validation failed for ${tool.name}: ${err}`);
      }

      const pipelineCtx = createToolContext(`mcp-${tool.name}-${Date.now()}`);
      const output = await tool.execute({ payload: args as I, context: pipelineCtx });

      logger.debug(`[adaptTool] ${tool.name} completed`, {
        durationMs: output.metrics.durationMs,
        computeUnits: output.metrics.computeUnits,
      });

      return output.data;
    },
    format: overrides?.format ?? "json",
    tags: overrides?.tags ?? ["pipeline"],
  };
}

/** 同时注册多个工具 */
export function adaptTools(tools: Tool<any, any>[]): ToolDef[] {
  return tools.map((t) => adaptTool(t));
}
