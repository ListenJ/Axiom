/**
 * Step 2 回归：chatStream 原生流回退 / 永久失败 / 去重 / effectiveTemperature 一致性。
 *
 * 对应计划 Step 2 AC-1~AC-5：
 *   AC-1 已产出 delta 后原生流失败 → 不得回落 buffered 重复整段；
 *   AC-2 chatStream 永久失败不得烧满 maxRetries，应拉黑并切下一模型；
 *   AC-3 batchExecute({preventDuplicateModels:true}) 必须真正串行排除已用模型；
 *   AC-4 落盘记录必须使用 effectiveTemperature；
 *   AC-5 原生流未产出 delta 后回落 buffered 时 fallbackUsed 必须为 true。
 */
import { describe, test, expect, spyOn, beforeEach, afterEach } from "bun:test";
import * as providerCaller from "../../src/router/provider-caller.js";
import * as mcr from "../../src/router/model-capability-registry.js";
import * as breakerMod from "../../src/utils/circuit-breaker.js";
import { router } from "../../src/router/model-router.js";
import { getModelOutputStore } from "../../src/utils/model-output-store.js";
import type { ChatMessage } from "../../src/router/provider-caller.js";

const SUFFIX = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

function model(tag: string, maxRetries = 1) {
  return {
    id: `${tag}-${SUFFIX}/model`,
    model: `${tag}-${SUFFIX}`,
    provider: `${tag}-${SUFFIX}`,
    priority: 1,
    isFree: true,
    maxRetries,
    timeout: 1000,
  };
}

function userMsg(tag: string): ChatMessage[] {
  return [{ role: "user", content: `${tag}-${SUFFIX}` }];
}

describe("Step 2 — chatStream 一致性", () => {
  let allowSpy: ReturnType<typeof spyOn> | undefined;
  let findSpy: ReturnType<typeof spyOn> | undefined;
  let nativeSpy: ReturnType<typeof spyOn> | undefined;
  let bufferedSpy: ReturnType<typeof spyOn> | undefined;

  beforeEach(() => {
    allowSpy = spyOn(breakerMod.routerBreaker, "allow").mockReturnValue(true);
  });

  afterEach(() => {
    allowSpy?.mockRestore();
    findSpy?.mockRestore();
    nativeSpy?.mockRestore();
    bufferedSpy?.mockRestore();
  });

  test("AC-1 已产出 delta 后原生流失败：不回落 buffered、不重复内容", async () => {
    findSpy = spyOn(mcr, "findModelsForRole").mockReturnValue([model("mid")] as never);
    nativeSpy = spyOn(providerCaller, "callProviderNativeStream").mockImplementation(
      (async (_p: unknown, _m: unknown, _msgs: unknown, _t: unknown, _temp: unknown, onChunk: (d: string) => void) => {
        onChunk("partial-");
        throw new Error("mid-stream failure");
      }) as never,
    );
    bufferedSpy = spyOn(providerCaller, "callProvider").mockResolvedValue({
      content: "FULL-BUFFERED",
      usage: { total_tokens: 9 },
    } as never);

    const events: Array<{ type: string; content?: string; fallbackUsed?: boolean }> = [];
    for await (const ev of router.chatStream("general-chat", userMsg("mid-stream"), { preferNativeStream: true })) {
      events.push(ev as never);
    }

    const tokens = events.filter((e) => e.type === "token").map((e) => e.content);
    expect(tokens).toEqual(["partial-"]);
    expect(events.some((e) => e.type === "error")).toBe(true);
    expect(bufferedSpy).not.toHaveBeenCalled();
  });

  test("AC-1b 已产出 delta 后失败：不重试同模型（SSE 不重复内容，轮 7 审计）", async () => {
    // 轮 7 审计 §4.2：nativeEmitted 声明在 attempt 局部——attempt0 原生流产出
    // "partial-" 后 mid-stream 失败，外层 catch 对同模型重试 → 同一条 SSE 流上
    // 第二次产出完整内容（重复）。修复后：已产出 delta 的模型必须直接换模型，
    // 同模型 attempt ≥1 不再发起（本用例 maxRetries=3，失败后 attempts 计数 = 1）。
    const m = model("retrydup", 3);
    findSpy = spyOn(mcr, "findModelsForRole").mockReturnValue([m] as never);
    let nativeAttempts = 0;
    nativeSpy = spyOn(providerCaller, "callProviderNativeStream").mockImplementation(
      (async (_p: unknown, _m: unknown, _msgs: unknown, _t: unknown, _temp: unknown, onChunk: (d: string) => void) => {
        nativeAttempts++;
        onChunk("partial-");
        throw new Error("mid-stream failure");
      }) as never,
    );
    bufferedSpy = spyOn(providerCaller, "callProvider").mockResolvedValue({
      content: "FULL-BUFFERED",
      usage: { total_tokens: 9 },
    } as never);

    const events: Array<{ type: string; content?: string }> = [];
    for await (const ev of router.chatStream("general-chat", userMsg("retrydup"), { preferNativeStream: true })) {
      events.push(ev as never);
    }

    const tokens = events.filter((e) => e.type === "token").map((e) => e.content);
    // 只有一次 "partial-"：无重发（buffered 未调用）、无二次原生尝试
    expect(tokens).toEqual(["partial-"]);
    expect(nativeAttempts).toBe(1);
    expect(bufferedSpy).not.toHaveBeenCalled();
    expect(events.some((e) => e.type === "error")).toBe(true);
  });

  test("AC-2 chatStream 永久失败不烧满重试并切下一模型", async () => {
    const first = model("perm", 3);
    const second = model("perm-ok", 1);
    findSpy = spyOn(mcr, "findModelsForRole").mockReturnValue([first, second] as never);
    const calls: string[] = [];
    bufferedSpy = spyOn(providerCaller, "callProvider").mockImplementation((async (provider: string) => {
      calls.push(provider);
      if (provider === first.provider) throw new Error("Missing API key for permanent model");
      return { content: "ok-from-second", usage: { total_tokens: 1 } };
    }) as never);

    const events: Array<{ type: string; content?: string }> = [];
    for await (const ev of router.chatStream("general-chat", userMsg("perm"), { preferNativeStream: false })) {
      events.push(ev as never);
    }

    expect(calls.filter((c) => c === first.provider)).toHaveLength(1);
    expect(calls).toContain(second.provider);
    expect(events.some((e) => e.type === "done" && e.content === "ok-from-second")).toBe(true);
  });

  test("AC-3 batchExecute preventDuplicateModels 真正排除已用模型", async () => {
    const exclusions: Array<string[] | undefined> = [];
    let n = 0;
    const execSpy = spyOn(router, "executeWithRole").mockImplementation((async (_role: unknown, _messages: unknown, options?: { excludeModels?: string[] }) => {
      exclusions.push(options?.excludeModels);
      n++;
      return {
        role: "general-chat",
        model: n === 1 ? "model-a" : "model-b",
        provider: "p",
        endpoint: "",
        content: `r${n}`,
        latency_ms: 1,
        fallback_used: false,
      };
    }) as never);

    try {
      const results = await router.batchExecute(
        [
          { role: "general-chat", messages: userMsg("batch-a") },
          { role: "general-chat", messages: userMsg("batch-b") },
        ],
        { preventDuplicateModels: true },
      );
      expect(exclusions[0]).toEqual([]);
      expect(exclusions[1]).toEqual(["model-a"]);
      expect(results.map((r) => r.content)).toEqual(["r1", "r2"]);
    } finally {
      execSpy.mockRestore();
    }
  });

  test("AC-4 persist 使用 effectiveTemperature 而非原始 temperature", async () => {
    findSpy = spyOn(mcr, "findModelsForRole").mockReturnValue([model("temp")] as never);
    bufferedSpy = spyOn(providerCaller, "callProvider").mockResolvedValue({
      content: "temp-ok",
      usage: { total_tokens: 1 },
    } as never);
    const persistSpy = spyOn(getModelOutputStore(), "persist").mockImplementation(() => ({ filePath: "/tmp/step2-test.json", success: true }));

    try {
      await router.execute({ role: "english", messages: userMsg("temperature"), temperature: undefined });
      expect(persistSpy).toHaveBeenCalledTimes(1);
      expect((persistSpy.mock.calls[0]?.[0] as { temperature?: number }).temperature).toBe(0);
    } finally {
      persistSpy.mockRestore();
    }
  });

  test("AC-5 原生流未产出 delta 后回落 buffered：fallbackUsed 必须为 true", async () => {
    findSpy = spyOn(mcr, "findModelsForRole").mockReturnValue([model("fb")] as never);
    nativeSpy = spyOn(providerCaller, "callProviderNativeStream").mockImplementation(
      (async () => { throw new Error("native down"); }) as never,
    );
    bufferedSpy = spyOn(providerCaller, "callProvider").mockResolvedValue({
      content: "buffered-ok",
      usage: { total_tokens: 1 },
    } as never);

    const events: Array<{ type: string; content?: string; fallbackUsed?: boolean }> = [];
    for await (const ev of router.chatStream("general-chat", userMsg("fallback"), { preferNativeStream: true })) {
      events.push(ev as never);
    }
    const done = events.find((e) => e.type === "done");
    expect(done?.content).toBe("buffered-ok");
    expect(done?.fallbackUsed).toBe(true);
  });
});
