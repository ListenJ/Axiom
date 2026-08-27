/**
 * callProviderNativeStream — 原生 SSE 流中解析 tool_calls（按 index 累积片段）。
 */
import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { callProviderNativeStream } from "../../src/router/provider-caller.js";
import type { ToolCallDef } from "../../src/utils/tool-surface.js";

const tools: ToolCallDef[] = [
  { type: "function", function: { name: "skill_run", description: "run skill", parameters: {} } },
];

// bun 1.3.14 对"嵌套对象字面量内嵌含双引号字符串"存在解析怪癖（Windows），
// 故将 JSON 片段提升为顶层常量，在嵌套结构中只做引用。
const ARGS_FRAG_1 = '{"skillId":"code-gen';
const ARGS_FRAG_2 = 'erate"}';

function sseResponse(payloads: string[]): Response {
  const encoder = new TextEncoder();
  const body = payloads.map((p) => `data: ${p}\n\n`).join("");
  return new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(body));
        controller.close();
      },
    }),
    { status: 200 },
  );
}

describe("callProviderNativeStream tool_calls", () => {
  beforeEach(() => {
    process.env.OPENROUTER_API_KEY = "test-key";
  });
  afterEach(() => {
    delete process.env.OPENROUTER_API_KEY;
  });
  test("accumulates fragmented tool_calls from SSE deltas", async () => {
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async () => {
      const chunks = [
        { choices: [{ delta: { role: "assistant" } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "skill_run", arguments: "" } }] } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: ARGS_FRAG_1 } }] } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: ARGS_FRAG_2 } }] } }] },
        { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
      ];
      return sseResponse(chunks.map((c) => JSON.stringify(c)));
    }) as unknown as typeof fetch);
    try {
      const result = await callProviderNativeStream(
        "openrouter", "model-x", [{ role: "user", content: "hi" }], 5000, 0.7,
        () => {}, undefined, undefined, tools,
      );
      expect(result.toolCalls).toHaveLength(1);
      expect(result.toolCalls![0].id).toBe("call_1");
      expect(result.toolCalls![0].function.name).toBe("skill_run");
      expect(JSON.parse(result.toolCalls![0].function.arguments)).toEqual({ skillId: "code-generate" });
    } finally {
      fetchSpy.mockRestore();
    }
  });

  test("returns no toolCalls when stream has none", async () => {
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async () =>
      sseResponse([JSON.stringify({ choices: [{ delta: { content: "hello" } }] }), JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })])
    ) as unknown as typeof fetch);
    try {
      const result = await callProviderNativeStream(
        "openrouter", "model-x", [{ role: "user", content: "hi" }], 5000, 0.7,
        () => {}, undefined, undefined, tools,
      );
      expect(result.content).toBe("hello");
      expect(result.toolCalls).toBeUndefined();
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
