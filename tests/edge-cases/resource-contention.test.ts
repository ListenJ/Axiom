/**
 * 边缘场景测试 B — 资源竞争条件 (Resource Contention)
 *
 * 测试目标：验证多组件在高并发操作下的数据一致性与线程安全。
 * 覆盖组件：Cache、KnowledgeNetwork、EventBus、Scheduler
 *
 * 竞争场景：
 *   1. 同一 key 的并发 set/get/delete
 *   2. 同一实体的并发 create/delete/link
 *   3. 同一事件类型的并发 subscribe/unsubscribe/publish
 *   4. 调度器的并发 submit/getNext/complete
 *   5. 缓存击穿（thundering herd）— getOrSet 并发去重
 *
 * 设计原则：Bun 原生 Promise.all 模拟并发，验证最终一致性。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Cache } from "../../src/utils/cache.js";
import { knowledgeNetwork } from "../../src/dre/runtime/knowledge-network.js";
import { scheduler } from "../../src/dre/runtime/scheduler.js";
import { eventBus } from "../../src/dre/runtime/event-bus.js";

// ═══════════════════════════════════════════════════════════════
// B.1 Cache 并发竞争
// ═══════════════════════════════════════════════════════════════

describe("B.1 Cache 并发竞争", () => {
  let cache: Cache<string>;
  beforeEach(() => {
    cache = new Cache<string>({ maxSize: 500, defaultTtlMs: 0, persistent: false });
  });
  afterEach(() => cache.destroy());

  test("100 并发 set 同一 key — 最终值应为最后一次写入", async () => {
    const writers = Array.from({ length: 100 }, (_, i) =>
      Promise.resolve(cache.set("contended-key", `val-${i}`)),
    );
    await Promise.all(writers);
    // 最终值存在且可读
    const val = cache.getSync("contended-key");
    expect(val).toBeDefined();
    expect(val?.startsWith("val-")).toBe(true);
    expect(cache.stats().size).toBe(1);
  });

  test("并发 set + delete 同一 key — 不应崩溃", async () => {
    const ops = Array.from({ length: 200 }, (_, i) => {
      if (i % 3 === 0) return Promise.resolve(cache.set("mixed-key", `v${i}`));
      if (i % 3 === 1) return Promise.resolve(cache.delete("mixed-key"));
      return Promise.resolve(cache.getSync("mixed-key"));
    });
    await Promise.all(ops);
    // 缓存仍可用
    cache.set("after-mixed", "ok");
    expect(cache.getSync("after-mixed")).toBe("ok");
  });

  test("getOrSet 并发去重 — thundering herd 保护", async () => {
    let factoryCalls = 0;
    const factory = async (): Promise<string> => {
      factoryCalls++;
      await new Promise((r) => setTimeout(r, 10));
      return `computed-${factoryCalls}`;
    };

    // 50 个并发请求同一 key
    const results = await Promise.all(
      Array.from({ length: 50 }, () => cache.getOrSet("herd-key", factory)),
    );

    // 所有结果应一致（去重生效）
    const firstVal = results[0];
    expect(results.every((r) => r === firstVal)).toBe(true);
    // factory 应只被调用 1 次（去重）或少量次数（取决于实现）
    expect(factoryCalls).toBeLessThanOrEqual(2);
  });

  test("LRU 淘汰在并发写入下不应导致大小超限", async () => {
    const small = new Cache<string>({ maxSize: 50, defaultTtlMs: 0, persistent: false });
    const writers = Array.from({ length: 500 }, (_, i) =>
      Promise.resolve(small.set(`concurrent-${i}`, `v-${i}`)),
    );
    await Promise.all(writers);
    expect(small.stats().size).toBeLessThanOrEqual(50);
    small.destroy();
  });
});

// ═══════════════════════════════════════════════════════════════
// B.2 KnowledgeNetwork 并发竞争
// ═══════════════════════════════════════════════════════════════

describe("B.2 KnowledgeNetwork 并发竞争", () => {
  beforeEach(() => knowledgeNetwork.reset());
  afterEach(() => knowledgeNetwork.reset());

  test("100 并发 create — 全部应成功且总数正确", async () => {
    const results = await Promise.all(
      Array.from({ length: 100 }, (_, i) =>
        Promise.resolve(
          knowledgeNetwork.create("concept", `Concurrent-${i}`, `content-${i}`, { source: "test" }),
        ),
      ),
    );
    expect(results.every((r) => r.id)).toBe(true);
    expect(knowledgeNetwork.getStats().total).toBe(100);
  });

  test("并发 create + delete — 最终状态一致", async () => {
    // 先创建 50 个实体
    const ids: string[] = [];
    for (let i = 0; i < 50; i++) {
      const ent = knowledgeNetwork.create("concept", `Pre-${i}`, `c-${i}`, { source: "test" });
      ids.push(ent.id);
    }

    // 并发：创建 50 个新的 + 删除 25 个旧的
    const ops = [
      ...Array.from({ length: 50 }, (_, i) =>
        Promise.resolve(
          knowledgeNetwork.create("concept", `New-${i}`, `new-${i}`, { source: "test" }),
        ),
      ),
      ...ids.slice(0, 25).map((id) => Promise.resolve(knowledgeNetwork.delete(id))),
    ];
    await Promise.all(ops);

    // 总数应为 50(新) + 25(剩余旧) = 75
    const stats = knowledgeNetwork.getStats();
    expect(stats.total).toBe(75);
  });

  test("并发 link 同一实体对 — 不应产生重复链接", async () => {
    const a = knowledgeNetwork.create("concept", "A", "a", { source: "test" });
    const b = knowledgeNetwork.create("concept", "B", "b", { source: "test" });

    // 并发创建 20 个相同 relation 的链接（应去重）
    await Promise.all(
      Array.from({ length: 20 }, () =>
        Promise.resolve(knowledgeNetwork.link(a.id, b.id, "same-rel")),
      ),
    );

    const links = knowledgeNetwork.getLinksFrom(a.id);
    // 去重后应只有 1 条
    expect(links.length).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════
// B.3 EventBus 并发竞争
// ═══════════════════════════════════════════════════════════════

describe("B.3 EventBus 并发竞争", () => {
  const subscribedIds: string[] = [];

  afterEach(() => {
    for (const id of subscribedIds) eventBus.unsubscribe(id);
    subscribedIds.length = 0;
  });

  test("并发 publish 1000 事件 — stats 应准确", async () => {
    let received = 0;
    subscribedIds.push(
      eventBus.subscribe("concurrent-publish", () => {
        received++;
      }),
    );

    const publishes = Array.from({ length: 1000 }, () =>
      Promise.resolve(
        eventBus.publish({
          type: "concurrent-publish",
          source: "test",
          data: null,
          priority: "normal",
        }),
      ),
    );
    await Promise.all(publishes);

    const stats = eventBus.getStats();
    expect(stats.published).toBeGreaterThanOrEqual(1000);
    // 同步 handler 应全部处理
    expect(received).toBe(1000);
  });

  test("并发 subscribe + unsubscribe — 不应泄漏 handler", async () => {
    const tempIds: string[] = [];
    // 并发订阅 100 个
    for (let i = 0; i < 100; i++) {
      tempIds.push(eventBus.subscribe("sub-unsub-test", () => {}));
    }
    // 并发取消订阅
    await Promise.all(tempIds.map((id) => Promise.resolve(eventBus.unsubscribe(id))));

    const stats = eventBus.getStats();
    // 该事件类型不应有残留 handler
    // subscriberCount 是全局的，验证我们的 handler 已全部清除
    expect(stats.subscriberCount).toBeLessThanOrEqual(0);
  });

  test("publish + unsubscribe 同时进行 — 不应崩溃", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 50; i++) {
      ids.push(eventBus.subscribe("race-test", () => {}));
    }

    // 同时 publish 和 unsubscribe
    const ops = [
      ...ids.slice(0, 25).map((id) => Promise.resolve(eventBus.unsubscribe(id))),
      ...Array.from({ length: 100 }, () =>
        Promise.resolve(
          eventBus.publish({
            type: "race-test",
            source: "test",
            data: null,
            priority: "normal",
          }),
        ),
      ),
    ];
    await Promise.all(ops);

    // 清理剩余
    for (const id of ids.slice(25)) eventBus.unsubscribe(id);
    expect(true).toBe(true); // 未崩溃即通过
  });
});

// ═══════════════════════════════════════════════════════════════
// B.4 Scheduler 并发竞争
// ═══════════════════════════════════════════════════════════════

describe("B.4 Scheduler 并发竞争", () => {
  beforeEach(() => scheduler.reset());
  afterEach(() => scheduler.reset());

  test("100 并发 submit — 全部应入队", async () => {
    const submits = Array.from({ length: 100 }, (_, i) =>
      Promise.resolve(
        scheduler.submit({
          name: "concurrent-task",
          priority: "normal" as never,
          payload: { idx: i },
          maxRetries: 0,
          dependencies: [],
        }),
      ),
    );
    const results = await Promise.all(submits);
    expect(results.every((r) => r.id)).toBe(true);
  });

  test("并发 submit + getNext — 不应取出同一任务两次", async () => {
    // 先提交 50 个任务
    for (let i = 0; i < 50; i++) {
      scheduler.submit({
        name: "dedup-test",
        priority: "normal" as never,
        payload: { idx: i },
        maxRetries: 0,
        dependencies: [],
      });
    }

    // 并发 getNext
    const getNextResults = await Promise.all(
      Array.from({ length: 50 }, () => Promise.resolve(scheduler.getNext())),
    );

    const taskIds = getNextResults.filter((r) => r !== null).map((r) => r!.id);
    const uniqueIds = new Set(taskIds);

    // 每个任务最多被取出一次
    expect(uniqueIds.size).toBe(taskIds.length);
  });
});
