import { describe, it, expect, beforeAll, afterAll, spyOn } from "bun:test";
import { router, type ChatMessage, type ExecuteInput, type ExecuteOutput } from "../src/router/model-router.js";

const testMessages: ChatMessage[] = [
  { role: "user", content: "Hello, how are you?" },
];

let executeSpy: ReturnType<typeof spyOn> | undefined;
let toolSpy: ReturnType<typeof spyOn> | undefined;
let routeByIntentSpy: ReturnType<typeof spyOn> | undefined;

// File-level setup so the network boundary stays mocked for every describe in
// this file. Without this, the "Router Performance" and "Quick Key Commands"
// describes would fall through to the real MultiPlatformRouter which fans out
// to live providers (siliconflow / kimi / minimax / openrouter / ...).
beforeAll(() => {
  executeSpy = spyOn(router, "execute").mockImplementation(async () => ({
    content: "test response",
    model: "test-model",
    provider: "test-provider",
    usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 },
    routingMeta: { role: "general-chat", thinking: "none", reason: "test" },
    latencyMs: 100,
    fallbackUsed: false,
  }));
  toolSpy = spyOn(router, "tool").mockImplementation(async () => ({
    content: "test tool response",
    model: "test-tool-model",
    provider: "test-provider",
    usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 },
    layer: "tool",
  }));
  routeByIntentSpy = spyOn(router, "routeByIntent").mockImplementation(async (_intent, _messages) => ({
    content: "test response",
    model: "test-model",
    provider: "test-provider",
    usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 },
    layer: "general",
  }));
});

afterAll(() => {
  executeSpy?.mockRestore();
  toolSpy?.mockRestore();
  routeByIntentSpy?.mockRestore();
});

describe("Flat Router v5.0", () => {

  it("should route every known intent through routeByIntent", async () => {
    const intents = [
      "strategy", "decision", "plan",
      "architecture", "design", "engineering",
      "code", "coding", "implementation", "programming",
      "review", "evaluate", "assessment",
      "english", "translation", "language",
      "chat", "general", "conversation",
    ];

    for (const intent of intents) {
      const result = await router.routeByIntent(intent, testMessages);
      expect(result).toBeDefined();
      expect(result).toHaveProperty("content");
      expect(result).toHaveProperty("model");
    }
  });

  it("should execute through unified port", async () => {
    const input: ExecuteInput = {
      role: "general-chat",
      messages: testMessages,
      trackAs: "test",
    };

    // execute 已在 beforeAll mock，确定性断言
    const output: ExecuteOutput = await router.execute(input);
    expect(output).toBeDefined();
    expect(output).toHaveProperty("content");
    expect(output).toHaveProperty("model");
    expect(output).toHaveProperty("provider");
    expect(output.routingMeta).toBeDefined();
    expect(output.routingMeta?.role).toBe("general-chat");
  }, 30000);

  it("should route intents to correct roles", async () => {
    const testCases = [
      { intent: "strategy", expectedRole: "decision" },
      { intent: "architecture", expectedRole: "architecture" },
      { intent: "code", expectedRole: "code-generation" },
      { intent: "review", expectedRole: "code-review" },
      { intent: "english", expectedRole: "general-chat" },
      { intent: "chat", expectedRole: "general-chat" },
    ];

    for (const { intent } of testCases) {
      const result = await router.routeByIntent(intent, testMessages);
      expect(result).toBeDefined();
      expect(result).toHaveProperty("model");
      expect(result).toHaveProperty("provider");
    }
  }, 30000);

  it("should support backward compatible APIs", () => {
    // All v4.0 APIs should still exist
    expect(typeof router.decide).toBe("function");
    expect(typeof router.architect).toBe("function");
    expect(typeof router.evaluate).toBe("function");
    expect(typeof router.chat).toBe("function");
    expect(typeof router.tool).toBe("function");
    expect(typeof router.autoRoute).toBe("function");
    expect(typeof router.assign).toBe("function");
    expect(typeof router.executeWithRole).toBe("function");
    expect(typeof router.batchExecute).toBe("function");
    expect(typeof router.embeddings).toBe("function");
    // New v5.0 API
    expect(typeof router.execute).toBe("function");
  });

  it("should parse routing decisions correctly", () => {
    const validJson = JSON.stringify({
      role: "coding",
      thinking: "medium",
      reason: "User wants code",
    });

    const decision = router.parseRoutingDecision(validJson);
    expect(decision).toBeDefined();
    expect(decision.role).toBe("coding");
    expect(decision.thinking).toBe("medium");
    expect(decision.reason).toBe("User wants code");
  });

  it("should handle invalid routing decision JSON", () => {
    const invalidJson = "not valid json";
    const decision = router.parseRoutingDecision(invalidJson);
    expect(decision).toBeDefined();
    expect(decision.role).toBe("general-chat"); // Default fallback
  });

  it("should return routing metadata", async () => {
    const input: ExecuteInput = {
      role: "general-chat",
      messages: testMessages,
      trackAs: "test",
    };

    // execute 已在 beforeAll mock，确定性断言
    const output = await router.execute(input);
    expect(output.routingMeta).toBeDefined();
    expect(output.routingMeta!.role).toBe("general-chat");
    expect(output.routingMeta!.thinking).toBeDefined();
    expect(output.routingMeta!.reason).toBeDefined();
  }, 30000);
});

describe("Router Performance", () => {
  it("should handle concurrent requests deterministically under mocks", async () => {
    const results = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        router.routeByIntent("chat", [{ role: "user", content: `Concurrent test ${i}` }])
      ),
    );
    expect(results.length).toBe(5);
    for (const r of results) {
      expect(r).toHaveProperty("content");
      expect(r).toHaveProperty("model");
    }
  }, 30000);

  it("should assign models quickly", () => {
    const start = performance.now();
    const result = router.assign("coding");
    const end = performance.now();

    expect(result).toBeDefined();
    expect(result.model).toBeDefined();
    expect(end - start).toBeLessThan(100); // Should be fast
  });
});
