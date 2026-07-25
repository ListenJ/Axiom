/**
 * 提示词优化器测试 —— 验证 src/agents/prompt-optimizer.ts
 *
 * 改写默认开启（Qwopus3.5-4B 实测改写忠实），但必须过三重闸门：
 *   输出校验（长度/非空）→ 语言一致性（确定性）→ LLM 忠实度判别
 * 任一闸门失败或模型异常都回退原文。通过注入 fake client 测试, 不访问真实端点。
 */
import { describe, test, expect } from "bun:test";
import { optimizePromptWithEdge, shouldSkipOptimization } from "../src/agents/prompt-optimizer.js";

/**
 * 构造 fake LLM client。handler 按 prompt 内容区分改写请求与忠实度判别请求。
 */
function fakeClient(handler: (prompt: string) => { content: string }) {
  let calls = 0;
  return {
    client: {
      generate: async (prompt: string) => {
        calls++;
        const r = handler(prompt);
        return {
          content: r.content,
          model: "mock",
          usage: { promptTokens: 0, completionTokens: 0 },
          finishReason: "stop",
        };
      },
    },
    getCalls: () => calls,
  };
}

const LONG_INPUT = "帮我分析一下这个项目的知识库检索模块的性能瓶颈在哪里，并给出优化建议";
const GOOD_REWRITE = "请分析本项目知识库检索模块的性能瓶颈，并给出可执行的优化建议。";

/** handler 快捷构造：改写返回 rewrite，忠实度判别返回 faithful */
function handlerReturning(rewrite: string, faithful: boolean) {
  return (prompt: string) => {
    if (prompt.includes("判断改写是否忠实")) {
      return { content: JSON.stringify({ faithful }) };
    }
    return { content: rewrite };
  };
}

describe("shouldSkipOptimization", () => {
  test("短输入跳过", () => {
    expect(shouldSkipOptimization("你好")).toBe(true);
    expect(shouldSkipOptimization("ok 谢谢")).toBe(true);
  });

  test("含代码块跳过", () => {
    expect(shouldSkipOptimization("这段代码为什么报错 ```js\nconsole.log(x)\n``` 帮我看看")).toBe(true);
  });

  test("命令/斜杠前缀跳过", () => {
    expect(shouldSkipOptimization("$ npm run build 失败了")).toBe(true);
    expect(shouldSkipOptimization("/help 看看有什么命令可以用")).toBe(true);
  });

  test("普通长输入不跳过", () => {
    expect(shouldSkipOptimization(LONG_INPUT)).toBe(false);
  });
});

describe("optimizePromptWithEdge", () => {
  test("改写忠实时采用（调用改写+判别两次）", async () => {
    const { client, getCalls } = fakeClient(handlerReturning(GOOD_REWRITE, true));
    const result = await optimizePromptWithEdge(LONG_INPUT, client);
    expect(getCalls()).toBe(2);
    expect(result.changed).toBe(true);
    expect(result.text).toContain("性能瓶颈");
  });

  test("忠实度判别拒绝时回退原文", async () => {
    const { client } = fakeClient(handlerReturning("请提供检索信息以便我帮助你。", false));
    const result = await optimizePromptWithEdge(LONG_INPUT, client);
    expect(result.changed).toBe(false);
    expect(result.text).toBe(LONG_INPUT);
  });

  test("语言漂移被确定性检查拦截（中文输入英文输出）", async () => {
    const { client } = fakeClient(handlerReturning("Please analyze the performance bottleneck of the knowledge base retrieval module.", true));
    const result = await optimizePromptWithEdge(LONG_INPUT, client);
    expect(result.changed).toBe(false);
    expect(result.text).toBe(LONG_INPUT);
  });

  test("忠实度判别返回垃圾时按不忠实处理（安全方向回退）", async () => {
    const { client } = fakeClient((prompt: string) => {
      if (prompt.includes("判断改写是否忠实")) return { content: "我无法判断" };
      return { content: GOOD_REWRITE };
    });
    const result = await optimizePromptWithEdge(LONG_INPUT, client);
    expect(result.changed).toBe(false);
    expect(result.text).toBe(LONG_INPUT);
  });

  test("模型调用失败时回退原文", async () => {
    const { client } = fakeClient(() => {
      throw new Error("connection refused");
    });
    const result = await optimizePromptWithEdge(LONG_INPUT, client);
    expect(result.changed).toBe(false);
    expect(result.text).toBe(LONG_INPUT);
  });

  test("模型返回空内容时回退原文", async () => {
    const { client } = fakeClient(handlerReturning("  ", true));
    const result = await optimizePromptWithEdge(LONG_INPUT, client);
    expect(result.changed).toBe(false);
    expect(result.text).toBe(LONG_INPUT);
  });

  test("模型输出异常膨胀时回退原文", async () => {
    const { client } = fakeClient(handlerReturning("扩".repeat(LONG_INPUT.length * 10), true));
    const result = await optimizePromptWithEdge(LONG_INPUT, client);
    expect(result.changed).toBe(false);
    expect(result.text).toBe(LONG_INPUT);
  });

  test("跳过的输入不调用模型", async () => {
    const { client, getCalls } = fakeClient(handlerReturning("改写结果", true));
    const result = await optimizePromptWithEdge("你好", client);
    expect(getCalls()).toBe(0);
    expect(result.changed).toBe(false);
    expect(result.text).toBe("你好");
  });

  test("EDGE_PROMPT_REWRITE=0 时不调用模型", async () => {
    process.env.EDGE_PROMPT_REWRITE = "0";
    try {
      const { client, getCalls } = fakeClient(handlerReturning("改写结果", true));
      const result = await optimizePromptWithEdge(LONG_INPUT, client);
      expect(getCalls()).toBe(0);
      expect(result.changed).toBe(false);
      expect(result.text).toBe(LONG_INPUT);
    } finally {
      delete process.env.EDGE_PROMPT_REWRITE;
    }
  });
});
