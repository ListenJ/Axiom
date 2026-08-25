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

import { describe, test, expect, beforeEach, afterEach, spyOn, mock } from "bun:test";
import * as riskScreen from "../../src/local-llm/risk-screen.js";
import {
  monitorToolPayload,
  resetRiskVerdictCache,
} from "../../src/agents/risk-monitor.js";
import type { EdgeRiskResult } from "../../src/local-llm/risk-screen.js";

process.env.EDGE_RISK_MONITOR = "1";

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

const TOOL = "browser_launch";
const ARGS = { url: "https://example.com/api" };

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
    const v1 = await monitorToolPayload(TOOL, ARGS);
    const v2 = await monitorToolPayload(TOOL, ARGS);
    expect(v1).toBe("pass");
    expect(v2).toBe("pass");
    expect(screenCalls).toBe(1);
  });

  test("require-approval 可缓存：二次不触达 screen/review 且结论保持", async () => {
    screenImpl = async () => ({ risk: "high", reason: "suspicious" } as EdgeRiskResult);
    const v1 = await monitorToolPayload(TOOL, ARGS);
    const v2 = await monitorToolPayload(TOOL, ARGS);
    expect(v1).toBe("require-approval");
    expect(v2).toBe("require-approval");
    expect(screenCalls).toBe(1);
    expect(reviewState.calls).toBe(1);
  });

  test("degraded low 不缓存：每次真实初筛", async () => {
    screenImpl = async () => ({ risk: "low", degraded: true } as EdgeRiskResult);
    await monitorToolPayload(TOOL, ARGS);
    await monitorToolPayload(TOOL, ARGS);
    expect(screenCalls).toBe(2);
  });

  test("resetRiskVerdictCache 后重新走双层", async () => {
    await monitorToolPayload(TOOL, ARGS);
    expect(screenCalls).toBe(1);
    resetRiskVerdictCache();
    await monitorToolPayload(TOOL, ARGS);
    expect(screenCalls).toBe(2);
  });
});
