/**
 * runToolLoop — 原生 function-calling 工具循环（内部聊天模型按需调用工具）。
 *
 * 流程（有界循环，默认最多 4 轮）：
 *   1. 携带 tools 调用 router.executeWithRole；
 *   2. 无 tool_calls → 直接返回最终响应；
 *   3. 有 tool_calls → 执行 executeTool → 追加 assistant(tool_calls) + tool 结果消息 → 回到 1；
 *   4. 工具抛错 → 作为 { error } 结果返回给模型，不中断循环。
 *
 * 依赖注入（规则 8）：tools 与 executeTool 由调用方提供（routes 层接 SkillRegistry），
 * 本模块不创建依赖。
 */
import { router, type ChatMessage, type SmartAssignmentResponse } from "../router/model-router.js";
import type { TaskRole } from "../router/model-capability-registry.js";
import type { ToolCallDef } from "../utils/tool-surface.js";

export interface ToolLoopOptions {
  tools: ToolCallDef[];
  executeTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  maxIterations?: number;
  temperature?: number;
}

const DEFAULT_MAX_TOOL_ITERATIONS = 4;
const DEFAULT_TOOL_TEMPERATURE = 0.3;

function parseArgs(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export async function runToolLoop(
  role: string,
  messages: ChatMessage[],
  options: ToolLoopOptions,
): Promise<SmartAssignmentResponse> {
  const maxIterations = options.maxIterations ?? DEFAULT_MAX_TOOL_ITERATIONS;
  const current: ChatMessage[] = [...messages];
  let lastResponse: SmartAssignmentResponse | null = null;

  for (let iteration = 0; iteration < maxIterations; iteration++) {
    const response = await router.executeWithRole(role as TaskRole, current, {
      tools: options.tools,
      temperature: options.temperature ?? DEFAULT_TOOL_TEMPERATURE,
    });
    lastResponse = response;

    if (!response.toolCalls || response.toolCalls.length === 0) {
      return { ...response, layer: "general" };
    }

    current.push({
      role: "assistant",
      content: response.content ?? "",
      tool_calls: response.toolCalls,
    });

    for (const call of response.toolCalls) {
      let output: unknown;
      try {
        output = await options.executeTool(call.function.name, parseArgs(call.function.arguments));
      } catch (err) {
        output = { error: (err as Error).message };
      }
      current.push({
        role: "tool",
        tool_call_id: call.id,
        content: typeof output === "string" ? output : JSON.stringify(output),
      });
    }
  }

  return (
    lastResponse ?? {
      role: role as TaskRole,
      model: "none",
      provider: "local",
      endpoint: "",
      content: "[Tool loop] exceeded max iterations without a final answer.",
      usage: undefined,
      latency_ms: 0,
      fallback_used: true,
      layer: "general",
    }
  );
}
