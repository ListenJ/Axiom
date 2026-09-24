/**
 * 风险复核判定缓存回归测试 — P2-13
 *
 * 缓存仅在生产路径（无注入 deps）启用，故本套件经模块级 mock 驱动真实实现：
 * - screen：spyOn risk-screen 命名空间
 * - review：mock.module 替换 router/model-router，计数 decision 复核调用
 *
 * 行为规格：
 * 1. 同 (kind,payload) 二次调用命中缓存：screen 只调一次，结论一致；
 * 2. require-approval 可缓存：二次不触达 screen/review，结论保持；
 * 3. degraded low（可用性相关）不得缓存：每次都真实初筛；
 * 4. resetRiskVerdictCache 清空后重新走双层。
 */

import { describe, test, expect, beforeEach, afterEach, afterAll, spyOn, mock } from "bun:test";
import * as riskScreen from "../../src/local-llm/risk-screen.js";
import * as realModelRouterModule from "../../src/router/model-router.js";
import {
  screenToolCall,
  resetRiskVerdictCache,
} from "../../src/agents/risk-monitor.js";
import type { EdgeRiskResult } from "../../src/local-llm/risk-screen.js";

// 模块 mock 泄漏防线（口径同 tests/consciousness.test.ts:194-207）：快照须在
// 任何 mock.module 之前求值（mock.module 原地改写命名空间）。
const REAL_MODEL_ROUTER = { ...realModelRouterModule };
const ENV_ORIGINAL_EDGE_RISK_MONITOR = process.env.EDGE_RISK_MONITOR;
process.env.EDGE_RISK_MONITOR = "1";
afterAll(() => {
  mock.module("../../src/router/model-router.js", () => REAL_MODEL_ROUTER);
  // 进程级 env 同样是跨文件共享态：用了就还（chat-memory-loop.test.ts 同款纪律）
  if (ENV_ORIGINAL_EDGE_RISK_MONITOR === undefined) delete process.env.EDGE_RISK_MONITOR;
  else process.env.EDGE_RISK_MONITOR = ENV_ORIGINAL_EDGE_RISK_MONITOR;
});

const reviewState = {
  calls: 0,
  impl: async (): Promise<{ content: string }> =>
    ({ content: '{"dangerous": true, "reason": "destructive"}' }),
};

mock.module("../../src/router/model-router.js", () => ({
  router: {
    execute: async () => {
      reviewState.calls++;
      return reviewState.impl();
    },
  },
}));

// R1：判定输入是**能力**而非工具名。browser_launch 一类"打开远端地址"的工具声明
// net.outbound，缓存键按 (kind="url", payload) 归集 —— 与工具叫什么、由谁包装无关。
const CALL = {
  capabilities: ["net.outbound"] as const,
  args: { url: "https://example.com/api" },
  toolName: "browser_launch",
};

let screenCalls = 0;
let screenImpl = async (): Promise<EdgeRiskResult> => ({ risk: "low" } as EdgeRiskResult);
let screenSpy: ReturnType<typeof spyOn> | null = null;

beforeEach(() => {
  resetRiskVerdictCache();
  reviewState.calls = 0;
  reviewState.impl = async () => ({ content: '{"dangerous": true, "reason": "destructive"}' });
  screenCalls = 0;
  screenImpl = async () => ({ risk: "low" } as EdgeRiskResult);
  screenSpy = spyOn(riskScreen, "screenPayloadWithEdge").mockImplementation(
    async () => {
      screenCalls++;
      return screenImpl();
    }
  );
});

afterEach(() => {
  screenSpy?.mockRestore();
});

describe("风险判定缓存（P2-13，生产路径）", () => {
  test("干净 low 放行被缓存：screen 仅调用一次", async () => {
    const v1 = await screenToolCall(CALL);
    const v2 = await screenToolCall(CALL);
    expect(v1).toBe("pass");
    expect(v2).toBe("pass");
    expect(screenCalls).toBe(1);
  });

  test("require-approval 可缓存：二次不触达 screen/review 且结论保持", async () => {
    screenImpl = async () => ({ risk: "high", reason: "suspicious" } as EdgeRiskResult);
    const v1 = await screenToolCall(CALL);
    const v2 = await screenToolCall(CALL);
    expect(v1).toBe("require-approval");
    expect(v2).toBe("require-approval");
    expect(screenCalls).toBe(1);
    expect(reviewState.calls).toBe(1);
  });

  test("degraded low 不缓存：每次真实初筛", async () => {
    screenImpl = async () => ({ risk: "low", degraded: true } as EdgeRiskResult);
    await screenToolCall(CALL);
    await screenToolCall(CALL);
    expect(screenCalls).toBe(2);
  });

  test("resetRiskVerdictCache 后重新走双层", async () => {
    await screenToolCall(CALL);
    expect(screenCalls).toBe(1);
    resetRiskVerdictCache();
    await screenToolCall(CALL);
    expect(screenCalls).toBe(2);
  });
});
