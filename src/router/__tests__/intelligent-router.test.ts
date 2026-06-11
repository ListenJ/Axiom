/**
 * 快速冒烟测试: IntelligentRouter
 * 运行: bun test src/router/__tests__/intelligent-router.test.ts
 */

import { describe, it, expect, beforeAll } from "bun:test";
import { IntelligentRouter, getOptimalRoute, listIntents } from "../intelligent-router.js";

describe("IntelligentRouter", () => {
  let router: IntelligentRouter;

  beforeAll(() => {
    router = new IntelligentRouter();
  });

  it("should list all intents", () => {
    const intents = listIntents();
    expect(intents.length).toBeGreaterThan(20);
    const intentNames = intents.map((i) => i.intent);
    expect(intentNames).toContain("code");
    expect(intentNames).toContain("research");
    expect(intentNames).toContain("architecture");
    expect(intentNames).toContain("math");
  });

  it("should route code-related queries to coding role", () => {
    const decision = router.getOptimalRoute({
      messages: [{ role: "user", content: "写一个 TypeScript 函数来计算斐波那契数列" }],
    });
    expect(decision.role).toBe("coding");
    expect(decision.source).toBe("keyword");
    expect(decision.confidence).toBeGreaterThan(0);
  });

  it("should route architecture queries to architecture role", () => {
    const decision = router.getOptimalRoute({
      messages: [{ role: "user", content: "Design a microservices architecture for a payment system" }],
    });
    expect(decision.role).toBe("architecture");
  });

  it("should route research queries to research role", () => {
    const decision = router.getOptimalRoute({
      messages: [{ role: "user", content: "调研一下 reinforcement learning 的最新进展" }],
    });
    expect(decision.role).toBe("research");
  });

  it("should detect simple queries and route to general-chat", () => {
    const decision = router.getOptimalRoute({
      messages: [{ role: "user", content: "什么是 TypeScript?" }],
    });
    expect(decision.complexity).toBe("simple");
    expect(decision.role).toBe("general-chat");
  });

  it("should detect complex queries by length and keywords", () => {
    const longMessage = "请帮我设计一个高并发的分布式系统架构，需要考虑性能、安全性、扩展性，包括数据库分片、缓存策略、负载均衡、消息队列、监控告警等方面。".repeat(2);
    const decision = router.getOptimalRoute({
      messages: [{ role: "user", content: longMessage }],
    });
    expect(decision.complexity).toBe("complex");
  });

  it("should record outcome and provide feedback", () => {
    const decision = router.getOptimalRoute({
      messages: [{ role: "user", content: "implement a binary search tree" }],
    });
    router.recordOutcome({
      decision,
      success: true,
      latencyMs: 1500,
    });
    // Just verify no errors
    expect(decision).toBeDefined();
  });

  it("should return fallback chain", () => {
    const decision = router.getOptimalRoute({
      messages: [{ role: "user", content: "写代码" }],
    });
    expect(decision.model).toBeDefined();
    expect(Array.isArray(decision.fallbackChain)).toBe(true);
  });

  it("should handle empty messages gracefully", () => {
    const decision = router.getOptimalRoute({
      messages: [],
    });
    expect(decision).toBeDefined();
    expect(decision.role).toBeDefined();
  });

  it("getRecentSuccessRate should respect time window", () => {
    const localRouter = new IntelligentRouter();
    const decision = localRouter.getOptimalRoute({
      messages: [{ role: "user", content: "implement a binary search tree" }],
    });

    // Record 4 outcomes: 3 success + 1 failure, all with current timestamp
    for (let i = 0; i < 3; i++) {
      localRouter.recordOutcome({
        decision,
        success: true,
        latencyMs: 1000,
      });
    }
    localRouter.recordOutcome({
      decision,
      success: false,
      latencyMs: 2000,
      errorMessage: "test failure",
    });

    // Within 1 hour window: 3/4 = 0.75
    const recentRate = localRouter.getRecentSuccessRate(decision.model.id, 3600_000);
    expect(recentRate).toBe(0.75);

    // Add 3 records with timestamps far in the past (older than 100ms window)
    for (let i = 0; i < 3; i++) {
      localRouter.recordOutcome({
        decision,
        success: true,
        latencyMs: 1000,
        timestamp: Date.now() - 10_000, // 10 seconds ago
      });
    }
    // With a tiny 100ms window, the 3 fresh + 1 failure are still in window (3/4 = 0.75)
    // But the old ones (10s ago) should be filtered out
    const narrowRate = localRouter.getRecentSuccessRate(decision.model.id, 100);
    expect(narrowRate).toBe(0.75); // still 3/4 from the fresh records

    // Now test that with no fresh records and a tiny window, we get null
    const emptyRouter = new IntelligentRouter();
    const emptyDecision = emptyRouter.getOptimalRoute({
      messages: [{ role: "user", content: "implement a binary search tree" }],
    });
    for (let i = 0; i < 3; i++) {
      emptyRouter.recordOutcome({
        decision: emptyDecision,
        success: true,
        latencyMs: 1000,
        timestamp: Date.now() - 10_000, // all old
      });
    }
    // 100ms window should exclude the 10s-old records → 0 records → null
    const oldRate = emptyRouter.getRecentSuccessRate(emptyDecision.model.id, 100);
    expect(oldRate).toBeNull();
  });

  it("getRecentSuccessRate should return null when fewer than 3 samples", () => {
    const localRouter = new IntelligentRouter();
    const decision = localRouter.getOptimalRoute({
      messages: [{ role: "user", content: "implement a binary search tree" }],
    });
    localRouter.recordOutcome({ decision, success: true, latencyMs: 1000 });
    localRouter.recordOutcome({ decision, success: true, latencyMs: 1000 });
    // Only 2 samples — should return null
    expect(localRouter.getRecentSuccessRate(decision.model.id, 3600_000)).toBeNull();
  });
});
