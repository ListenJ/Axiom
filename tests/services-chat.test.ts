/**
 * Chat service tests — using absolute path mocks for reliable interception
 */
import { describe, it, expect, mock } from "bun:test";
import path from "path";

const ROOT = path.resolve(import.meta.dir, "..");

// Mock using absolute paths
const mockRouterMod = path.join(ROOT, "src", "router", "model-router.js");
mock.module(mockRouterMod, () => ({
  router: {
    routeByIntent: () => ({ content: "routed by intent", model: "m1", provider: "p1", layer: "code" }),
    chat: () => ({ content: "general chat", model: "m2", provider: "p2", layer: "general" }),
  },
}));

const mockCodegraph = path.join(ROOT, "src", "memory", "codegraph-index.js");
mock.module(mockCodegraph, () => ({
  retrieveCodeMemory: async () => ({ source: "codegraph", results: "code context" }),
  // code-indexer.ts 也从此模块导入该符号，mock 缺失会导致 SyntaxError
  getFileSymbolsFromCodeGraph: async () => null,
}));

const mockIntentEnhancer = path.join(ROOT, "src", "agents", "intent-enhancer.js");
mock.module(mockIntentEnhancer, () => ({
  shouldEnhanceIntent: () => false,
  enhanceIntentWithLLM: async (_input: string, intent: { intent: string }) => intent,
  buildEnhancedSystemPrompt: (intent: string) => `Enhanced ${intent}`,
}));

const mockPromptOptimizer = path.join(ROOT, "src", "agents", "prompt-optimizer.js");
mock.module(mockPromptOptimizer, () => ({
  optimizePrompt: async (text: string) => ({ changed: false, text }),
}));
const mockQueryDecomp = path.join(ROOT, "src", "agents", "query-decomposer.js");
mock.module(mockQueryDecomp, () => ({
  decomposeQuery: () => ({ subQueries: ["q1"] }),
  searchKnowledgeBase: async () => [{ content: "knowledge" }],
  synthesizeResults: () => "synth",
  buildKnowledgePrompt: () => "prompt",
}));

describe("ChatService", () => {
  it("prepareChatContext basic intent routing", async () => {
    const { prepareChatContext } = await import("../src/services/chat.js");
    const result = await prepareChatContext([{ role: "user", content: "sort this code" }], true, null);
    expect(result.intentInfo).toBeDefined();
    expect(result.chatMessages.length).toBeGreaterThan(0);
  });

  it("prepareChatContext disable intent", async () => {
    const { prepareChatContext } = await import("../src/services/chat.js");
    const result = await prepareChatContext([{ role: "user", content: "hi" }], false, null);
    expect(result.intentInfo).toBeNull();
  });

  it("executeChat uses intent routing", async () => {
    const { executeChat } = await import("../src/services/chat.js");
    const result = await executeChat(
      [{ role: "user", content: "test" }],
      { intent: "code", agentName: "a", confidence: 0.9 },
      undefined,
    );
    expect(result.content).toBe("routed by intent");
  });

  it("executeChat falls back to taskType", async () => {
    const { executeChat } = await import("../src/services/chat.js");
    const result = await executeChat(
      [{ role: "user", content: "test" }], null, "general-chat",
    );
    expect(result.content).toBe("general chat");
  });

  it("prepareChatContext applies token budget", async () => {
    const { prepareChatContext } = await import("../src/services/chat.js");
    const result = await prepareChatContext(
      [{ role: "user", content: "x".repeat(500) }],
      false,
      null,
      { budget: 64 },
    );
    expect(result.tokenBudgetReport).toBeDefined();
    expect(result.chatMessages.length).toBeGreaterThan(0);
  });
});
