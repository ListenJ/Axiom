/**
 * Fix 1 回归测试（HIGH）：chatStream 原生流路径失败时，必须调用
 * routerBreaker.recordFailure(breakerKey)，然后再回退到缓冲路径。
 * 保证：熔断器能感知模型在本回合已失败；同时 buffered 回退只重试一次（不再额外双调一次同 provider）。
 */
import { describe, test, expect, spyOn, beforeEach, afterEach } from "bun:test";
import * as providerCaller from "../../src/router/provider-caller.js";
import * as mcr from "../../src/router/model-capability-registry.js";
import * as breakerMod from "../../src/utils/circuit-breaker.js";
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

describe("router.chatStream native-stream failure → breaker + buffered fallback", () => {
  let breakSpy: ReturnType<typeof spyOn> | undefined;
  let allowSpy: ReturnType<typeof spyOn> | undefined;

  beforeEach(() => {
    const rb = breakerMod.routerBreaker;
    breakSpy = spyOn(rb, "recordFailure");
    allowSpy = spyOn(rb, "allow").mockReturnValue(true);
  });

  afterEach(() => {
    breakSpy?.mockRestore();
    allowSpy?.mockRestore();
  });

  test("native stream throws for model A → recordFailure + buffered fallback attempted once", async () => {
    const findSpy = spyOn(mcr, "findModelsForRole").mockReturnValue([fakeModel] as never);
    const nativeSpy = spyOn(providerCaller, "callProviderNativeStream").mockImplementation(
      async () => { throw new Error("fetch unavailable"); },
    );
    const bufferedSpy = spyOn(providerCaller, "callProvider").mockResolvedValue({
      content: "buffered-ok",
      usage: { total_tokens: 5 },
    } as never);

    try {
      const types: string[] = [];
      let doneContent = "";
      for await (const ev of router.chatStream("general-chat", [{ role: "user", content: "hi" }] as ChatMessage[], {
        preferNativeStream: true,
      })) {
        types.push(ev.type);
        if (ev.type === "done") doneContent = ev.content;
      }

      // 关键断言：熔断器被通知模型失败（之前实现缺失此调用）
      expect(breakSpy).toHaveBeenCalledTimes(1);
      expect(breakSpy).toHaveBeenCalledWith("fake/fake/model");

      // 原生流调用一次（抛出），缓冲回退调用一次（成功）
      expect(nativeSpy).toHaveBeenCalledTimes(1);
      expect(bufferedSpy).toHaveBeenCalledTimes(1);

      // 流结束正常
      expect(types).toContain("done");
      expect(types).not.toContain("error");
      expect(doneContent).toBe("buffered-ok");
    } finally {
      findSpy.mockRestore();
      nativeSpy.mockRestore();
      bufferedSpy.mockRestore();
    }
  });

  test("buffered fallback also fails → single retry loop catches it and records failure again", async () => {
    const findSpy = spyOn(mcr, "findModelsForRole").mockReturnValue([fakeModel] as never);
    const nativeSpy = spyOn(providerCaller, "callProviderNativeStream").mockImplementation(
      async () => { throw new Error("native fail"); },
    );
    const bufferedSpy = spyOn(providerCaller, "callProvider").mockImplementation(
      async () => { throw new Error("buffered also fails"); },
    );

    try {
      const types: string[] = [];
      for await (const ev of router.chatStream("general-chat", [{ role: "user", content: "hi" }] as ChatMessage[], {
        preferNativeStream: true,
      })) {
        types.push(ev.type);
      }

      // 原生失败 + buffered 再失败 = 两次 recordFailure（同一 breakerKey）
      expect(breakSpy).toHaveBeenCalledTimes(2);
      const calls = breakSpy.mock.calls as Array<Array<string>>;
      expect(calls.every((c) => c[0] === "fake/fake/model")).toBe(true);

      // 最终降级到 error 事件
      expect(types).toContain("error");
      expect(nativeSpy).toHaveBeenCalledTimes(1);
      expect(bufferedSpy).toHaveBeenCalledTimes(1);
    } finally {
      findSpy.mockRestore();
      nativeSpy.mockRestore();
      bufferedSpy.mockRestore();
    }
  });
});
