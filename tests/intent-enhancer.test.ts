/**
 * 意图增强器测试 —— 验证 src/agents/intent-enhancer.ts
 *
 * 测试范围：
 *   - shouldEnhanceIntent 阈值判断
 *   - buildEnhancedSystemPrompt 6 种意图的思考框架注入
 *   - extractInputHint 信号提取（代码块/错误日志/命令行/中文）
 *   - parseClassifierResponse 容错解析（纯 JSON / markdown fence / 嵌入文本）
 *   - enhanceIntentWithLLM 失败回退（mock callProvider）
 *
 * 不调用真实 LLM API；通过 bun:test 的 mock 模块替换 callProvider。
 *
 * Mock 关键设计：
 *   - bun:test 的 mock.module 必须在目标模块首次 import 之前注册才能生效
 *   - 因此本文件不在顶部静态 import intent-enhancer，而是先注册 mock 再动态 import
 *   - 使用共享的 mock() 实例，每个测试用 mockImplementation 切换行为
 */

import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test";
import type { IntentResult } from "../src/agents/intent-router.js";

// ─────────────────────────────────────────────────────────
// Mock 注册：必须在 import intent-enhancer 之前
// ─────────────────────────────────────────────────────────

/** 共享的 callProvider mock 实例；测试中用 mockImplementation 切换行为 */
// 使用宽松返回类型避免 mockImplementation 切换不同返回结构时类型不兼容
const mockCallProvider = mock(
  (_provider?: string, _model?: string, _messages?: unknown, _timeout?: number, _temp?: number): Promise<unknown> =>
    Promise.reject(new Error("mock not configured for this test")),
);

// 注册 mock 模块（factory 返回的对象会替代真实 provider-caller.js 的导出）
// 注意：mock.module 路径相对于测试文件解析，需用 ../src/router/ 而非 ../router/
mock.module("../src/router/provider-caller.js", () => ({
  callProvider: mockCallProvider,
  callProviderNativeStream: mock(() => Promise.resolve({ content: "" })),
}));

// 注意：边缘客户端不做全局模块 mock（bun 同进程 mock 会泄漏污染其他测试文件）。
// 改为：1) 默认在本文件内 EDGE_PROMPT_OPTIMIZER=0 关闭边缘路径（zhipu 路径用例）
//      2) 边缘用例通过 enhanceIntentWithLLM 第三参数注入 fake client

/** 构造 fake 边缘客户端 */
function fakeEdgeClient(impl: () => { content: string }) {
  let calls = 0;
  return {
    client: {
      generate: async () => {
        calls++;
        const r = impl();
        return { content: r.content, model: "mock", usage: { promptTokens: 0, completionTokens: 0 }, finishReason: "stop" };
      },
    },
    getCalls: () => calls,
  };
}

// 现在 import intent-enhancer —— 它会绑定到上面的 mock callProvider
const { shouldEnhanceIntent, buildEnhancedSystemPrompt, enhanceIntentWithLLM } =
  await import("../src/agents/intent-enhancer.js");

// ─────────────────────────────────────────────────────────
// 工具函数：构造测试用 IntentResult
// ─────────────────────────────────────────────────────────

function makeIntent(overrides: Partial<IntentResult> = {}): IntentResult {
  return {
    intent: "chat",
    agentName: "General Assistant",
    confidence: 0.3,
    matchedKeywords: [],
    recommendedRole: "coding",
    ...overrides,
  };
}

/** 每个测试前重置 mock 调用记录与默认实现；默认关闭边缘路径（走 zhipu） */
beforeEach(() => {
  mockCallProvider.mockReset();
  mockCallProvider.mockImplementation(() =>
    Promise.reject(new Error("mock not configured for this test")),
  );
  process.env.EDGE_PROMPT_OPTIMIZER = "0";
});

afterEach(() => {
  mockCallProvider.mockReset();
  delete process.env.EDGE_PROMPT_OPTIMIZER;
});

// ─────────────────────────────────────────────────────────
// shouldEnhanceIntent
// ─────────────────────────────────────────────────────────

describe("intent-enhancer — shouldEnhanceIntent", () => {
  test("confidence < 0.5 时返回 true（需要 LLM 增强）", () => {
    expect(shouldEnhanceIntent(makeIntent({ confidence: 0 }))).toBe(true);
    expect(shouldEnhanceIntent(makeIntent({ confidence: 0.3 }))).toBe(true);
    expect(shouldEnhanceIntent(makeIntent({ confidence: 0.49 }))).toBe(true);
  });

  test("confidence >= 0.5 时返回 false（关键词匹配已足够）", () => {
    expect(shouldEnhanceIntent(makeIntent({ confidence: 0.5 }))).toBe(false);
    expect(shouldEnhanceIntent(makeIntent({ confidence: 0.7 }))).toBe(false);
    expect(shouldEnhanceIntent(makeIntent({ confidence: 1.0 }))).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────
// buildEnhancedSystemPrompt
// ─────────────────────────────────────────────────────────

describe("intent-enhancer — buildEnhancedSystemPrompt", () => {
  test("code 意图包含思考框架与身份声明", () => {
    const prompt = buildEnhancedSystemPrompt("code", "写一个 Python 函数");
    expect(prompt).toContain("You are Axiom");
    expect(prompt).toContain("software engineering assistant");
    expect(prompt).toContain("Thinking framework");
    expect(prompt).toContain("Restate the problem");
  });

  test("research 意图强调证据评估", () => {
    const prompt = buildEnhancedSystemPrompt("research", "分析竞品");
    expect(prompt).toContain("research analyst");
    expect(prompt).toContain("Never fabricate sources");
  });

  test("knowledge 意图限制在 context 内", () => {
    const prompt = buildEnhancedSystemPrompt("knowledge", "查历史记录");
    expect(prompt).toContain("knowledge navigator");
    expect(prompt).toContain("Do not speculate beyond the provided context");
  });

  test("write 意图包含结构化写作框架", () => {
    const prompt = buildEnhancedSystemPrompt("write", "写文档");
    expect(prompt).toContain("technical writer");
    expect(prompt).toContain("Outline the structure");
  });

  test("plan 意图包含任务分解与风险预案", () => {
    const prompt = buildEnhancedSystemPrompt("plan", "排期");
    expect(prompt).toContain("project planner");
    expect(prompt).toContain("Decompose into ordered work packages");
    expect(prompt).toContain("risks");
  });

  test("chat 意图保留中性回答基调", () => {
    const prompt = buildEnhancedSystemPrompt("chat", "你好");
    expect(prompt).toContain("Answer accurately and concisely");
  });

  test("未知意图降级到 chat 框架", () => {
    const prompt = buildEnhancedSystemPrompt("unknown-intent", "test");
    expect(prompt).toContain("Answer accurately and concisely");
  });

  test("所有意图都包含中性、严肃、无情感基调", () => {
    for (const intent of ["code", "research", "knowledge", "write", "plan", "chat"]) {
      const prompt = buildEnhancedSystemPrompt(intent, "test");
      expect(prompt).toContain("neutral, serious tone");
      expect(prompt).toContain("Do not express emotion");
    }
  });
});

// ─────────────────────────────────────────────────────────
// buildEnhancedSystemPrompt — inputHint 信号提取
// ─────────────────────────────────────────────────────────

describe("intent-enhancer — inputHint 信号提取", () => {
  test("包含代码块时注入 'user provided code' 提示", () => {
    const prompt = buildEnhancedSystemPrompt("code", "```python\nprint('hi')\n```");
    expect(prompt).toContain("user provided code");
  });

  test("包含 error 关键字时注入错误诊断提示", () => {
    const prompt = buildEnhancedSystemPrompt("code", "出现 error: undefined variable");
    expect(prompt).toContain("user shared an error");
    expect(prompt).toContain("diagnose root cause");
  });

  test("包含命令行（$ 提示符）时注入命令行上下文提示", () => {
    const prompt = buildEnhancedSystemPrompt("code", "$ npm install\n$ bun run dev");
    expect(prompt).toContain("command-line output");
  });

  test("包含 npm/bun/cargo 等包管理器命令时注入命令行提示", () => {
    const prompt = buildEnhancedSystemPrompt("code", "运行 npm install 失败");
    expect(prompt).toContain("command-line output");
  });

  test("中文输入时注入同语言回复提示", () => {
    const prompt = buildEnhancedSystemPrompt("chat", "你好，今天天气怎么样？");
    expect(prompt).toContain("Respond in the same language");
  });

  test("英文输入不注入同语言回复提示（避免冗余）", () => {
    const prompt = buildEnhancedSystemPrompt("chat", "hello, how are you?");
    expect(prompt).not.toContain("Respond in the same language");
  });

  test("多信号同时存在时全部注入", () => {
    const input = "$ npm install\n```\nError: module not found\n```";
    const prompt = buildEnhancedSystemPrompt("code", input);
    expect(prompt).toContain("command-line output");
    expect(prompt).toContain("user shared an error");
    expect(prompt).toContain("user provided code");
  });

  test("无信号时不注入 Context signals 段", () => {
    const prompt = buildEnhancedSystemPrompt("chat", "hello");
    expect(prompt).not.toContain("Context signals");
  });
});

// ─────────────────────────────────────────────────────────
// enhanceIntentWithLLM — 通过共享 mock callProvider 测试
// ─────────────────────────────────────────────────────────

describe("intent-enhancer — enhanceIntentWithLLM 失败回退", () => {
  test("LLM 返回合法 JSON 时修正意图", async () => {
    mockCallProvider.mockImplementation(() =>
      Promise.resolve({
        content: '{"intent": "code", "confidence": 0.9, "reason": "编程问题"}',
        model: "glm-4.7-flash",
        provider: "zhipu",
        usage: { prompt_tokens: 10, completion_tokens: 20 },
      }),
    );

    const baseIntent = makeIntent({ intent: "chat", confidence: 0.2 });
    const result = await enhanceIntentWithLLM("写一个 Python 函数", baseIntent);

    expect(result.intent).toBe("code");
    expect(result.confidence).toBeGreaterThanOrEqual(0.9);
  });

  test("LLM 返回带 markdown fence 的 JSON 也能解析", async () => {
    mockCallProvider.mockImplementation(() =>
      Promise.resolve({
        content: '```json\n{"intent": "research", "confidence": 0.85}\n```',
        model: "glm-4.7-flash",
        provider: "zhipu",
        usage: {},
      }),
    );

    const baseIntent = makeIntent({ intent: "chat", confidence: 0.1 });
    const result = await enhanceIntentWithLLM("分析市场趋势", baseIntent);

    expect(result.intent).toBe("research");
  });

  test("LLM 返回嵌入文本中的 JSON 也能提取", async () => {
    mockCallProvider.mockImplementation(() =>
      Promise.resolve({
        content: '分类结果：\n{"intent": "write", "confidence": 0.8, "reason": "撰写"}\n以上是分类。',
        model: "glm-4.7-flash",
        provider: "zhipu",
        usage: {},
      }),
    );

    const result = await enhanceIntentWithLLM("写一份报告", makeIntent({ confidence: 0.1 }));

    expect(result.intent).toBe("write");
  });

  test("LLM 返回非法意图时回退到 baseIntent", async () => {
    mockCallProvider.mockImplementation(() =>
      Promise.resolve({
        content: '{"intent": "invalid-category", "confidence": 0.9}',
        model: "glm-4.7-flash",
        provider: "zhipu",
        usage: {},
      }),
    );

    const baseIntent = makeIntent({ intent: "chat", confidence: 0.2 });
    const result = await enhanceIntentWithLLM("test", baseIntent);

    // 非法意图 → 回退
    expect(result.intent).toBe("chat");
    expect(result.confidence).toBe(0.2);
  });

  test("LLM 返回非 JSON 时回退到 baseIntent", async () => {
    mockCallProvider.mockImplementation(() =>
      Promise.resolve({
        content: "I think this is a coding question.",
        model: "glm-4.7-flash",
        provider: "zhipu",
        usage: {},
      }),
    );

    const baseIntent = makeIntent({ intent: "chat", confidence: 0.1 });
    const result = await enhanceIntentWithLLM("test", baseIntent);

    expect(result).toBe(baseIntent);
  });

  test("callProvider 抛异常时回退到 baseIntent", async () => {
    mockCallProvider.mockImplementation(() => Promise.reject(new Error("Network timeout")));

    const baseIntent = makeIntent({ intent: "chat", confidence: 0.1 });
    const result = await enhanceIntentWithLLM("test", baseIntent);

    expect(result).toBe(baseIntent);
    expect(result.intent).toBe("chat");
  });

  test("超长输入被截断（不传完整内容给 LLM）", async () => {
    let capturedInput = "";
    mockCallProvider.mockImplementation((_provider, _model, messages) => {
      const userMsg = (messages as Array<{ role: string; content: string }>).find(
        (m) => m.role === "user",
      );
      if (userMsg) capturedInput = userMsg.content;
      return Promise.resolve({
        content: '{"intent": "chat", "confidence": 0.9}',
        model: "glm-4.7-flash",
        provider: "zhipu",
        usage: {},
      });
    });

    const longInput = "a".repeat(10000);
    await enhanceIntentWithLLM(longInput, makeIntent({ confidence: 0.1 }));

    // 截断阈值为 4000 字符
    expect(capturedInput.length).toBeLessThanOrEqual(4000);
  });
});

// ─────────────────────────────────────────────────────────
// enhanceIntentWithLLM — 边缘小模型第一层（新增）
// ─────────────────────────────────────────────────────────

describe("intent-enhancer — 边缘小模型优先", () => {
  test("边缘模型返回合法 JSON 时直接使用，不调用 zhipu", async () => {
    process.env.EDGE_PROMPT_OPTIMIZER = "1";
    const { client, getCalls } = fakeEdgeClient(() => ({
      content: '{"intent": "code", "confidence": 0.88}',
    }));
    mockCallProvider.mockImplementation(() =>
      Promise.resolve({
        content: '{"intent": "chat", "confidence": 0.99}',
        model: "glm-4.7-flash",
        provider: "zhipu",
        usage: {},
      }),
    );

    const result = await enhanceIntentWithLLM("写一个排序算法", makeIntent({ confidence: 0.2 }), client);

    expect(result.intent).toBe("code");
    expect(getCalls()).toBe(1);
    expect(mockCallProvider).not.toHaveBeenCalled();
  });

  test("边缘模型返回垃圾时回退 zhipu 第二层", async () => {
    process.env.EDGE_PROMPT_OPTIMIZER = "1";
    const { client } = fakeEdgeClient(() => ({ content: "我无法分类这个输入" }));
    mockCallProvider.mockImplementation(() =>
      Promise.resolve({
        content: '{"intent": "research", "confidence": 0.9}',
        model: "glm-4.7-flash",
        provider: "zhipu",
        usage: {},
      }),
    );

    const result = await enhanceIntentWithLLM("分析行业趋势", makeIntent({ confidence: 0.1 }), client);

    expect(result.intent).toBe("research");
    expect(mockCallProvider).toHaveBeenCalledTimes(1);
  });

  test("边缘模型抛异常时回退 zhipu 第二层", async () => {
    process.env.EDGE_PROMPT_OPTIMIZER = "1";
    const { client } = fakeEdgeClient(() => {
      throw new Error("circuit breaker is OPEN");
    });
    mockCallProvider.mockImplementation(() =>
      Promise.resolve({
        content: '{"intent": "write", "confidence": 0.85}',
        model: "glm-4.7-flash",
        provider: "zhipu",
        usage: {},
      }),
    );

    const result = await enhanceIntentWithLLM("写一份周报", makeIntent({ confidence: 0.1 }), client);

    expect(result.intent).toBe("write");
  });
});

// ─────────────────────────────────────────────────────────
// GLM4.7-flash 模型注册验证
// ─────────────────────────────────────────────────────────

describe("intent-enhancer — GLM4.7-flash 模型注册", () => {
  test("registry 包含 glm-4.7-flash-zhipu 条目", async () => {
    const { UNIFIED_REGISTRY, listAllModels } = await import("../src/router/models/registry.js");
    const allModels = listAllModels();
    const glm = allModels.find((m) => m.id === "glm-4.7-flash-zhipu");

    expect(glm).toBeDefined();
    expect(glm!.provider).toBe("zhipu");
    expect(glm!.model).toBe("glm-4.7-flash");
    expect(glm!.isFree).toBe(true);
    expect(glm!.roles).toContain("intent-classifier");
    expect(glm!.tags).toContain("agent-tool");
    expect(UNIFIED_REGISTRY.length).toBeGreaterThan(0);
  });

  test("TaskRole 类型包含 intent-classifier", async () => {
    const { listAllRoles } = await import("../src/router/models/registry.js");
    const roles = listAllRoles();
    expect(roles).toContain("intent-classifier");
  });
});
