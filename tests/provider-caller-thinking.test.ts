/**
 * provider-caller 思考模式开关 + reasoning_content 消息净化测试
 *  - DeepSeek：thinking 默认 enabled，override.thinking=false → disabled
 *  - 非 DeepSeek 供应商发送前剥离 reasoning_content（防未知字段污染）
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { callProvider } from "../src/router/provider-caller.js";

const originalFetch = globalThis.fetch;
const originalDeepseekKey = process.env.DEEPSEEK_API_KEY;
const originalZhipuKey = process.env.ZHIPU_API_KEY;

beforeEach(() => {
  process.env.DEEPSEEK_API_KEY = "test-deepseek-key";
  process.env.ZHIPU_API_KEY = "test-zhipu-key";
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalDeepseekKey === undefined) delete process.env.DEEPSEEK_API_KEY;
  else process.env.DEEPSEEK_API_KEY = originalDeepseekKey;
  if (originalZhipuKey === undefined) delete process.env.ZHIPU_API_KEY;
  else process.env.ZHIPU_API_KEY = originalZhipuKey;
});

function mockFetchCapture(): { body: () => Record<string, unknown> } {
  let sentBody: Record<string, unknown> | null = null;
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    sentBody = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({ choices: [{ message: { content: "hi" } }] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { body: () => sentBody ?? {} };
}

describe("DeepSeek 思考模式开关", () => {
  it("默认 thinking.type=enabled", async () => {
    const { body } = mockFetchCapture();
    await callProvider("deepseek", "deepseek-v4-flash", [{ role: "user", content: "hi" }], 5000);
    expect((body().thinking as { type?: string })?.type).toBe("enabled");
  });

  it("override.thinking=false 时 thinking.type=disabled（非思考模式）", async () => {
    const { body } = mockFetchCapture();
    await callProvider("deepseek", "deepseek-v4-flash", [{ role: "user", content: "hi" }], 5000, 0.7, "high", undefined, { thinking: false });
    expect((body().thinking as { type?: string })?.type).toBe("disabled");
  });
});

describe("reasoning_content 消息净化", () => {
  it("DeepSeek 保留 reasoning_content（工具轮次回传）", async () => {
    const { body } = mockFetchCapture();
    await callProvider("deepseek", "deepseek-v4-flash", [
      { role: "assistant", content: "", tool_calls: [], reasoning_content: "思考过程" },
    ] as never, 5000);
    const msgs = body().messages as Array<Record<string, unknown>>;
    expect(msgs[0]?.reasoning_content).toBe("思考过程");
  });

  it("非 DeepSeek 供应商剥离 reasoning_content", async () => {
    const { body } = mockFetchCapture();
    await callProvider("zhipu", "glm-5.2", [
      { role: "assistant", content: "", tool_calls: [], reasoning_content: "思考过程" },
    ] as never, 5000);
    const msgs = body().messages as Array<Record<string, unknown>>;
    expect(msgs[0]?.reasoning_content).toBeUndefined();
  });
});