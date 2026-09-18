/**
 * chatStream 缓冲路径：thinking（reasoning_content）以 _axon 事件先于正文输出。
 * DeepSeek 思考模式经 buffered 回退时，前端仍能看到思维链。
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

describe("router.chatStream buffered reasoning", () => {
  test("buffered fallback emits _axon thinking tokens before content", async () => {
    const findSpy = spyOn(mcr, "findModelsForRole").mockReturnValue([fakeModel] as never);
    const callSpy = spyOn(providerCaller, "callProvider").mockResolvedValue({
      content: "最终答案",
      usage: { total_tokens: 5 },
      thinking: ["推理1", "推理2"],
    } as never);

    try {
      const tokens: string[] = [];
      let doneContent = "";
      for await (const ev of router.chatStream(
        "general-chat",
        [{ role: "user", content: "hi" }] as ChatMessage[],
        { preferNativeStream: false },
      )) {
        if (ev.type === "token") tokens.push(ev.content);
        if (ev.type === "done") doneContent = ev.content;
      }

      expect(tokens).toEqual([
        JSON.stringify({ _axon: "thinking", content: "推理1" }),
        JSON.stringify({ _axon: "thinking", content: "推理2" }),
        "最终答案",
      ]);
      expect(doneContent).toBe("最终答案");
      expect(callSpy).toHaveBeenCalledTimes(1);
    } finally {
      findSpy.mockRestore();
      callSpy.mockRestore();
    }
  });
});