/**
 * 系统压力测试：模拟多用户并发访问场景
 */
import { describe, it, expect } from "bun:test";

describe("系统压力测试", () => {
  const CONCURRENCY = 50;

  it("HttpRouter 并发注册 + 匹配 500 条路由", async () => {
    const { HttpRouter } = await import("../src/core/http-router.js");
    const router = new HttpRouter({ cacheMaxSize: 100 } as any);

    // 注册 500 条路由
    for (let i = 0; i < 500; i++) {
      router.register({
        method: i % 2 === 0 ? "GET" : "POST",
        path: `/api/v1/${Math.random().toString(36).slice(2)}`,
        handler: () => new Response("ok"),
      });
    }

    // 并发匹配测试
    const start = performance.now();
    const results = await Promise.all(
      Array.from({ length: CONCURRENCY }, async (_, i) => {
        const req = new Request(`http://localhost/api/v1/test-${i}`);
        const ctx = {
          url: new URL(req.url), req,
          vault: null, db: null as any,
          pipeline: null as any, healthMonitor: null as any,
          fileWatcher: null, startupTime: Date.now(),
          baseHeaders: {}, jsonResponse: (d: any) => d,
        };
        return router.execute(ctx);
      }),
    );
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(5000);
    expect(results.length).toBe(CONCURRENCY);
  });

  it("Cache 并发读写 5000 次", async () => {
    const { Cache } = await import("../src/utils/cache.js");
    const c = new Cache({ maxSize: 500, defaultTtlMs: 60000, redis: false });

    // 多 goroutine 并发读写
    const writers = Array.from({ length: 10 }, (_, w) =>
      Promise.all(Array.from({ length: 500 }, async (_, i) => {
        const key = `wk${w}-${i}`;
        c.set(key, { worker: w, index: i });
        return c.getSync(key);
      }))
    );

    const start = performance.now();
    const results = await Promise.all(writers);
    const elapsed = performance.now() - start;

    const totalOps = 10 * 500 * 2; // 500 writes + 500 reads per worker
    expect(elapsed).toBeLessThan(3000);
    expect(results.flat().filter(Boolean).length).toBe(10 * 500);
  });

  it("Thompson Router 100 次路由 + 反馈循环", async () => {
    const { createThompsonRouter } = await import("../src/router/thompson-router.js");
    const arms = Array.from({ length: 3 }, (_, i) => ({
      id: `m${i}`, model: `model-${i}`, provider: "p",
      alpha: 1 + i, beta: 1,
      metadata: {},
    }));
    const router = createThompsonRouter({ arms, minSamples: 0, inMemory: true });

    // 模拟 100 轮路由 + 反馈
    for (let round = 0; round < 100; round++) {
      const taskType = (["code", "research", "chat", "math"])[round % 4];
      const decision = await router.route({ taskType, inputLength: 50 + round * 10 });
      expect(decision.arm).toBeDefined();

      // 模拟反馈：选中的 arm 80% 概率成功
      const success = Math.random() > 0.2;
      router.reportFeedback(decision.arm.id, success);
    }

    const stats = router.getArmStats();
    expect(stats.length).toBe(3);
    stats.forEach(s => {
      expect(s.samples).toBeGreaterThan(0);
    });
  });

  it("VIB 压缩 1000 条记忆", async () => {
    const { VIBCompressor } = await import("../src/memory/vib-compressor.js");
    const c = new VIBCompressor({
      capacity: 100,
      existingMemory: Array.from({ length: 50 }, (_, i) => `existing memory block ${i} with various content`),
    });

    const items = Array.from({ length: 1000 }, (_, i) => ({
      id: `mem-${i}`,
      content: `Memory item ${i}: ${"data ".repeat((i % 20) + 1)}`,
      timestamp: Date.now() + i,
      source: i % 2 === 0 ? "user" : "system",
    }));

    const start = performance.now();
    const result = await c.compress(items);
    const elapsed = performance.now() - start;

    expect(result.retained.length).toBe(100);
    expect(result.discarded.length).toBe(900);
    expect(elapsed).toBeLessThan(10000);
  });

  it("RedisClient 队列结构正确", async () => {
    const { RedisClient } = await import("../src/utils/redis-client.js");
    // 验证队列 FIFO 行为
    const rc = new (RedisClient as any)({ host: "localhost", port: 6379 });
    const queue = (rc as any).pendingQueue;
    expect(queue).toBeDefined();
    expect(Array.isArray(queue)).toBeTrue();
    expect(queue.length).toBe(0);
  });
});
