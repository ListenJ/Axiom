import { describe, it, expect, beforeAll, afterAll, spyOn } from "bun:test";
import { CodeRetrievalRouter, type QueryAnalysis, type RetrievalStrategy } from "../src/router/code-retrieval-router.js";
import { ContextManager, type ContextStats, type SplitOptions } from "../src/context/context-manager.js";
import { router } from "../src/router/model-router.js";

let executeWithRoleSpy: ReturnType<typeof spyOn> | undefined;
let embeddingsSpy: ReturnType<typeof spyOn> | undefined;

beforeAll(() => {
  executeWithRoleSpy = spyOn(router, "executeWithRole").mockImplementation(async () => ({
    content: "test summary",
    role: "decision",
    model: "test-model",
    provider: "test-provider",
    endpoint: "https://test.example.com",
    usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 },
    latency_ms: 100,
    fallback_used: false,
  }));
  embeddingsSpy = spyOn(router, "embeddings").mockImplementation(async (texts) =>
    (Array.isArray(texts) ? texts : [texts]).map(() => new Array(128).fill(0).map((_, i) => i / 128))
  );
});

afterAll(() => {
  executeWithRoleSpy?.mockRestore();
  embeddingsSpy?.mockRestore();
});

describe("CodeRetrievalRouter", () => {
  it("should initialize with default config", () => {
    const router = new CodeRetrievalRouter();
    expect(router).toBeDefined();
  });

  it("should analyze query with heuristic", async () => {
    const router = new CodeRetrievalRouter();
    const analysis = await router.analyzeQuery("How does the auth function work?");
    expect(analysis).toBeDefined();
    expect(analysis.intent).toBeDefined();
    expect(analysis.complexity).toBeOneOf(["low", "medium", "high"]);
    expect(analysis.confidence).toBeGreaterThan(0);
  });

  it("should select strategy based on analysis", async () => {
    const router = new CodeRetrievalRouter();
    const analysis: QueryAnalysis = {
      intent: "find_definition",
      keywords: ["auth", "function"],
      symbols: ["auth"],
      fileHints: [],
      complexity: "low",
      suggestedStrategy: "symbol",
      confidence: 0.9,
    };

    const strategy = await router.selectStrategy(analysis);
    expect(strategy).toBeDefined();
    expect(strategy).toBeOneOf(["symbol", "dependency", "impact", "fulltext", "hybrid"]);
  });

  it("should build context in markdown format", async () => {
    const router = new CodeRetrievalRouter();
    const result = {
      strategy: "symbol" as RetrievalStrategy,
      symbols: [],
      callers: [],
      callees: [],
      impact: "",
      context: "Test context",
      metadata: {
        totalNodes: 1,
        totalRelationships: 0,
        executionTimeMs: 100,
      },
    };

    const context = await router.buildContext(result, { format: "markdown" });
    expect(context).toBeDefined();
    expect(typeof context).toBe("string");
    expect(context).toContain("Code Retrieval Result");
  });

  it("should build context in json format", async () => {
    const router = new CodeRetrievalRouter();
    const result = {
      strategy: "symbol" as RetrievalStrategy,
      symbols: [],
      callers: [],
      callees: [],
      impact: "",
      context: "Test context",
      metadata: {
        totalNodes: 1,
        totalRelationships: 0,
        executionTimeMs: 100,
      },
    };

    const context = await router.buildContext(result, { format: "json" });
    expect(context).toBeDefined();
    expect(typeof context).toBe("string");
    // Should be valid JSON
    const parsed = JSON.parse(context);
    expect(parsed.strategy).toBe("symbol");
  });
});

describe("ContextManager", () => {
  it("should initialize with default config", () => {
    const manager = new ContextManager();
    expect(manager).toBeDefined();
  });

  it("should initialize with custom maxContextWindow", () => {
    const manager = new ContextManager({ maxContextWindow: 64000 });
    expect(manager).toBeDefined();
  });

  it("should get stats with empty context", () => {
    const manager = new ContextManager();
    const stats = manager.getStats();
    expect(stats).toBeDefined();
    expect(stats.totalTokens).toBe(0);
    expect(stats.usagePercent).toBe(0);
    expect(stats.chunkCount).toBe(0);
    expect(stats.memoryEntries).toBe(0);
  });

  it("should check usage below threshold", async () => {
    const manager = new ContextManager({ maxContextWindow: 100000 });
    const messages = [
      { role: "user" as const, content: "Hello" },
    ];

    const result = await manager.checkUsage(messages);
    expect(result.action).toBe("none");
    expect(result.messages).toBeDefined();
  });

  it("should split context when usage exceeds threshold", async () => {
    const manager = new ContextManager({ maxContextWindow: 1000 });
    // Create messages that exceed 60% of 1000 tokens
    const messages = Array.from({ length: 20 }, (_, i) => ({
      role: "user" as const,
      content: `This is a test message number ${i} with enough content to consume tokens. `.repeat(5),
    }));

    const result = await manager.checkUsage(messages, { thresholdPercent: 0.6 });
    expect(result.action).toBeOneOf(["split", "compress"]);
  });

  it("should compress context when usage is very high", async () => {
    const manager = new ContextManager({ maxContextWindow: 1000 });
    const messages = Array.from({ length: 30 }, (_, i) => ({
      role: "user" as const,
      content: `This is a test message number ${i} with enough content to consume many tokens. `.repeat(10),
    }));

    const result = await manager.checkUsage(messages, { thresholdPercent: 0.6 });
    expect(result.action).toBe("compress");
    expect(result.messages.length).toBeLessThanOrEqual(messages.length + 1); // +1 for system summary
  });

  it("should retrieve from empty memory", async () => {
    const manager = new ContextManager();
    const results = await manager.retrieveFromMemory("test query");
    expect(results).toBeDefined();
    expect(Array.isArray(results)).toBe(true);
    expect(results.length).toBe(0);
  });

  it("should get effective context without query", async () => {
    const manager = new ContextManager();
    const messages = [
      { role: "user" as const, content: "Hello" },
    ];

    const result = await manager.getEffectiveContext(messages);
    expect(result).toBeDefined();
    expect(Array.isArray(result)).toBe(true);
  });

  it("should set max context window", () => {
    const manager = new ContextManager();
    manager.setMaxContextWindow(64000);
    const stats = manager.getStats();
    expect(stats.maxTokens).toBe(64000);
  });

  it("should clear memory", () => {
    const manager = new ContextManager();
    manager.clearMemory();
    const stats = manager.getStats();
    expect(stats.memoryEntries).toBe(0);
    expect(stats.chunkCount).toBe(0);
  });

  it("should get memory stats", () => {
    const manager = new ContextManager();
    const stats = manager.getMemoryStats();
    expect(stats).toBeDefined();
    expect(typeof stats.entries).toBe("number");
    expect(typeof stats.totalTokens).toBe("number");
  });
});

describe("Integration: Context Takeover", () => {
  it("should handle context manager initialization", () => {
    const manager = new ContextManager({ maxContextWindow: 128000 });
    expect(manager).toBeDefined();
    const stats = manager.getStats();
    expect(stats.maxTokens).toBe(128000);
  });
});