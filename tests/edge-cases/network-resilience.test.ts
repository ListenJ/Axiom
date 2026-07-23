/**
 * 边缘场景测试 D — 网络波动模拟 + 恢复能力
 *
 * 测试目标：验证组件在网络异常和错误风暴下的熔断、重试与恢复能力。
 * 覆盖组件：LLMClient（熔断器 + 重试 + 恢复）、EventBus（错误恢复）、
 *           Cache（TTL 过期恢复）、Scheduler（任务失败恢复）
 *
 * 网络波动模拟方法：
 *   - mock 全局 fetch 函数模拟 HTTP 错误（429/500/503）
 *   - 模拟网络超时（AbortError）
 *   - 模拟间歇性成功/失败
 *
 * 熔断器状态机：
 *   closed（正常）→ 连续失败达阈值 → open（熔断，拒绝请求）
 *   open → 冷却期过后 → half-open（试探性请求）
 *   half-open → 成功 → closed | 失败 → open
 *
 * 恢复能力验证：
 *   - 错误风暴后系统能自愈
 *   - 状态一致性不被破坏
 *   - 资源不被泄漏
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { LLMClient } from "../../src/dre/llm/client.js";
import { scheduler } from "../../src/dre/runtime/scheduler.js";
import { eventBus } from "../../src/dre/runtime/event-bus.js";
import { Cache } from "../../src/utils/cache.js";

// ─── fetch mock 工具 ───────────────────────────────────────────

type FetchMock = (
  responses: Array<{ status: number; body?: unknown } | Error>,
) => () => void;

/** 安装 fetch mock，按顺序返回预设响应 */
const installFetchMock: FetchMock = (responses) => {
  const originalFetch = globalThis.fetch;
  let callIndex = 0;
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const resp = responses[callIndex % responses.length];
    callIndex++;
    if (resp instanceof Error) {
      return Promise.reject(resp);
    }
    const defaultBody = {
      choices: [{ message: { content: "mock response" }, finish_reason: "stop" }],
      model: "test-model",
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    };
    const body = resp.body
      ? { ...defaultBody, ...(resp.body as Record<string, unknown>) }
      : defaultBody;
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status: resp.status,
        headers: { "Content-Type": "application/json" },
      }),
    );
  }) as typeof fetch;
  return () => {
    globalThis.fetch = originalFetch;
  };
};

// ═══════════════════════════════════════════════════════════════
// D.1 LLMClient 熔断器
// ═══════════════════════════════════════════════════════════════

describe("D.1 LLMClient 熔断器状态机", () => {
  let restoreFetch: () => void;
  beforeEach(() => {
    restoreFetch = () => {};
  });
  afterEach(() => {
    restoreFetch();
  });

  test("连续失败达阈值应触发熔断（closed → open）", async () => {
    const client = new LLMClient({
      baseUrl: "http://mock",
      apiKey: "test-key",
      model: "test-model",
      retry: { maxRetries: 0 }, // 禁用重试以便快速触发熔断
      circuitBreaker: { failureThreshold: 3, cooldownMs: 60000 },
    });

    // mock 500 错误
    restoreFetch = installFetchMock([{ status: 500 }]);

    // 触发 3 次失败
    for (let i = 0; i < 3; i++) {
      try {
        await client.generate("test");
      } catch {
        // 预期失败
      }
    }

    expect(client.getCircuitState()).toBe("open");
    const stats = client.getStats();
    expect(stats.failureCount).toBe(3);
    console.log(`[Stress] llm-circuit-open: failures=${stats.failureCount}, state=${stats.circuitState}`);
  });

  test("熔断状态下请求应被立即拒绝", async () => {
    const client = new LLMClient({
      baseUrl: "http://mock",
      apiKey: "test-key",
      model: "test-model",
      retry: { maxRetries: 0 },
      circuitBreaker: { failureThreshold: 2, cooldownMs: 60000 },
    });

    restoreFetch = installFetchMock([{ status: 500 }]);

    // 触发熔断
    for (let i = 0; i < 2; i++) {
      try {
        await client.generate("test");
      } catch {
        // 预期失败
      }
    }
    expect(client.getCircuitState()).toBe("open");

    // 熔断状态下请求应立即抛错（不调用 fetch）
    const t0 = performance.now();
    try {
      await client.generate("should-be-rejected");
    } catch (e) {
      expect(String(e)).toContain("circuit breaker");
    }
    const elapsed = performance.now() - t0;
    // 应在 50ms 内拒绝（无网络等待）
    expect(elapsed).toBeLessThan(50);
    console.log(`[Stress] llm-circuit-reject: elapsed=${elapsed.toFixed(0)}ms`);
  });

  test("熔断冷却期后应进入 half-open 状态", async () => {
    const client = new LLMClient({
      baseUrl: "http://mock",
      apiKey: "test-key",
      model: "test-model",
      retry: { maxRetries: 0 },
      circuitBreaker: { failureThreshold: 2, cooldownMs: 100 }, // 100ms 冷却
    });

    restoreFetch = installFetchMock([{ status: 500 }]);

    // 触发熔断
    for (let i = 0; i < 2; i++) {
      try {
        await client.generate("test");
      } catch {
        // 预期失败
      }
    }
    expect(client.getCircuitState()).toBe("open");

    // 等待冷却期
    await new Promise((r) => setTimeout(r, 150));

    // getCircuitState 应返回 half-open
    expect(client.getCircuitState()).toBe("half-open");
    console.log(`[Stress] llm-circuit-half-open: state=${client.getCircuitState()}`);
  });

  test("half-open 状态下成功应恢复到 closed", async () => {
    const client = new LLMClient({
      baseUrl: "http://mock",
      apiKey: "test-key",
      model: "test-model",
      retry: { maxRetries: 0 },
      circuitBreaker: { failureThreshold: 2, cooldownMs: 100 },
    });

    // 先失败触发熔断
    restoreFetch = installFetchMock([{ status: 500 }]);
    for (let i = 0; i < 2; i++) {
      try {
        await client.generate("test");
      } catch {
        // 预期失败
      }
    }
    expect(client.getCircuitState()).toBe("open");

    // 等待冷却
    await new Promise((r) => setTimeout(r, 150));

    // 恢复 fetch 为成功
    restoreFetch();
    restoreFetch = installFetchMock([{ status: 200, body: { choices: [{ message: { content: "recovered" }, finish_reason: "stop" }] } }]);

    // half-open 状态下成功请求
    const resp = await client.generate("recovery-test");
    expect(resp.content).toBe("recovered");
    expect(client.getCircuitState()).toBe("closed");

    const stats = client.getStats();
    expect(stats.successCount).toBe(1);
    console.log(`[Stress] llm-circuit-recovered: state=${stats.circuitState}, success=${stats.successCount}`);
  });

  test("resetCircuit 手动重置应立即恢复", async () => {
    const client = new LLMClient({
      baseUrl: "http://mock",
      apiKey: "test-key",
      model: "test-model",
      retry: { maxRetries: 0 },
      circuitBreaker: { failureThreshold: 2, cooldownMs: 60000 },
    });

    restoreFetch = installFetchMock([{ status: 500 }]);
    for (let i = 0; i < 2; i++) {
      try {
        await client.generate("test");
      } catch {
        // 预期失败
      }
    }
    expect(client.getCircuitState()).toBe("open");

    client.resetCircuit();
    expect(client.getCircuitState()).toBe("closed");
    expect(client.getStats().consecutiveFailures).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════
// D.2 LLMClient 重试机制
// ═══════════════════════════════════════════════════════════════

describe("D.2 LLMClient 重试机制", () => {
  let restoreFetch: () => void;
  afterEach(() => restoreFetch());

  test("429 错误应触发重试", async () => {
    const client = new LLMClient({
      baseUrl: "http://mock",
      apiKey: "test-key",
      model: "test-model",
      retry: { maxRetries: 2, baseDelayMs: 10, maxDelayMs: 50 },
      circuitBreaker: { failureThreshold: 10, cooldownMs: 60000 },
    });

    // 前两次 429，第三次成功
    restoreFetch = installFetchMock([
      { status: 429 },
      { status: 429 },
      { status: 200, body: { choices: [{ message: { content: "success after retry" }, finish_reason: "stop" }] } },
    ]);

    const resp = await client.generate("retry-test");
    expect(resp.content).toBe("success after retry");
    expect(client.getStats().retryCount).toBe(2);
    expect(client.getStats().successCount).toBe(1);
    console.log(`[Stress] llm-retry-429: retries=${client.getStats().retryCount}, success=${client.getStats().successCount}`);
  });

  test("网络层错误（fetch reject）应触发重试", async () => {
    const client = new LLMClient({
      baseUrl: "http://mock",
      apiKey: "test-key",
      model: "test-model",
      retry: { maxRetries: 1, baseDelayMs: 10, maxDelayMs: 50 },
      circuitBreaker: { failureThreshold: 10, cooldownMs: 60000 },
    });

    // 第一次网络错误，第二次成功
    restoreFetch = installFetchMock([
      new Error("fetch failed: ECONNREFUSED"),
      { status: 200, body: { choices: [{ message: { content: "recovered" }, finish_reason: "stop" }] } },
    ]);

    const resp = await client.generate("network-retry-test");
    expect(resp.content).toBe("recovered");
    expect(client.getStats().retryCount).toBe(1);
  });

  test("不可重试错误（401）不应重试", async () => {
    const client = new LLMClient({
      baseUrl: "http://mock",
      apiKey: "test-key",
      model: "test-model",
      retry: { maxRetries: 3, baseDelayMs: 10, maxDelayMs: 50 },
      circuitBreaker: { failureThreshold: 10, cooldownMs: 60000 },
    });

    restoreFetch = installFetchMock([{ status: 401 }]);

    try {
      await client.generate("auth-test");
      expect(false).toBe(true); // 不应到达
    } catch (e) {
      expect(String(e)).toContain("401");
    }
    expect(client.getStats().retryCount).toBe(0); // 不应重试
  });
});

// ═══════════════════════════════════════════════════════════════
// D.3 恢复能力 — 错误风暴后自愈
// ═══════════════════════════════════════════════════════════════

describe("D.3 恢复能力 — 错误风暴后自愈", () => {
  test("EventBus 错误风暴后仍可正常工作", () => {
    const subIds: string[] = [];
    let successCount = 0;

    // 注册 5 个会抛错的 handler + 1 个正常的
    for (let i = 0; i < 5; i++) {
      subIds.push(
        eventBus.subscribe("storm-test", () => {
          throw new Error(`handler-${i} error`);
        }),
      );
    }
    subIds.push(
      eventBus.subscribe("storm-test", () => {
        successCount++;
      }),
    );

    // 发送 100 个事件（每个触发 5 个错误 + 1 个成功）
    for (let i = 0; i < 100; i++) {
      eventBus.publish({ type: "storm-test", source: "test", data: null, priority: "normal" });
    }

    // 正常 handler 应全部执行（不受错误 handler 影响）
    expect(successCount).toBe(100);

    // 错误应被统计
    const stats = eventBus.getStats();
    expect(stats.errors).toBeGreaterThanOrEqual(500);

    // 清理后恢复正常
    for (const id of subIds) eventBus.unsubscribe(id);

    // 验证清理后系统正常
    let postCleanCount = 0;
    const newSub = eventBus.subscribe("post-storm-test", () => { postCleanCount++; });
    eventBus.publish({ type: "post-storm-test", source: "test", data: null, priority: "normal" });
    expect(postCleanCount).toBe(1);
    eventBus.unsubscribe(newSub);

    console.log(`[Stress] eventbus-storm-recovery: errors=${stats.errors}, successCount=${successCount}, postClean=${postCleanCount}`);
  });

  test("Scheduler 任务失败风暴后仍可调度新任务", () => {
    scheduler.reset();

    // 提交并失败 50 个任务（需先 getNext 移入 running 才能 fail）
    for (let i = 0; i < 50; i++) {
      scheduler.submit({
        name: "fail-test",
        priority: "normal" as never,
        payload: { idx: i },
        maxRetries: 0,
        dependencies: [],
      });
      const running = scheduler.getNext();
      if (running) scheduler.fail(running.id, `intentional failure ${i}`);
    }

    // 提交新任务应仍能被调度
    const newTask = scheduler.submit({
      name: "recovery-test",
      priority: "normal" as never,
      payload: { msg: "recovery" },
      maxRetries: 0,
      dependencies: [],
    });
    const next = scheduler.getNext();
    expect(next).not.toBeNull();
    expect(next?.id).toBe(newTask.id);

    scheduler.reset();
    console.log(`[Stress] scheduler-fail-storm-recovery: failed=50, recovered=true`);
  });

  test("Cache LRU 风暴后仍可正常存取", () => {
    const cache = new Cache<string>({ maxSize: 10, defaultTtlMs: 0, persistent: false });

    // 写入 1000 个 key（触发大量 LRU 淘汰）
    for (let i = 0; i < 1000; i++) {
      cache.set(`storm-key-${i}`, `val-${i}`);
    }

    // 验证缓存仍可用
    cache.set("post-storm", "recovered");
    expect(cache.getSync("post-storm")).toBe("recovered");
    expect(cache.stats().size).toBeLessThanOrEqual(10);

    // 验证最新写入的 key 可读（LRU 保留最近 10 个）
    expect(cache.getSync("storm-key-999")).toBeDefined();

    cache.destroy();
    console.log(`[Stress] cache-lru-storm-recovery: size=${cache.stats().size}`);
  });
});
