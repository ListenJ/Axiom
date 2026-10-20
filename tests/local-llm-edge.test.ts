/**
 * 边缘小模型层 (src/local-llm/) 单元测试
 *
 * 覆盖:
 * - LLMClient chatTemplateKwargs 透传 (enable_thinking: false)
 * - getEdgeClient 单例与默认配置
 * - isEdgeEnabled 功能开关
 * - extractJson 容错解析
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { spawnSync } from "node:child_process";
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
  // 2026-09-20：EDGE_LLM_URL 由"有默认值"改为**必填**（原默认 9001 实测无人监听）。
  // ⚠️ 必须在 beforeAll 里设、用完立刻还原 —— 若放在**模块作用域**，会因"Bun 先加载全部文件再执行"
  // 而泄漏到同进程的其它测试文件（实测会让 chat-memory-loop 假通过，掩盖真失败）。
  const prevUrl = process.env.EDGE_LLM_URL;
  beforeAll(() => { process.env.EDGE_LLM_URL = "http://127.0.0.1:19999"; });
  afterAll(() => {
    if (prevUrl === undefined) delete process.env.EDGE_LLM_URL;
    else process.env.EDGE_LLM_URL = prevUrl;
  });

  test("返回单例", () => {
    const a = getEdgeClient();
    const b = getEdgeClient();
    expect(a).toBe(b);
    expect(a).toBeInstanceOf(LLMClient);
  });
});

describe("isEdgeEnabled", () => {
  test("未设置时默认关闭（LLM 默认不调用，需显式授权）", () => {
    delete process.env.EDGE_TEST_FLAG;
    expect(isEdgeEnabled("EDGE_TEST_FLAG")).toBe(false);
  });

  test("显式授权 =1 时启用", () => {
    process.env.EDGE_TEST_FLAG = "1";
    try {
      expect(isEdgeEnabled("EDGE_TEST_FLAG")).toBe(true);
    } finally {
      delete process.env.EDGE_TEST_FLAG;
    }
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

describe("getEdgeClient 配置缺失（2026-09-20 裁定）", () => {
  test("未配置 EDGE_LLM_URL 时应立即报错（不再默认 127.0.0.1:9001）", () => {
    // 单例已在同进程创建过，故用独立进程验证"缺配置"分支
    const r = spawnSync(
      "bun",
      ["-e", 'const m=await import("./src/local-llm/edge-client.ts"); try { m.getEdgeClient(); console.log("NO_THROW"); } catch (e) { console.log("THREW:" + (e as Error).message.slice(0,40)); }'],
      // 超时兜底（2026-10-19）：原先无 timeout，子进程挂死会让用例永久挂起
      { encoding: "utf8", cwd: process.cwd(), env: { ...process.env, EDGE_LLM_URL: "" }, timeout: 60_000 },
    );
    const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
    expect(out).toContain("THREW:");
    expect(out).toContain("EDGE_LLM_URL");
    // 用例预算（2026-10-19）：体内嵌套 bun 子进程，默认 5s 会误报失败
  }, 90_000);
});
