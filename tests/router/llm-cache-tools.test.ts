/**
 * Step 1 回归：带 tools 的请求不得读写 llmCache。
 *
 * 证据：model-router.ts 的 llmCache read/write 只按 temperature===0 门控，未检查
 * !tools?.length；CachedLLMResponse 不含 toolCalls/thinking。结果：
 *   ① 无工具响应缓存后，同消息的带工具请求命中缓存，拿到无 toolCalls 的响应；
 *   ② 工具调用响应（content 常为 null）写入缓存，污染后续同消息请求。
 */
import { describe, test, expect, spyOn, beforeEach, afterEach } from "bun:test";
import * as providerCaller from "../../src/router/provider-caller.js";
import * as mcr from "../../src/router/model-capability-registry.js";
import * as breakerMod from "../../src/utils/circuit-breaker.js";
import { router } from "../../src/router/model-router.js";
import type { ChatMessage } from "../../src/router/provider-caller.js";

const fakeModel = {
  id: "cache-tools-model",
  model: "cache-tools-model",
  provider: "cache-tools-provider",
  priority: 1,
  isFree: true,
  maxRetries: 1,
  timeout: 1000,
};

const toolDef = {
  type: "function" as const,
  function: { name: "skill_run", description: "run skill", parameters: {} },
};

function uniqueMessages(tag: string): ChatMessage[] {
  return [{ role: "user", content: `${tag}-${Date.now()}-${Math.random().toString(36).slice(2)}` }];
}

describe("Step 1 — 带 tools 的请求不得读写 llmCache", () => {
  let allowSpy: ReturnType<typeof spyOn> | undefined;
  let findSpy: ReturnType<typeof spyOn> | undefined;
  let callSpy: ReturnType<typeof spyOn> | undefined;

  beforeEach(() => {
    allowSpy = spyOn(breakerMod.routerBreaker, "allow").mockReturnValue(true);
  });

  afterEach(() => {
    allowSpy?.mockRestore();
    findSpy?.mockRestore();
    callSpy?.mockRestore();
  });

  test("无工具响应缓存后，带工具请求不得命中该缓存", async () => {
    const messages = uniqueMessages("step1-read");
    findSpy = spyOn(mcr, "findModelsForRole").mockReturnValue([fakeModel] as never);
    callSpy = spyOn(providerCaller, "callProvider")
      .mockResolvedValueOnce({ content: "plain-no-tools", usage: { total_tokens: 1 } } as never)
      .mockResolvedValueOnce({
        content: "",
        toolCalls: [{ id: "call_1", type: "function", function: { name: "skill_run", arguments: "{}" } }],
        usage: { total_tokens: 2 },
      } as never);

    const first = await router.execute({ role: "general-chat", messages, temperature: 0 });
    expect(first.content).toBe("plain-no-tools");

    const second = await router.execute({
      role: "general-chat",
      messages,
      temperature: 0,
      tools: [toolDef],
    });

    // 修复前：第二次命中无工具缓存，callProvider 只被调用 1 次且 second.toolCalls 缺失
    expect(callSpy).toHaveBeenCalledTimes(2);
    expect(second.content).toBe("");
    expect(second.toolCalls?.length).toBe(1);
  });

  test("工具调用响应不得写入 llmCache 供后续工具请求命中", async () => {
    const messages = uniqueMessages("step1-write");
    findSpy = spyOn(mcr, "findModelsForRole").mockReturnValue([fakeModel] as never);
    callSpy = spyOn(providerCaller, "callProvider")
      .mockResolvedValueOnce({
        content: "",
        toolCalls: [{ id: "call_1", type: "function", function: { name: "skill_run", arguments: "{}" } }],
        usage: { total_tokens: 1 },
      } as never)
      .mockResolvedValueOnce({
        content: "second-tool-response",
        toolCalls: [{ id: "call_2", type: "function", function: { name: "skill_run", arguments: "{}" } }],
        usage: { total_tokens: 2 },
      } as never);

    const first = await router.execute({
      role: "general-chat",
      messages,
      temperature: 0,
      tools: [toolDef],
    });
    expect(first.toolCalls?.[0]?.id).toBe("call_1");

    const second = await router.execute({
      role: "general-chat",
      messages,
      temperature: 0,
      tools: [toolDef],
    });

    // 修复前：第一次工具响应写入缓存，第二次直接命中坏缓存，callProvider 只被调用 1 次
    expect(callSpy).toHaveBeenCalledTimes(2);
    expect(second.content).toBe("second-tool-response");
    expect(second.toolCalls?.[0]?.id).toBe("call_2");
  });
});
