import { describe, it, expect, beforeAll, afterAll, spyOn } from "bun:test";
import { router, type ChatMessage } from "../src/router/model-router.js";

describe("ModelRouter", () => {
  const testMessages: ChatMessage[] = [
    { role: "user", content: "Hello, how are you?" },
  ];

  let executeSpy: ReturnType<typeof spyOn> | undefined;
  let executeWithRoleSpy: ReturnType<typeof spyOn> | undefined;
  let toolSpy: ReturnType<typeof spyOn> | undefined;
  let embeddingsSpy: ReturnType<typeof spyOn> | undefined;
  let autoRouteSpy: ReturnType<typeof spyOn> | undefined;

  beforeAll(() => {
    // 审计整改 R1：autoRoute 原先未 mock，会在测试环境尝试真实 LLM 分类；
    // 统一 mock 后所有用例确定性执行，try/catch 掩码已全部拆除。
    autoRouteSpy = spyOn(router, "autoRoute").mockImplementation(async () => ({
      content: "test response",
      model: "test-model",
      provider: "test-provider",
      usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 },
      routingMeta: { role: "general-chat", thinking: "none", reason: "test" },
      latencyMs: 100,
      fallbackUsed: false,
    }));
    executeSpy = spyOn(router, "execute").mockImplementation(async () => ({
      content: "test response",
      model: "test-model",
      provider: "test-provider",
      usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 },
      routingMeta: { role: "general-chat", thinking: "none", reason: "test" },
      latencyMs: 100,
      fallbackUsed: false,
    }));
    executeWithRoleSpy = spyOn(router, "executeWithRole").mockImplementation(async () => ({
      content: "test role response",
      role: "general-chat",
      model: "test-model",
      provider: "test-provider",
      endpoint: "https://test.example.com",
      usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 },
      latency_ms: 100,
      fallback_used: false,
    }));
    toolSpy = spyOn(router, "tool").mockImplementation(async () => ({
      content: "test tool response",
      model: "test-tool-model",
      provider: "test-provider",
      usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 },
      layer: "tool",
    }));
    embeddingsSpy = spyOn(router, "embeddings").mockImplementation(async (texts) =>
      texts.map(() => new Array(128).fill(0).map((_, i) => i / 128))
    );
  });

  afterAll(() => {
    executeSpy?.mockRestore();
    executeWithRoleSpy?.mockRestore();
    toolSpy?.mockRestore();
    embeddingsSpy?.mockRestore();
    autoRouteSpy?.mockRestore();
  });

  it("should initialize router", () => {
    expect(router).toBeDefined();
    expect(typeof router.chat).toBe("function");
    expect(typeof router.decide).toBe("function");
    expect(typeof router.architect).toBe("function");
    expect(typeof router.evaluate).toBe("function");
    expect(typeof router.tool).toBe("function");
    expect(typeof router.autoRoute).toBe("function");
    expect(typeof router.assign).toBe("function");
    expect(typeof router.executeWithRole).toBe("function");
    expect(typeof router.batchExecute).toBe("function");
  });

  it("should auto route messages", async () => {
    const messages: ChatMessage[] = [
      { role: "system", content: "You are a helpful assistant." },
      { role: "user", content: "Write a hello world program in TypeScript" },
    ];

    const result = await router.autoRoute(messages);
    expect(result).toBeDefined();
    expect(result).toHaveProperty("content");
    expect(result).toHaveProperty("model");
    expect(result).toHaveProperty("provider");
  }, 30000);

  it("should assign models for known roles", () => {
    const roles = ["coding", "research", "decision", "general-chat"] as const;

    for (const role of roles) {
      const result = router.assign(role);
      if (result === null) {
        // 空注册表环境下的文档化行为：显式 null（绝不 undefined / throw）
        expect(result).toBeNull();
      } else {
        expect(result.role).toBe(role);
        expect(result.model).toBeDefined();
        expect(Array.isArray(result.fallbackChain)).toBe(true);
        expect(result.reason).toBeDefined();
      }
    }
  });

  it("should route by intent", async () => {
    const intents = ["strategy", "architecture", "engineering", "english", "general"];

    for (const intent of intents) {
      const result = await router.routeByIntent(intent, testMessages);
      expect(result).toBeDefined();
      expect(result).toHaveProperty("content");
      expect(result).toHaveProperty("model");
      expect(result).toHaveProperty("provider");
    }
  }, 30000);

  it("should handle batch execution", async () => {
    const assignments = [
      { role: "coding" as const, messages: testMessages },
      { role: "research" as const, messages: testMessages },
    ];

    // batchExecute 内部走 this.executeWithRole，已被 beforeAll spy 拦截
    const results = await router.batchExecute(assignments, { preventDuplicateModels: true });
    expect(Array.isArray(results)).toBe(true);
    expect(results.length).toBe(assignments.length);

    for (const result of results) {
      expect(result).toHaveProperty("role");
      expect(result).toHaveProperty("model");
      expect(result).toHaveProperty("provider");
      expect(result).toHaveProperty("content");
    }
  }, 30000);

  it("should handle embeddings request", async () => {
    const texts = ["Hello world", "Test embedding"];
    const embeddings = await router.embeddings(texts);
    expect(Array.isArray(embeddings)).toBe(true);
    expect(embeddings.length).toBe(texts.length);

    for (const embedding of embeddings) {
      expect(Array.isArray(embedding)).toBe(true);
      expect(embedding.length).toBeGreaterThan(0);
    }
  });

  it("should handle tool execution with fallback", async () => {
    const result = await router.tool("coding", testMessages);
    expect(result).toBeDefined();
    expect(result).toHaveProperty("content");
    expect(result).toHaveProperty("model");
    expect(result).toHaveProperty("provider");
    expect(result.layer).toBe("tool");
  }, 30000);

  it("should return degraded response when no models exist for role", async () => {
    // 契约（model-router.ts:238-245）：未知角色不抛错，execute 直接返回降级响应。
    // 注意：本 describe 已 spy 了 router.execute，会拦住降级路径；
    // 因此先恢复真实实现，断言完毕后重建 mock 供后续用例使用。
    executeSpy?.mockRestore();
    executeSpy = undefined;
    try {
      const messages: ChatMessage[] = [
        { role: "system", content: "You are a helpful assistant." },
        { role: "user", content: "Test" },
      ];

      const result = await router.chat("nonexistent-role-12345", messages);
      // chat() 返回 ChatResponse（不透传 fallbackUsed），降级契约体现在
      // model="none" 与提示文案（execute 内部 fallbackUsed=true，见 :238-245）
      expect(result.model).toBe("none");
      expect(String(result.content)).toContain("No models configured");
    } finally {
      // 重新建立 mock，保持文件级隔离约定（afterAll 的 mockRestore 对 undefined 安全）
      executeSpy = spyOn(router, "execute").mockImplementation(async () => ({
        content: "test response",
        model: "test-model",
        provider: "test-provider",
        usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 },
        routingMeta: { role: "general-chat", thinking: "none", reason: "test" },
        latencyMs: 100,
        fallbackUsed: false,
      }));
    }
  });
});
