/**
 * 轻任务默认非思考 → 路由层对 DeepSeek 下发 thinking:false
 */
import { describe, test, expect, spyOn } from "bun:test";
import * as providerCaller from "../../src/router/provider-caller.js";
import * as mcr from "../../src/router/model-capability-registry.js";
import { MultiPlatformRouter, createRouterState } from "../../src/router/model-router.js";

// 干净路由状态：不继承同进程其它测试文件（如真实链路用例）留下的永久失败黑名单/熔断状态。
// 见 docs/reports/2026-10-19-full-test-failure-diagnosis.md 第 1 节。
const router = new MultiPlatformRouter({ state: createRouterState() });

const deepseekModel = {
  id: "deepseek/v4-flash",
  model: "deepseek-v4-flash",
  provider: "deepseek",
  priority: 1,
  isFree: false,
  maxRetries: 1,
  timeout: 1000,
};

describe("router light-role default non-thinking", () => {
  test("general-tool → override.thinking=false", async () => {
    const findSpy = spyOn(mcr, "findModelsForRole").mockReturnValue([deepseekModel] as never);
    const seen: Array<{ thinking?: boolean }> = [];
    const streamSpy = spyOn(providerCaller, "callProviderNativeStream").mockImplementation(
      async (_p, _m, _msg, _t, _temp, _cb, _sig, _effort, _tools, override) => {
        seen.push(override ?? {});
        return { content: "ok" } as never;
      },
    );

    try {
      for await (const _ev of router.chatStream("general-tool", [{ role: "user", content: "hi" }] as never, {
        preferNativeStream: true,
      })) {
        // drain
      }
      expect(seen[0]?.thinking).toBe(false);
    } finally {
      findSpy.mockRestore();
      streamSpy.mockRestore();
    }
  });

  test("research → override.thinking 未设置（默认思考开启）", async () => {
    const findSpy = spyOn(mcr, "findModelsForRole").mockReturnValue([deepseekModel] as never);
    const seen: Array<{ thinking?: boolean }> = [];
    const streamSpy = spyOn(providerCaller, "callProviderNativeStream").mockImplementation(
      async (_p, _m, _msg, _t, _temp, _cb, _sig, _effort, _tools, override) => {
        seen.push(override ?? {});
        return { content: "ok" } as never;
      },
    );

    try {
      for await (const _ev of router.chatStream("research", [{ role: "user", content: "hi" }] as never, {
        preferNativeStream: true,
      })) {
        // drain
      }
      expect(seen[0]?.thinking).toBeUndefined();
    } finally {
      findSpy.mockRestore();
      streamSpy.mockRestore();
    }
  });
});