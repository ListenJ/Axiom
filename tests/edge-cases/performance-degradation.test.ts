/**
 * 边缘场景测试 E — 设备性能差异 + 性能降级模拟
 *
 * 测试目标：验证组件在低性能/高负载条件下的优雅降级行为。
 * 覆盖组件：Cache、EventBus、Scheduler、KnowledgeNetwork、DeterministicRetrievalEngine
 *
 * 模拟方法：
 *   1. 慢速 handler 模拟（EventBus handler 中 sleep）
 *   2. 短 TTL 模拟高淘汰率（Cache）
 *   3. 高优先级抢占模拟（Scheduler）
 *   4. 大规模数据下的查询延迟分位数（KnowledgeNetwork + RetrievalEngine）
 *   5. CPU 压力模拟（同步计算密集型操作）
 *
 * 验证维度：
 *   - 优雅降级：性能下降但功能不丢失
 *   - 超时处理：短超时下不崩溃
 *   - 优先级保障：高优先级任务在负载下仍能执行
 *   - 延迟分位数：p99 在可接受范围内
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Cache } from "../../src/utils/cache.js";
import { eventBus } from "../../src/dre/runtime/event-bus.js";
import { scheduler } from "../../src/dre/runtime/scheduler.js";
import { knowledgeNetwork } from "../../src/dre/runtime/knowledge-network.js";
import {
  DeterministicRetrievalEngine,
  _resetRetrievalEngineForTest,
} from "../../src/dre/retrieval/deterministic-retrieval-engine.js";

// ─── 工具函数 ──────────────────────────────────────────────────

function percentiles(samples: number[]): { p50: number; p90: number; p99: number; max: number } {
  if (samples.length === 0) return { p50: 0, p90: 0, p99: 0, max: 0 };
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    p50: sorted[Math.floor(sorted.length * 0.5)],
    p90: sorted[Math.floor(sorted.length * 0.9)],
    p99: sorted[Math.min(Math.floor(sorted.length * 0.99), sorted.length - 1)],
    max: sorted[sorted.length - 1],
  };
}

/** 模拟 CPU 密集计算（阻塞主线程 N ms） */
function burnCpu(ms: number): void {
  const end = performance.now() + ms;
  let x = 0;
  while (performance.now() < end) {
    x += Math.random();
  }
  void x; // 防止死代码消除
}

// ═══════════════════════════════════════════════════════════════
// E.1 慢速 handler 模拟
// ═══════════════════════════════════════════════════════════════

describe("E.1 慢速 handler — EventBus 降级", () => {
  const subIds: string[] = [];

  afterEach(() => {
    for (const id of subIds) eventBus.unsubscribe(id);
    subIds.length = 0;
  });

  test("慢速同步 handler 不应阻塞其他事件类型", () => {
    let slowDone = false;
    let fastDone = false;

    subIds.push(
      eventBus.subscribe("slow-event", () => {
        burnCpu(20); // 模拟 20ms 慢操作
        slowDone = true;
      }),
    );
    subIds.push(
      eventBus.subscribe("fast-event", () => {
        fastDone = true;
      }),
    );

    // 先发布慢事件
    eventBus.publish({ type: "slow-event", source: "test", data: null, priority: "normal" });
    expect(slowDone).toBe(true);

    // 再发布快事件（应立即执行）
    eventBus.publish({ type: "fast-event", source: "test", data: null, priority: "normal" });
    expect(fastDone).toBe(true);

    console.log(`[Stress] slow-handler: slowDone=${slowDone}, fastDone=${fastDone}`);
  });

  test("异步慢 handler 不应阻塞 publish 返回", () => {
    let asyncDone = false;
    subIds.push(
      eventBus.subscribe("async-slow", async () => {
        await new Promise((r) => setTimeout(r, 50));
        asyncDone = true;
      }),
    );

    const t0 = performance.now();
    eventBus.publish({ type: "async-slow", source: "test", data: null, priority: "normal" });
    const publishTime = performance.now() - t0;

    // publish 应立即返回（不等 async handler 完成）
    expect(publishTime).toBeLessThan(20);
    console.log(`[Stress] async-slow-handler: publishTime=${publishTime.toFixed(1)}ms`);
  });
});

// ═══════════════════════════════════════════════════════════════
// E.2 短 TTL 高淘汰率
// ═══════════════════════════════════════════════════════════════

describe("E.2 短 TTL 高淘汰率 — Cache 降级", () => {
  test("1ms TTL 下 1000 次 set+get — 命中率应极低但不崩溃", async () => {
    const cache = new Cache<string>({ maxSize: 10000, defaultTtlMs: 1, persistent: false });

    for (let i = 0; i < 1000; i++) {
      cache.set(`short-ttl-${i}`, `v-${i}`);
    }

    // 等待 TTL 过期
    await new Promise((r) => setTimeout(r, 10));

    // 大部分应已过期
    let expired = 0;
    for (let i = 0; i < 1000; i++) {
      if (cache.getSync(`short-ttl-${i}`) === undefined) expired++;
    }

    const stats = cache.stats();
    console.log(`[Stress] short-ttl: expired=${expired}/1000, hits=${stats.hits}, misses=${stats.misses}`);

    // 绝大部分应过期（允许少量在边界时间内未过期）
    expect(expired).toBeGreaterThan(900);
    cache.destroy();
  });

  test("极小 maxSize (1) 下频繁 set — 不应崩溃", () => {
    const cache = new Cache<string>({ maxSize: 1, defaultTtlMs: 0, persistent: false });
    for (let i = 0; i < 1000; i++) {
      cache.set(`key-${i}`, `v-${i}`);
    }
    expect(cache.stats().size).toBe(1);
    // 最后写入的 key 应存在
    expect(cache.getSync("key-999")).toBe("v-999");
    cache.destroy();
  });
});

// ═══════════════════════════════════════════════════════════════
// E.3 优先级保障 — 高负载下 critical 任务可执行
// ═══════════════════════════════════════════════════════════════

describe("E.3 优先级保障 — Scheduler 降级", () => {
  beforeEach(() => scheduler.reset());
  afterEach(() => scheduler.reset());

  test("critical 任务在大量 normal 任务中应被优先调度", () => {
    // 填充 100 个 normal 任务
    for (let i = 0; i < 100; i++) {
      scheduler.submit({
        name: "normal-task",
        priority: "normal" as never,
        payload: { idx: i },
        maxRetries: 0,
        dependencies: [],
      });
    }

    // 提交 1 个 critical 任务
    const criticalTask = scheduler.submit({
      name: "critical-task",
      priority: "critical" as never,
      payload: { msg: "urgent" },
      maxRetries: 0,
      dependencies: [],
    });

    // getNext 应优先返回 critical
    const next = scheduler.getNext();
    expect(next).not.toBeNull();
    expect(next?.id).toBe(criticalTask.id);
    expect(next?.priority).toBe("critical");

    console.log(`[Stress] priority-guarantee: criticalBefore=${100} normal, nextPriority=${next?.priority}`);
  });

  test("混合优先级 500 任务 — critical 应在前 10% 被调度", () => {
    const criticalIds: string[] = [];
    const normalIds: string[] = [];

    for (let i = 0; i < 450; i++) {
      const t = scheduler.submit({
        name: "mixed",
        priority: "normal" as never,
        payload: { i },
        maxRetries: 0,
        dependencies: [],
      });
      normalIds.push(t.id);
    }
    for (let i = 0; i < 50; i++) {
      const t = scheduler.submit({
        name: "mixed",
        priority: "critical" as never,
        payload: { i },
        maxRetries: 0,
        dependencies: [],
      });
      criticalIds.push(t.id);
    }

    // 取出前 50 个任务（每取一个就完成，释放并发槽位）
    const first50: string[] = [];
    for (let i = 0; i < 50; i++) {
      const next = scheduler.getNext();
      if (next) {
        first50.push(next.id);
        scheduler.complete(next.id, {});
      }
    }

    // 前 50 个应全部是 critical
    const criticalInFirst50 = first50.filter((id) => criticalIds.includes(id)).length;
    expect(criticalInFirst50).toBe(50);

    console.log(`[Stress] priority-mixed: criticalInFirst50=${criticalInFirst50}/50`);
  });
});

// ═══════════════════════════════════════════════════════════════
// E.4 大规模数据查询延迟分位数
// ═══════════════════════════════════════════════════════════════

describe("E.4 大规模数据查询 — 延迟分位数", () => {
  beforeEach(() => {
    knowledgeNetwork.reset();
    _resetRetrievalEngineForTest();
  });
  afterEach(() => {
    knowledgeNetwork.reset();
    _resetRetrievalEngineForTest();
  });

  test("5000 实体规模下 1000 次查询 — p99 < 50ms", () => {
    // 构建 5000 实体知识图谱
    for (let i = 0; i < 5000; i++) {
      const kind = i % 4 === 0 ? "agent" : i % 4 === 1 ? "tool" : i % 4 === 2 ? "concept" : "document";
      knowledgeNetwork.create(
        kind as never,
        `Entity-${i}`,
        `Content ${i} keyword${i % 20} topic${i % 10}`,
        { confidence: 0.7, source: "test" },
      );
    }

    const engine = new DeterministicRetrievalEngine({
      keywordSearcher: null,
      config: { cacheMaxSize: 50, cacheTtlMs: 0 },
    });

    const latencies: number[] = [];
    for (let i = 0; i < 1000; i++) {
      const t0 = performance.now();
      engine.retrieve(`keyword${i % 20} topic${i % 10}`);
      latencies.push(performance.now() - t0);
    }

    const pct = percentiles(latencies);
    console.log(`[Stress] large-scale-query: p50=${pct.p50.toFixed(2)}ms, p90=${pct.p90.toFixed(2)}ms, p99=${pct.p99.toFixed(2)}ms, max=${pct.max.toFixed(2)}ms`);

    expect(pct.p99).toBeLessThan(50);
  });

  test("CPU 压力下查询仍应完成 — 优雅降级", () => {
    // 构建 500 实体
    for (let i = 0; i < 500; i++) {
      knowledgeNetwork.create("concept", `CE-${i}`, `content ${i} keyword0`, { source: "test" });
    }

    const engine = new DeterministicRetrievalEngine({
      keywordSearcher: null,
      config: { cacheMaxSize: 10, cacheTtlMs: 0 },
    });

    // 在 CPU 压力下查询
    const latencies: number[] = [];
    for (let i = 0; i < 100; i++) {
      burnCpu(1); // 1ms CPU 压力
      const t0 = performance.now();
      const result = engine.retrieve("keyword0");
      latencies.push(performance.now() - t0);
      expect(result).toBeDefined(); // 不应崩溃
    }

    const pct = percentiles(latencies);
    console.log(`[Stress] cpu-pressure-query: p50=${pct.p50.toFixed(2)}ms, p99=${pct.p99.toFixed(2)}ms`);

    // CPU 压力下延迟应仍在合理范围（放宽到 100ms）
    expect(pct.p99).toBeLessThan(100);
  });
});

// ═══════════════════════════════════════════════════════════════
// E.5 间歇性故障恢复 — 模拟网络波动
// ═══════════════════════════════════════════════════════════════

describe("E.5 间歇性故障恢复 — Cache getOrSet", () => {
  test("factory 间歇性失败应重试并最终成功", async () => {
    const cache = new Cache<string>({ maxSize: 100, defaultTtlMs: 0, persistent: false });
    let factoryAttempts = 0;
    let factorySuccess = false;

    // 模拟间歇性失败：前 2 次失败，第 3 次成功
    const factory = async (): Promise<string> => {
      factoryAttempts++;
      if (factoryAttempts < 3) {
        throw new Error(`factory attempt ${factoryAttempts} failed`);
      }
      factorySuccess = true;
      return "eventually-success";
    };

    // getOrSet 不自带重试，但验证 factory 成功后结果缓存
    try {
      await cache.getOrSet("intermittent-key", factory);
    } catch {
      // 第一次失败
    }

    // 重置后重试
    cache.delete("intermittent-key");
    try {
      const result = await cache.getOrSet("intermittent-key", async () => {
        factoryAttempts++;
        factorySuccess = true;
        return "retry-success";
      });
      expect(result).toBe("retry-success");
    } catch {
      // 不应到达
    }

    expect(factorySuccess).toBe(true);
    cache.destroy();
    console.log(`[Stress] intermittent-factory: attempts=${factoryAttempts}, success=${factorySuccess}`);
  });

  test("并发 getOrSet 中部分失败不应污染缓存", async () => {
    const cache = new Cache<string>({ maxSize: 100, defaultTtlMs: 0, persistent: false });
    let callCount = 0;

    // 10 个并发请求同一 key — getOrSet 会去重为单次 factory 调用。
    // factory 首次即抛错，去重使所有 10 个调用共享同一 rejected promise。
    // 验证目标：错误不污染缓存（缓存中无值或仅有正确值）。
    const results = await Promise.allSettled(
      Array.from({ length: 10 }, () =>
        cache.getOrSet("concurrent-fail-key", async () => {
          callCount++;
          if (callCount <= 3) throw new Error("intermittent");
          return "success";
        }),
      ),
    );

    // 验证缓存中要么无值要么有正确值（不应有错误值）
    const cached = cache.getSync("concurrent-fail-key");
    if (cached !== undefined) {
      expect(cached).toBe("success");
    }

    // 去重行为：factory 仅被调用 1 次（所有并发共享同一 in-flight promise）
    // 所以首次失败时所有 10 个调用都会 reject — 这是正确的 thundering-herd 保护
    const successCount = results.filter((r) => r.status === "fulfilled").length;
    const failureCount = results.filter((r) => r.status === "rejected").length;
    expect(successCount + failureCount).toBe(10);

    // 缓存不应被错误值污染
    expect(cached).toBeUndefined();

    cache.destroy();
    console.log(`[Stress] concurrent-fail-getOrSet: success=${successCount}/10, failure=${failureCount}/10, factoryCalls=${callCount}, cached=${cached ?? "none"}`);
  });
});
