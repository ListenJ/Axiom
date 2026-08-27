/**
 * provider-caller reasoning_content 透传测试
 * DeepSeek 思考模式：思维链经 delta.reasoning_content 流式返回（官方文档 2026-08-14）。
 * 验证：
 *   - 原生流式：reasoning_content 封装为 _axon thinking 事件逐片透传，且结果带 thinking[]
 *   - 非流式：message.reasoning_content 进入返回值 thinking[]
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { callProvider, callProviderNativeStream } from "../src/router/provider-caller.js";

const originalFetch = globalThis.fetch;
const originalKey = process.env.DEEPSEEK_API_KEY;

beforeEach(() => {
  process.env.DEEPSEEK_API_KEY = "test-deepseek-key";
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalKey === undefined) delete process.env.DEEPSEEK_API_KEY;
  else process.env.DEEPSEEK_API_KEY = originalKey;
});

function sseResponse(lines: string[]): Response {
  const payload = lines.join("\n") + "\n";
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(payload));
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

describe("callProviderNativeStream reasoning_content 透传", () => {
  it("思考片段封装为 _axon thinking 事件并进入结果 thinking[]", async () => {
    globalThis.fetch = (async () =>
      sseResponse([
        'data: {"choices":[{"delta":{"reasoning_content":"第一步"}}]}',
        'data: {"choices":[{"delta":{"reasoning_content":"，第二步"}}]}',
        'data: {"choices":[{"delta":{"content":"最终答案"}}]}',
        "data: [DONE]",
      ])) as unknown as typeof fetch;

    const chunks: string[] = [];
    const result = await callProviderNativeStream(
      "deepseek",
      "deepseek-v4-flash",
      [{ role: "user", content: "hi" }],
      5000,
      0.7,
      (c) => chunks.push(c),
    );

    expect(chunks).toEqual([
      JSON.stringify({ _axon: "thinking", content: "第一步" }),
      JSON.stringify({ _axon: "thinking", content: "，第二步" }),
      "最终答案",
    ]);
    expect(result.content).toBe("最终答案");
    expect(result.thinking).toEqual(["第一步", "，第二步"]);
  });

  it("无思考片段时 thinking 为 undefined，不发送 _axon 事件", async () => {
    globalThis.fetch = (async () =>
      sseResponse([
        'data: {"choices":[{"delta":{"content":"hello"}}]}',
        "data: [DONE]",
      ])) as unknown as typeof fetch;

    const chunks: string[] = [];
    const result = await callProviderNativeStream(
      "deepseek",
      "deepseek-v4-flash",
      [{ role: "user", content: "hi" }],
      5000,
      0.7,
      (c) => chunks.push(c),
    );

    expect(chunks).toEqual(["hello"]);
    expect(result.thinking).toBeUndefined();
  });
});

describe("callProvider 非流式 reasoning_content 透传", () => {
  it("返回 message.reasoning_content 到 thinking[]", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { content: "答案", reasoning_content: "推理过程" } }],
          usage: { total_tokens: 3 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )) as unknown as typeof fetch;

    const result = await callProvider(
      "deepseek",
      "deepseek-v4-flash",
      [{ role: "user", content: "hi" }],
      5000,
    );

    expect(result.content).toBe("答案");
    expect(result.thinking).toEqual(["推理过程"]);
  });
});