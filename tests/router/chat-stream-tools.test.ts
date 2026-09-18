/**
 * chatStream 流式工具循环 — 模型在流式对话中按需调用工具，最终文本仍逐 token 流式输出。
 */
import { describe, test, expect, spyOn } from "bun:test";
import * as providerCaller from "../../src/router/provider-caller.js";
import * as mcr from "../../src/router/model-capability-registry.js";
import { router } from "../../src/router/model-router.js";
import type { ChatMessage } from "../../src/router/provider-caller.js";

const fakeModel = {
  id: "fake/model",
  model: "fake/model",
  provider: "fake",
  priority: 1,
  isFree: true,
  maxRetries: 1,
  timeout: 1000,
};

const tools = [
  { type: "function" as const, function: { name: "skill_run", description: "run skill", parameters: {} } },
];

describe("router.chatStream tool loop", () => {
  test("executes tool calls server-side then streams the final answer", async () => {
    const findSpy = spyOn(mcr, "findModelsForRole").mockReturnValue([fakeModel] as never);
    let round = 0;
    const streamSpy = spyOn(providerCaller, "callProviderNativeStream").mockImplementation(
      async (_provider, _model, _messages, _timeout, _temp, onChunk) => {
        round++;
        if (round === 1) {
          return {
            content: "",
            toolCalls: [
              { id: "call_1", type: "function", function: { name: "skill_run", arguments: JSON.stringify({ skillId: "code-generate" }) } },
            ],
          } as never;
        }
        onChunk("Hello ");
        onChunk("world");
        return { content: "Hello world", usage: { total_tokens: 5 } } as never;
      },
    );
    try {
      const executed: string[] = [];
      const types: string[] = [];
      let finalContent = "";

      for await (const ev of router.chatStream("general-chat", [{ role: "user", content: "hi" }] as ChatMessage[], {
        preferNativeStream: true,
        tools,
        executeTool: async (name, args) => {
          executed.push(`${name}:${(args as { skillId: string }).skillId}`);
          return "ok";
        },
        maxToolIterations: 4,
      })) {
        types.push(ev.type);
        if (ev.type === "token") finalContent += ev.content;
        if (ev.type === "tool") expect(ev.name).toBe("skill_run");
        if (ev.type === "done") expect(ev.content).toBe("Hello world");
      }

      expect(executed).toEqual(["skill_run:code-generate"]);
      expect(types).toContain("tool");
      expect(types).toContain("token");
      expect(types).toContain("done");
      expect(types).not.toContain("error");
      expect(finalContent).toBe("Hello world");
      expect(streamSpy).toHaveBeenCalledTimes(2);
    } finally {
      findSpy.mockRestore();
      streamSpy.mockRestore();
    }
  });

  test("emits error after max tool iterations", async () => {
    const findSpy = spyOn(mcr, "findModelsForRole").mockReturnValue([fakeModel] as never);
    const streamSpy = spyOn(providerCaller, "callProviderNativeStream").mockImplementation(
      async () =>
        ({
          content: "",
          toolCalls: [{ id: "call_1", type: "function", function: { name: "skill_run", arguments: "{}" } }],
        }) as never,
    );
    try {
      const types: string[] = [];
      for await (const ev of router.chatStream("general-chat", [{ role: "user", content: "hi" }] as ChatMessage[], {
        preferNativeStream: true,
        tools,
        executeTool: async () => "ok",
        maxToolIterations: 2,
      })) {
        types.push(ev.type);
      }
      expect(types).toContain("error");
      expect(streamSpy).toHaveBeenCalledTimes(2);
    } finally {
      findSpy.mockRestore();
      streamSpy.mockRestore();
    }
  });
});
