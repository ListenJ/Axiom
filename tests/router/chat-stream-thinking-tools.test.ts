/**
 * chatStream 工具循环 × DeepSeek 思考模式：
 *  - 工具轮次后把 reasoning_content 回传给下一轮（官方 400 约束）
 *  - 排序使用 effectivePriorityForRateTier（峰谷调度接入点）
 */
import { describe, test, expect, spyOn } from "bun:test";
import * as providerCaller from "../../src/router/provider-caller.js";
import * as mcr from "../../src/router/model-capability-registry.js";
import * as rateTier from "../../src/router/rate-tier.js";
import { router } from "../../src/router/model-router.js";
import type { ChatMessage } from "../../src/router/provider-caller.js";

const tools = [
  { type: "function" as const, function: { name: "skill_run", description: "run skill", parameters: {} } },
];

describe("router.chatStream tool loop reasoning passback", () => {
  test("DeepSeek 思考模式：下一轮请求携带 assistant reasoning_content", async () => {
    const findSpy = spyOn(mcr, "findModelsForRole").mockReturnValue([
      { id: "deepseek/v4-flash", model: "deepseek-v4-flash", provider: "deepseek", priority: 1, isFree: true, maxRetries: 1, timeout: 1000 },
    ] as never);
    const seen: ChatMessage[][] = [];
    const streamSpy = spyOn(providerCaller, "callProviderNativeStream").mockImplementation(
      async (_provider, _model, messages) => {
        seen.push(messages);
        if (seen.length === 1) {
          return {
            content: "",
            toolCalls: [
              { id: "call_1", type: "function", function: { name: "skill_run", arguments: "{}" } },
            ],
            thinking: ["第一步推理", "，第二步推理"],
          } as never;
        }
        return { content: "最终答案", thinking: ["收尾推理"] } as never;
      },
    );

    try {
      const types: string[] = [];
      for await (const ev of router.chatStream("general-chat", [{ role: "user", content: "hi" }] as ChatMessage[], {
        preferNativeStream: true,
        tools,
        executeTool: async () => "ok",
        maxToolIterations: 4,
      })) {
        types.push(ev.type);
      }

      expect(types).toContain("tool");
      expect(types).toContain("done");
      expect(types).not.toContain("error");
      // 第二轮 messages：assistant 工具消息必须携带拼接后的 reasoning_content
      const round2 = seen[1];
      const assistant = round2?.find((m) => m.role === "assistant" && m.tool_calls);
      expect(assistant?.reasoning_content).toBe("第一步推理，第二步推理");
    } finally {
      findSpy.mockRestore();
      streamSpy.mockRestore();
    }
  });
});

describe("router sorting uses effectivePriorityForRateTier", () => {
  test("峰谷优先级驱动排序（pro 被压后 → flash 先被调用）", async () => {
    const findSpy = spyOn(mcr, "findModelsForRole").mockReturnValue([
      { id: "deepseek/v4-pro", model: "deepseek-v4-pro", provider: "deepseek", priority: 1, isFree: false, maxRetries: 1, timeout: 1000 },
      { id: "deepseek/v4-flash", model: "deepseek-v4-flash", provider: "deepseek", priority: 2, isFree: false, maxRetries: 1, timeout: 1000 },
    ] as never);
    const tierSpy = spyOn(rateTier, "effectivePriorityForRateTier").mockImplementation((m: { model: string }) =>
      (m.model === "deepseek-v4-pro" ? 9 : 2),
    );
    const calledModels: string[] = [];
    const streamSpy = spyOn(providerCaller, "callProviderNativeStream").mockImplementation(
      async (_provider, model) => {
        calledModels.push(model);
        return { content: "ok" } as never;
      },
    );

    try {
      for await (const _ev of router.chatStream("general-chat", [{ role: "user", content: "hi" }] as ChatMessage[], {
        preferNativeStream: true,
      })) {
        // drain
      }
      expect(calledModels[0]).toBe("deepseek-v4-flash");
    } finally {
      findSpy.mockRestore();
      tierSpy.mockRestore();
      streamSpy.mockRestore();
    }
  });
});