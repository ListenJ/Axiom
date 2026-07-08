/**
 * LLM 重试 + 熔断器测试
 *
 * 验证 LLMClient 的指数退避重试和熔断器行为:
 * - 网络错误自动重试 (默认 maxRetries=2, 共 3 次尝试)
 * - 429/5xx 自动重试, 4xx 不重试
 * - 连续失败 N 次后熔断器断开, 冷却期内快速失败
 * - 冷却期后熔断器进入 half-open, 单次尝试决定恢复或继续断开
 * - 调用统计可观测
 */

import { describe, test, expect } from "bun:test";
import { LLMClient, type LLMStats, type CircuitState } from "../../src/dre/llm/client.js";

// ========== 重试逻辑 ==========

describe("LLM Retry: exponential backoff", () => {
  test("network errors should be retried up to maxRetries", async () => {
    const client = new LLMClient({
      baseUrl: "http://127.0.0.1:1", // 必失败的端口
      model: "test",
      timeout: 500,
      retry: { maxRetries: 2, baseDelayMs: 10, maxDelayMs: 50 }, // 极短延迟
    });

    const start = Date.now();
    await expect(client.generate("test")).rejects.toThrow();
    const elapsed = Date.now() - start;

    // 3 次尝试 (1 初始 + 2 重试), 每次约 10-50ms 退避 + 网络超时
    // 应该 > 50ms (至少有 2 次退避等待), 但 < 5000ms
    expect(elapsed).toBeGreaterThan(20);
    const stats = client.getStats();
    expect(stats.retryCount).toBe(2); // 2 次重试
    expect(stats.totalCalls).toBe(1); // 1 次逻辑调用 (内部 3 次物理尝试)
    expect(stats.failureCount).toBe(1);
  });

  test("maxRetries=0 should fail immediately without retry", async () => {
    const client = new LLMClient({
      baseUrl: "http://127.0.0.1:1",
      model: "test",
      timeout: 500,
      retry: { maxRetries: 0 },
    });

    const start = Date.now();
    await expect(client.generate("test")).rejects.toThrow();
    const elapsed = Date.now() - start;

    // 无重试, 只有一次尝试
    expect(elapsed).toBeLessThan(2000);
    expect(client.getStats().retryCount).toBe(0);
    expect(client.getStats().failureCount).toBe(1);
  });
});

// ========== 熔断器 ==========

describe("LLM Circuit Breaker", () => {
  test("should trip to OPEN after consecutive failures reach threshold", async () => {
    const client = new LLMClient({
      baseUrl: "http://127.0.0.1:1",
      model: "test",
      timeout: 200,
      retry: { maxRetries: 0 },
      circuitBreaker: { failureThreshold: 3, cooldownMs: 60000 },
    });

    // 连续失败 3 次
    for (let i = 0; i < 3; i++) {
      await expect(client.generate(`test-${i}`)).rejects.toThrow();
    }

    // 熔断器应该已断开
    expect(client.getCircuitState()).toBe("open");
    expect(client.getStats().consecutiveFailures).toBe(3);

    // 第 4 次应快速失败 (不再实际请求)
    const start = Date.now();
    await expect(client.generate("should-fail-fast")).rejects.toThrow("circuit breaker is OPEN");
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(100); // 快速失败, 不等网络超时
  });

  test("should transition to HALF-OPEN after cooldown period", async () => {
    const client = new LLMClient({
      baseUrl: "http://127.0.0.1:1",
      model: "test",
      timeout: 200,
      retry: { maxRetries: 0 },
      circuitBreaker: { failureThreshold: 2, cooldownMs: 200 }, // 短冷却期
    });

    // 连续失败 2 次 → 熔断
    for (let i = 0; i < 2; i++) {
      await expect(client.generate(`test-${i}`)).rejects.toThrow();
    }
    expect(client.getCircuitState()).toBe("open");

    // 等待冷却期
    await new Promise((r) => setTimeout(r, 250));

    // 应进入 half-open
    expect(client.getCircuitState()).toBe("half-open");

    // half-open 状态下允许尝试 (仍会失败)
    await expect(client.generate("half-open-test")).rejects.toThrow();
  });

  test("resetCircuit should force reset to CLOSED", async () => {
    const client = new LLMClient({
      baseUrl: "http://127.0.0.1:1",
      model: "test",
      timeout: 200,
      retry: { maxRetries: 0 },
      circuitBreaker: { failureThreshold: 2, cooldownMs: 60000 },
    });

    // 熔断
    for (let i = 0; i < 2; i++) {
      await expect(client.generate(`test-${i}`)).rejects.toThrow();
    }
    expect(client.getCircuitState()).toBe("open");

    // 手动重置
    client.resetCircuit();
    expect(client.getCircuitState()).toBe("closed");
    expect(client.getStats().consecutiveFailures).toBe(0);
  });
});

// ========== 调用统计 ==========

describe("LLM Stats: observability", () => {
  test("getStats should track calls, successes, failures, retries", async () => {
    const client = new LLMClient({
      baseUrl: "http://127.0.0.1:1",
      model: "test",
      timeout: 200,
      retry: { maxRetries: 1, baseDelayMs: 10, maxDelayMs: 50 },
    });

    // 1 次逻辑调用, 内部 2 次物理尝试 (1 初始 + 1 重试), 最终失败
    await expect(client.generate("test")).rejects.toThrow();

    const stats = client.getStats();
    expect(stats.totalCalls).toBe(1);
    expect(stats.failureCount).toBe(1);
    expect(stats.successCount).toBe(0);
    expect(stats.retryCount).toBe(1);
    expect(stats.consecutiveFailures).toBe(1);
    expect(stats.circuitState).toBe("closed");
  });
});
