/**
 * runToolLoop（/chat 非流式工具循环）DeepSeek 思考模式回传测试：
 * 工具轮次后 assistant 消息携带 reasoning_content，避免官方 400。
 */
import { describe, test, expect, spyOn } from "bun:test";
import { runToolLoop } from "../src/services/tool-loop.js";
import { router } from "../src/router/model-router.js";

describe("runToolLoop DeepSeek reasoning passback", () => {
  test("assistant 工具消息携带拼接后的 reasoning_content", async () => {
    const seen: Array<{ messages: Array<Record<string, unknown>> }> = [];
    const spy = spyOn(router, "executeWithRole").mockImplementation(async (_role, messages) => {
      seen.push({ messages: messages as unknown as Array<Record<string, unknown>> });
      if (seen.length === 1) {
        return {
          content: "",
          model: "deepseek-v4-flash",
          provider: "deepseek",
          endpoint: "",
          latency_ms: 1,
          fallback_used: false,
          toolCalls: [{ id: "c1", type: "function", function: { name: "f", arguments: "{}" } }],
          thinking: ["推理A", "推理B"],
        } as never;
      }
      return {
        content: "ok",
        model: "deepseek-v4-flash",
        provider: "deepseek",
        endpoint: "",
        latency_ms: 1,
        fallback_used: false,
      } as never;
    });

    try {
      const res = await runToolLoop("general-tool", [{ role: "user", content: "hi" }] as never, {
        tools: [],
        executeTool: async () => "ok",
        maxIterations: 2,
      });
      expect(res.content).toBe("ok");
      const round2 = seen[1]?.messages;
      const assistant = round2?.find((m) => m.role === "assistant" && m.tool_calls);
      expect(assistant?.reasoning_content).toBe("推理A推理B");
    } finally {
      spy.mockRestore();
    }
  });
});