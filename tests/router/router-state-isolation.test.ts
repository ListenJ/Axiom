/**
 * RouterState 状态隔离回归（2026-10-19 方案 B）
 *
 * 背景：`modelBlacklist` / `routerBreaker` 原为模块级/进程级可变状态，一次真实
 * 永久性失败（如 CI 干净检出无 .env：`Missing API key`）会把模型全局拉黑 5 分钟，
 * 进而污染同进程后续 router 用例 → `All models exhausted`。
 * 见 docs/reports/2026-10-19-full-test-failure-diagnosis.md 第 1 节。
 *
 * 契约：默认路由（进程级单例）与构造时注入 `createRouterState()` 的路由实例，
 * 黑名单/熔断状态互不影响。
 */
import { describe, test, expect, spyOn } from "bun:test";
import * as providerCaller from "../../src/router/provider-caller.js";
import * as mcr from "../../src/router/model-capability-registry.js";
import {
  router,
  MultiPlatformRouter,
  createRouterState,
  recordPermanentFailure,
  isModelBlacklisted,
} from "../../src/router/model-router.js";
import type { ChatMessage } from "../../src/router/provider-caller.js";

const fakeModel = {
  id: "isolation-fake/fake-model",
  model: "fake-model",
  provider: "isolation-fake",
  priority: 1,
  isFree: true,
  maxRetries: 1,
  timeout: 1000,
};

const messages: ChatMessage[] = [{ role: "user", content: "hi" }];

/** 收集一次 chatStream 的事件类型 */
async function streamTypes(r: MultiPlatformRouter): Promise<string[]> {
  const types: string[] = [];
  for await (const ev of r.chatStream("general-chat", messages, { preferNativeStream: true })) {
    types.push(ev.type);
  }
  return types;
}

describe("RouterState 状态隔离", () => {
  test("默认单例被永久失败拉黑后，注入干净状态的 router 仍能正常路由", async () => {
    // 污染默认全局状态（等价于另一测试文件里真实链路用例缺 key 后的永久失败拉黑）。
    // 使用独有的 provider/model 标识，不污染其它用例依赖的真实模型名。
    recordPermanentFailure("isolation-fake", "fake-model");
    expect(isModelBlacklisted("isolation-fake", "fake-model")).toBe(true);

    const findSpy = spyOn(mcr, "findModelsForRole").mockReturnValue([fakeModel] as never);
    const streamSpy = spyOn(providerCaller, "callProviderNativeStream").mockResolvedValue({
      content: "ok",
    } as never);
    try {
      // 默认单例：命中黑名单 → 不发请求 → error
      expect(await streamTypes(router)).toContain("error");
      expect(streamSpy).not.toHaveBeenCalled();

      // 注入干净状态：黑名单为空 → 正常调用并产出 done
      const state = createRouterState();
      expect(state.isModelBlacklisted("isolation-fake", "fake-model")).toBe(false);
      const cleanRouter = new MultiPlatformRouter({ state });
      expect(await streamTypes(cleanRouter)).toContain("done");
      expect(streamSpy).toHaveBeenCalledTimes(1);
    } finally {
      findSpy.mockRestore();
      streamSpy.mockRestore();
    }
  });
});
