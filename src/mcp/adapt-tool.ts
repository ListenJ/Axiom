/**
 * adaptTool — 将 src/tools/ Tool<I,O> 适配到 src/mcp/ ToolDef
 *
 * 桥接两个工具系统，使 Pipeline 的缓存优先/循环检测/进度/资源限制
 * 在实际 MCP 工具调用中生效。
 *
 * P2.1（2026-10-22）：上下文不再用裸 createToolContext（空 localStore ⇒ queryTool 的
 * 本地记忆腿/统一搜索腿被静默跳过），改为 createInjectedToolContext 注入
 * vaultManager / searchEngine，并把 typed 降级原因带进上下文；工具在输出中如实标注。
 */
import { z } from "zod";
import type { Tool, ToolContext } from "../tools/types.js";
import type { ToolDef } from "./tool-registry.js";
import {
  createInjectedToolContext,
  type ToolRuntimeDepsProviders,
  type ToolRuntimeDepsStatus,
} from "../tools/runtime-deps.js";
import { logger } from "../utils/logger.js";

/** adaptTool 覆盖项：既有 tags/format + P2.1 的运行时依赖/上下文工厂注入缝（测试用）。 */
export interface AdaptToolOptions extends Partial<Pick<ToolDef, "tags" | "format">> {
  /** 测试接缝：替换 vault / searchEngine 加载器（默认走真实模块） */
  runtimeDeps?: ToolRuntimeDepsProviders;
  /** 测试接缝：替换上下文工厂（默认 createInjectedToolContext） */
  contextFactory?: (
    requestId: string,
  ) => Promise<{ context: ToolContext; status: ToolRuntimeDepsStatus }>;
}

/**
 * 将一个 Tool<I,O> 适配为 MCP ToolDef。
 * handler 内部调用 tool.execute，并通过 validate 做运行时校验。
 */
export function adaptTool<I, O>(
  tool: Tool<I, O>,
  overrides?: AdaptToolOptions,
): ToolDef {
  return {
    name: tool.name,
    description: tool.description,
    capability: [...tool.capability],
    inputSchema: z.object({}).passthrough(),
    handler: async (args: Record<string, unknown>): Promise<O> => {
      // 运行时校验
      if (tool.validate) {
        const err = tool.validate(args as I);
        if (err) throw new Error(`Validation failed for ${tool.name}: ${err}`);
      }

      const factory =
        overrides?.contextFactory ??
        ((requestId: string) =>
          createInjectedToolContext(requestId, { providers: overrides?.runtimeDeps }));
      const { context: pipelineCtx, status } = await factory(
        `mcp-${tool.name}-${Date.now()}`,
      );
      if (status.degraded.length > 0) {
        // 逐调用可见：即使 warn-once 已由 runtime-deps 打过，这里也把本次工具名与原因记下，
        // 以便日志能回答「哪次工具调用在降级状态下跑了」。
        logger.debug("[adaptTool] 工具在依赖降级状态下执行", {
          tool: tool.name,
          reasons: status.degraded,
        });
      }

      const output = await tool.execute({ payload: args as I, context: pipelineCtx });

      logger.debug(`[adaptTool] ${tool.name} completed`, {
        durationMs: output.metrics.durationMs,
        computeUnits: output.metrics.computeUnits,
        degraded: status.degraded.length > 0 ? status.degraded : undefined,
      });

      return output.data;
    },
    format: overrides?.format ?? "json",
    tags: overrides?.tags ?? ["pipeline"],
  };
}

/** 同时注册多个工具（覆盖项透传给每个 adaptTool） */
export function adaptTools(tools: Tool<any, any>[], overrides?: AdaptToolOptions): ToolDef[] {
  return tools.map((t) => adaptTool(t, overrides));
}
