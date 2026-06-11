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
});
