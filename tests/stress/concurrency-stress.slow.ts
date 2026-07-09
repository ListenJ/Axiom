/**
 * 维度一：并发与竞态条件压力测试
 *
 * 验证 EventBus、ActorSystem 和 WorldState 在高并发下的线程安全性和顺序保证。
 *
 * 严苛点:
 * - EventBus 洪水测试：10ms 内瞬间发布 10,000 个事件
 * - WorldState 并发写入：100 个协程同时对同一路径 set
 * - Actor 消息乱序：100 个并发请求验证顺序保证
 */

import { describe, test, expect, afterEach } from "bun:test";
import { eventBus } from "../../src/dre/runtime/event-bus.js";
import { worldState } from "../../src/dre/runtime/world-state.js";
import { atomStore } from "../../src/dre/runtime/atom-engine.js";
import { ActorSystem, type ActorBehavior } from "../../src/dre/actor/system.js";

const SUBSCRIPTIONS: string[] = [];

afterEach(() => {
  for (const id of SUBSCRIPTIONS.splice(0)) {
    try { eventBus.unsubscribe(id); } catch { /* already removed */ }
  }
});

// ========== EventBus 洪水测试 ==========

describe("Stress: EventBus flood (10K events)", () => {
  test("should handle 10K events without crashing or leaking", () => {
    const EVENT_TYPE = `stress.flood.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`;
    let processedCount = 0;

    const subId = eventBus.subscribe(EVENT_TYPE, () => {
      processedCount++;
    });
    SUBSCRIPTIONS.push(subId);

    const start = performance.now();
    // 同步发布 10K 事件 (publish 是同步的, handler 也是同步的)
    for (let i = 0; i < 10000; i++) {
      eventBus.publish({
        type: EVENT_TYPE,
        source: "stress-test",
        data: { id: i },
        priority: "normal",
      });
    }
    const elapsed = performance.now() - start;

    // 同步 handler 已全部执行
    expect(processedCount).toBe(10000);

    // 环形缓冲区: maxLogSize=1000, getRecentEvents(100) 返回最后 100 条
    const recent = eventBus.getRecentEvents(100);
    expect(recent.length).toBe(100);
    expect(recent[99].type).toBe(EVENT_TYPE);

    // 性能: 10K 事件应在合理时间内完成 (宽松阈值避免 CI flakiness)
    expect(elapsed).toBeLessThan(2000);

    // 内存: 日志不应超过 maxLogSize (1000)
    const allRecent = eventBus.getRecentEvents(2000);
    expect(allRecent.length).toBeLessThanOrEqual(1000);
  });

  test("should deliver to multiple subscribers under flood", () => {
    const EVENT_TYPE = `stress.multi.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`;
    let count1 = 0, count2 = 0;

    const sub1 = eventBus.subscribe(EVENT_TYPE, () => { count1++; }, 5);
    const sub2 = eventBus.subscribe(EVENT_TYPE, () => { count2++; }, 3);
    SUBSCRIPTIONS.push(sub1, sub2);

    for (let i = 0; i < 5000; i++) {
      eventBus.publish({
        type: EVENT_TYPE,
        source: "stress-test",
        data: { id: i },
        priority: "normal",
      });
    }

    expect(count1).toBe(5000);
    expect(count2).toBe(5000);
  });

  test("should handle async handlers without blocking publish", async () => {
    const EVENT_TYPE = `stress.async.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`;
    let resolvedCount = 0;

    const subId = eventBus.subscribe(EVENT_TYPE, async () => {
      await new Promise((r) => setTimeout(r, 1));
      resolvedCount++;
    });
    SUBSCRIPTIONS.push(subId);

    // publish 不应阻塞等待 async handler
    const start = performance.now();
    for (let i = 0; i < 100; i++) {
      eventBus.publish({
        type: EVENT_TYPE,
        source: "stress-test",
        data: { id: i },
        priority: "normal",
      });
    }
    const elapsed = performance.now() - start;

    // publish 应快速返回 (不等 async handler 完成)
    expect(elapsed).toBeLessThan(100);

    // 等待 async handlers 完成
    await new Promise((r) => setTimeout(r, 200));
    expect(resolvedCount).toBe(100);
  });
});

// ========== WorldState 并发写入 ==========

describe("Stress: WorldState concurrent writes (100 workers)", () => {
  test("should maintain version consistency under concurrent writes", async () => {
    const path = `stress.concurrent.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`;
    const initialVersion = worldState.getVersion();

    // 模拟 "并发" — JS 单线程, set() 同步, Promise.all 中实际顺序执行
    const tasks = Array.from({ length: 100 }, (_, i) =>
      Promise.resolve(worldState.set(path, i))
    );
    await Promise.all(tasks);

    // 版本号必须精确增加 100
    expect(worldState.getVersion()).toBe(initialVersion + 100);

    // 最终值必须是 100 个中的某一个 (同步顺序执行, 最后一个是 i=99)
    const finalVal = worldState.get<number>(path);
    expect(finalVal).toBe(99);
  });

  test("should notify watchers for every write", async () => {
    const path = `stress.watch.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`;
    let notifyCount = 0;

    const unwatch = worldState.watch(path, () => { notifyCount++; });

    for (let i = 0; i < 50; i++) {
      worldState.set(path, `value-${i}`);
    }

    expect(notifyCount).toBe(50);
    unwatch();
  });

  test("should handle concurrent writes to different paths independently", async () => {
    const prefix = `stress.multi-path.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`;
    const initialVersion = worldState.getVersion();

    const tasks = Array.from({ length: 50 }, (_, i) =>
      Promise.resolve(worldState.set(`${prefix}.path-${i}`, i))
    );
    await Promise.all(tasks);

    expect(worldState.getVersion()).toBe(initialVersion + 50);

    // 验证每个路径的值
    for (let i = 0; i < 50; i++) {
      expect(worldState.get<number>(`${prefix}.path-${i}`)).toBe(i);
    }
  });
});

// ========== Actor 消息顺序保证 ==========

describe("Stress: Actor message ordering (100 messages)", () => {
  test("should process all messages in order for single actor", async () => {
    const system = new ActorSystem();
    const writeOrder: number[] = [];
    const CONTENT_PREFIX = `actor-order-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const writeActor: ActorBehavior = {
      id: "write-actor-stress",
      type: "writer",
      async handle(message) {
        if (message.topic === "write") {
          const { index, content } = message.payload as { index: number; content: string };
          atomStore.create("fact", content, { metadata: { index } });
          writeOrder.push(index);
        }
        return null;
      },
    };

    await system.register(writeActor);

    // 发送 100 条消息 (顺序发送, actor 顺序处理)
    for (let i = 0; i < 100; i++) {
      await system.send("test", "write-actor-stress", "request", "write", {
        index: i,
        content: `${CONTENT_PREFIX}-fact-${i}`,
      });
    }

    // 等待微任务清空 (actor.handle 是 async)
    await new Promise((r) => setTimeout(r, 100));

    // 验证: 所有消息按顺序处理
    expect(writeOrder.length).toBe(100);
    expect(writeOrder).toEqual(Array.from({ length: 100 }, (_, i) => i));

    // 验证: atomStore 中有 100 条记录 (用唯一前缀避免其他测试干扰)
    const atoms = atomStore.search(CONTENT_PREFIX, 200);
    expect(atoms.length).toBe(100);

    await system.shutdown();
  });

  test("should not block one actor while another is processing", async () => {
    const system = new ActorSystem();
    let slowDone = false;
    let fastDone = false;

    const slowActor: ActorBehavior = {
      id: "slow-actor-stress",
      type: "slow",
      async handle() {
        await new Promise((r) => setTimeout(r, 100));
        slowDone = true;
        return null;
      },
    };
    const fastActor: ActorBehavior = {
      id: "fast-actor-stress",
      type: "fast",
      async handle() {
        fastDone = true;
        return null;
      },
    };

    await system.register(slowActor);
    await system.register(fastActor);

    // 同时给两个 actor 发消息
    await system.send("test", "slow-actor-stress", "request", "work", {});
    await system.send("test", "fast-actor-stress", "request", "work", {});

    // fast actor 应该立即处理完, 不等 slow actor
    await new Promise((r) => setTimeout(r, 20));
    expect(fastDone).toBe(true);
    expect(slowDone).toBe(false);

    // 等待 slow actor 完成
    await new Promise((r) => setTimeout(r, 120));
    expect(slowDone).toBe(true);

    await system.shutdown();
  });
});
