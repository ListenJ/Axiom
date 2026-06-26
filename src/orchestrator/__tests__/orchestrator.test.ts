/**
 * Orchestrator integration tests — verifies IntelligentRouter wiring.
 * Run: bun test src/orchestrator/__tests__/orchestrator.test.ts
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { SystemOrchestrator, type OrchestratorConfig } from "../../orchestrator.js";
import { MultiPlatformRouter, type ChatMessage, type ChatResponse } from "../../router/model-router.js";

type MockRouter = Pick<MultiPlatformRouter, "chat"> & Partial<MultiPlatformRouter>;

function createMockRouter(roleMap?: Map<string, string>): MockRouter {
  return {
    chat: async (role: string, messages: ChatMessage[]): Promise<ChatResponse> => {
      return {
        content: `mocked:${role}:${messages[messages.length - 1]?.content ?? ""}`,
        model: "mock-model",
        provider: "mock-provider",
        usage: { total_tokens: 10 },
      };
    },
    ...roleMap,
  } as unknown as MockRouter;
}

function buildConfig(overrides: Partial<OrchestratorConfig> = {}): Partial<OrchestratorConfig> {
  // Disable heavy subsystems so the test exercises only routing + router.chat()
  return {
    enableCodeRetrieval: false,
    enableContextManagement: false,
    enableGracefulDegradation: false,
    enableEnhancedWatcher: false,
    enablePiAgent: false,
    ...overrides,
  };
}

describe("SystemOrchestrator Intelligent Routing", () => {
  beforeEach(() => {
    // Tests are isolated; no shared mutable state in orchestrator itself.
  });

  it("should route code queries to coding role when intelligent routing is enabled", async () => {
    const mockRouter = createMockRouter();
    const orchestrator = new SystemOrchestrator(mockRouter as MultiPlatformRouter, buildConfig());
    const response = await orchestrator.processRequest(
      [{ role: "user", content: "写一个 TypeScript 函数来计算斐波那契数列" }],
      "req-1"
    );

    expect(response.content).toContain("mocked:coding");
    const status = orchestrator.getStatus();
    expect(status.components.intelligentRouting).toBe(true);
    expect(status.lastDecision?.role).toBe("coding");
    expect(status.lastDecision?.intent).toBe("code");
  });

  it("should route research queries to research role", async () => {
    const mockRouter = createMockRouter();
    const orchestrator = new SystemOrchestrator(mockRouter as MultiPlatformRouter, buildConfig());
    const response = await orchestrator.processRequest(
      [{ role: "user", content: "调研一下 reinforcement learning 的最新进展" }],
      "req-2"
    );

    expect(response.content).toContain("mocked:research");
    expect(orchestrator.getStatus().lastDecision?.role).toBe("research");
  });

  it("should route simple queries to general-chat", async () => {
    const mockRouter = createMockRouter();
    const orchestrator = new SystemOrchestrator(mockRouter as MultiPlatformRouter, buildConfig());
    const response = await orchestrator.processRequest(
      [{ role: "user", content: "什么是 TypeScript?" }],
      "req-3"
    );

    expect(response.content).toContain("mocked:general-chat");
  });

  it("should fall back to code-generation when intelligent routing is disabled", async () => {
    const mockRouter = createMockRouter();
    const orchestrator = new SystemOrchestrator(mockRouter as MultiPlatformRouter, buildConfig({
      enableIntelligentRouting: false,
    }));
    const response = await orchestrator.processRequest(
      [{ role: "user", content: "写一个 TypeScript 函数来计算斐波那契数列" }],
      "req-4"
    );

    expect(response.content).toContain("mocked:code-generation");
    expect(orchestrator.getStatus().lastDecision).toBeUndefined();
  });

  it("should expose config and component status", () => {
    const mockRouter = createMockRouter();
    const orchestrator = new SystemOrchestrator(mockRouter as MultiPlatformRouter, buildConfig({
      enableIntelligentRouting: true,
    }));
    const status = orchestrator.getStatus();

    expect(status.config.enableIntelligentRouting).toBe(true);
    expect(status.components.intelligentRouting).toBe(true);
    expect(status.components.codeRetrieval).toBe(false);
    expect(status.components.contextManager).toBe(false);
  });

  it("should preserve latency_ms in the response", async () => {
    const mockRouter = createMockRouter();
    const orchestrator = new SystemOrchestrator(mockRouter as MultiPlatformRouter, buildConfig());
    const start = Date.now();
    const response = await orchestrator.processRequest(
      [{ role: "user", content: "hello" }],
      "req-5"
    );
    const end = Date.now();

    expect(response.latency_ms).toBeGreaterThanOrEqual(0);
    expect(response.latency_ms).toBeLessThanOrEqual(end - start + 50);
  });
});
