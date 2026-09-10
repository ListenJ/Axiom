/**
 * 边缘小模型层 (src/local-llm/) 单元测试
 *
 * 覆盖:
 * - LLMClient chatTemplateKwargs 透传 (enable_thinking: false)
 * - getEdgeClient 单例与默认配置
 * - isEdgeEnabled 功能开关
 * - extractJson 容错解析
 */
import { describe, test, expect } from "bun:test";
import { LLMClient } from "../src/dre/llm/client.js";
import { getEdgeClient, isEdgeEnabled, extractJson } from "../src/local-llm/edge-client.js";

describe("LLMClient chatTemplateKwargs", () => {  test("请求体携带 chat_template_kwargs", async () => {
    let capturedBody: Record<string, unknown> | null = null;
    const server = Bun.serve({
      port: 0,
      fetch: async (req) => {
        capturedBody = await req.json() as Record<string, unknown>;
        return Response.json({
          id: "mock",
          model: "mock",
          choices: [{ message: { role: "assistant", content: "{}" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        });
      },
    });

    try {
      const client = new LLMClient({
        baseUrl: `http://127.0.0.1:${server.port}`,
        model: "test",
        chatTemplateKwargs: { enable_thinking: false },
      });
      await client.generate("hi");
      expect(capturedBody).not.toBeNull();
      expect(capturedBody!.chat_template_kwargs).toEqual({ enable_thinking: false });
    } finally {
      server.stop();
    }
  });

  test("未配置时请求体不含 chat_template_kwargs", async () => {
    let capturedBody: Record<string, unknown> | null = null;
    const server = Bun.serve({
      port: 0,
      fetch: async (req) => {
        capturedBody = await req.json() as Record<string, unknown>;
        return Response.json({
          id: "mock",
          model: "mock",
          choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        });
      },
    });

    try {
      const client = new LLMClient({ baseUrl: `http://127.0.0.1:${server.port}`, model: "test" });
      await client.generate("hi");
      expect(capturedBody).not.toBeNull();
      expect("chat_template_kwargs" in capturedBody!).toBe(false);
    } finally {
      server.stop();
    }
  });
});

describe("LLMClient completion transport", () => {
  test("transport=completion 走 /completion, 剥离 think 块并拼回 answerPrefix", async () => {
    let capturedUrl = "";
    let capturedBody: Record<string, unknown> | null = null;
    const server = Bun.serve({
      port: 0,
      fetch: async (req) => {
        capturedUrl = new URL(req.url).pathname;
        capturedBody = await req.json() as Record<string, unknown>;
        // 模拟真实续写: 模型从前缀 '{"risk":"' 处继续, 且先泄漏了一段 think
        return Response.json({
          content: '<think>想一下</think>high"}',
          stop: true,
          model: "mock",
          tokens_evaluated: 10,
          tokens_predicted: 5,
        });
      },
    });

    try {
      const client = new LLMClient({
        baseUrl: `http://127.0.0.1:${server.port}`,
        model: "test",
        transport: "completion",
      });
      const r = await client.generate("风险: rm -rf /", { system: "你是分类器", answerPrefix: '{"risk":"' });
      expect(capturedUrl).toBe("/completion");
      expect(capturedBody!.prompt as string).toContain("你是分类器");
      expect(capturedBody!.prompt as string).toContain('Answer: {"risk":"');
      expect(r.content).toBe('{"risk":"high"}');
      expect(r.finishReason).toBe("stop");
      expect(r.usage.completionTokens).toBe(5);
    } finally {
      server.stop();
    }
  });
});

describe("getEdgeClient", () => {
  test("返回单例", () => {
    const a = getEdgeClient();
    const b = getEdgeClient();
    expect(a).toBe(b);
    expect(a).toBeInstanceOf(LLMClient);
  });
});

describe("isEdgeEnabled", () => {
  test("未设置时默认开启", () => {
    delete process.env.EDGE_TEST_FLAG;
    expect(isEdgeEnabled("EDGE_TEST_FLAG")).toBe(true);
  });

  test("'0' 或 'false' 关闭", () => {
    process.env.EDGE_TEST_FLAG = "0";
    expect(isEdgeEnabled("EDGE_TEST_FLAG")).toBe(false);
    process.env.EDGE_TEST_FLAG = "false";
    expect(isEdgeEnabled("EDGE_TEST_FLAG")).toBe(false);
    delete process.env.EDGE_TEST_FLAG;
  });
});

describe("extractJson", () => {
  test("解析纯 JSON", () => {
    expect(extractJson<{ a: number }>('{"a": 1}')).toEqual({ a: 1 });
  });

  test("剥离 markdown code fence", () => {
    expect(extractJson<{ a: number }>('```json\n{"a": 2}\n```')).toEqual({ a: 2 });
  });

  test("从混杂文本中提取首个 JSON 对象", () => {
    expect(extractJson<{ a: number }>('答案是 {"a": 3} 完毕')).toEqual({ a: 3 });
  });

  test("垃圾输入返回 null", () => {
    expect(extractJson("not json at all")).toBeNull();
  });
});
