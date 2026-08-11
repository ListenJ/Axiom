/**
 * runToolLoop — 原生 function-calling 工具循环测试。
 *
 * Contract:
 *   - 模型无 tool_calls → 直接返回；
 *   - 有 tool_calls → 执行工具 → 追加 assistant/tool 消息 → 再调模型（有界循环）；
 *   - 工具抛错 → 作为 tool 结果返回，不中断循环；
 *   - 超过 maxIterations → 返回最后一次响应。
 */
import { describe, test, expect, spyOn } from "bun:test";
import { runToolLoop } from "../../src/services/tool-loop.js";
import { router, type SmartAssignmentResponse } from "../../src/router/model-router.js";
import type { ToolCallDef } from "../../src/utils/tool-surface.js";

const tools: ToolCallDef[] = [
  { type: "function", function: { name: "skill_run", description: "run a skill", parameters: {} } },
];

function resp(content: string | null, toolCalls?: SmartAssignmentResponse["toolCalls"]): SmartAssignmentResponse {
  return {
    role: "general-chat",
    model: "m",
    provider: "p",
    endpoint: "",
    content,
    usage: { total_tokens: 1 },
    latency_ms: 1,
    fallback_used: false,
    ...(toolCalls ? { toolCalls } : {}),
  };
}

const skillCall: NonNullable<SmartAssignmentResponse["toolCalls"]>[number] = {
  id: "call_1",
  type: "function",
  function: { name: "skill_run", arguments: JSON.stringify({ skillId: "code-generate", params: { input: "hi" } }) },
};

const baseMessages = [{ role: "user" as const, content: "hi" }];

describe("runToolLoop", () => {
  test("returns immediately when model makes no tool calls", async () => {
    const executeSpy = spyOn(router, "executeWithRole").mockImplementation(async () => resp("final answer"));
    try {
      const out = await runToolLoop("general-chat", baseMessages, {
        tools,
        executeTool: async () => "x",
      });
      expect(out.content).toBe("final answer");
      expect(executeSpy).toHaveBeenCalledTimes(1);
    } finally {
      executeSpy.mockRestore();
    }
  });

  test("passes tools to the router, executes calls, appends tool results and loops", async () => {
    const executed: string[] = [];
    let round = 0;
    const executeSpy = spyOn(router, "executeWithRole").mockImplementation(
      async (_role, _messages, options) => {
        round++;
        if (round === 1) {
          expect(options?.tools).toHaveLength(1);
          return resp(null, [skillCall]);
        }
        const msgs = _messages as Array<{ role: string; content: string }>;
        expect(msgs.some((m) => m.role === "assistant")).toBe(true);
        expect(msgs.some((m) => m.role === "tool")).toBe(true);
        return resp("final");
      },
    );
    try {
      const out = await runToolLoop("general-chat", baseMessages, {
        tools,
        executeTool: async (name, args) => {
          executed.push(`${name}:${(args as { skillId: string }).skillId}`);
          return "ok";
        },
      });
      expect(executed).toEqual(["skill_run:code-generate"]);
      expect(out.content).toBe("final");
      expect(executeSpy).toHaveBeenCalledTimes(2);
    } finally {
      executeSpy.mockRestore();
    }
  });

  test("surfaces tool errors as results and continues", async () => {
    let round = 0;
    const executeSpy = spyOn(router, "executeWithRole").mockImplementation(async () => {
      round++;
      if (round === 1) return resp(null, [skillCall]);
      return resp("recovered");
    });
    try {
      const out = await runToolLoop("general-chat", baseMessages, {
        tools,
        executeTool: async () => {
          throw new Error("boom");
        },
      });
      expect(out.content).toBe("recovered");
    } finally {
      executeSpy.mockRestore();
    }
  });

  test("stops after max iterations", async () => {
    const executeSpy = spyOn(router, "executeWithRole").mockImplementation(async () =>
      resp(null, [skillCall]),
    );
    try {
      const out = await runToolLoop("general-chat", baseMessages, {
        tools,
        executeTool: async () => "ok",
        maxIterations: 2,
      });
      expect(executeSpy).toHaveBeenCalledTimes(2);
      // 超过轮数：返回最后一次响应（模型仍只发起了工具调用，content 可为 null）
      expect(out.toolCalls).toBeDefined();
    } finally {
      executeSpy.mockRestore();
    }
  });
});
