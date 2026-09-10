/**
 * provider-caller 思考强度透传测试
 * 验证 callProvider 请求体包含 buildReasoningParams 生成的供应商参数。
 *
 * 隔离策略（避免并发 flaky）：
 *   - API key 经 process.env 注入（getEffectiveApiKey 回退读 env），
 *     不 mock.module api-key-store —— 避免污染同批运行的其他测试。
 *   - fetch 每个用例内替换、afterEach 恢复；用例间不共享状态。
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { callProvider } from "../src/router/provider-caller.js";

const originalFetch = globalThis.fetch;
const originalKey = process.env.OPENCODE_API_KEY;
const originalSiliconKey = process.env.SILICONFLOW_API_KEY;

beforeEach(() => {
  process.env.OPENCODE_API_KEY = "test-key";
  process.env.SILICONFLOW_API_KEY = "test-sf-key";
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalKey === undefined) delete process.env.OPENCODE_API_KEY;
  else process.env.OPENCODE_API_KEY = originalKey;
  if (originalSiliconKey === undefined) delete process.env.SILICONFLOW_API_KEY;
  else process.env.SILICONFLOW_API_KEY = originalSiliconKey;
});

function mockFetchOnce(): { body: () => Record<string, unknown> } {
  let sentBody: Record<string, unknown> | null = null;
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    sentBody = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({ choices: [{ message: { content: "hi" } }], usage: null }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { body: () => sentBody ?? {} };
}

describe("callProvider 思考强度透传", () => {
  it("OpenAI 兼容供应商请求体包含 reasoning_effort", async () => {
    const { body } = mockFetchOnce();
    await callProvider("opencode", "model-x", [{ role: "user", content: "hi" }], 5000, 0.7, "high");
    expect(body().reasoning_effort).toBe("high");
  });

  it("不传 effort 时请求体含默认档位 medium", async () => {
    const { body } = mockFetchOnce();
    await callProvider("opencode", "model-x", [{ role: "user", content: "hi" }], 5000);
    expect(body().reasoning_effort).toBe("medium"); // 默认档位
  });

  it("非 OpenAI 兼容供应商映射各自参数格式（siliconflow）", async () => {
    const { body } = mockFetchOnce();
    await callProvider("siliconflow", "model-x", [{ role: "user", content: "hi" }], 5000, 0.7, "high");
    expect(body().enable_thinking).toBe(true);
    expect(body().thinking_budget).toBe(8192);
  });
});
