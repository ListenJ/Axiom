import { describe, test, expect } from "bun:test";
import { eventBus } from "../../src/dre/runtime/event-bus";
import { Kernel } from "../../src/dre/kernel";

describe("event-bus publish await 全量 handler (H-M2-03)", () => {
  test("await publish should wait for all async handlers", async () => {
    const type = `test.await.${Date.now()}.${Math.random().toString(36).slice(2, 6)}`;
    const order: number[] = [];
    eventBus.subscribe(type, async () => {
      await new Promise((r) => setTimeout(r, 20));
      order.push(1);
    });
    eventBus.subscribe(type, async () => {
      await new Promise((r) => setTimeout(r, 10));
      order.push(2);
    });
    // audit: publish 不 await 导致 handler 未完成就返回，current code 会使 order 为空
    await eventBus.publish({ type, source: "test", data: {}, priority: "normal" } as any);
    expect(order.length).toBe(2);
    expect(order).toContain(1);
    expect(order).toContain(2);
  });

  test("handler error should not block other handlers (allSettled)", async () => {
    const type = `test.error.${Date.now()}.${Math.random().toString(36).slice(2, 6)}`;
    let secondRan = false;
    eventBus.subscribe(type, async () => {
      throw new Error("handler fail");
    });
    eventBus.subscribe(type, async () => {
      await new Promise((r) => setTimeout(r, 5));
      secondRan = true;
    });
    await eventBus.publish({ type, source: "test", data: {}, priority: "normal" } as any);
    expect(secondRan).toBe(true);
  });

  test("once handler should be awaited and removed after publish", async () => {
    const type = `test.once.${Date.now()}.${Math.random().toString(36).slice(2, 6)}`;
    let count = 0;
    eventBus.subscribeOnce(type, async () => {
      await new Promise((r) => setTimeout(r, 10));
      count++;
    });
    await eventBus.publish({ type, source: "test", data: {}, priority: "normal" } as any);
    expect(count).toBe(1);
    expect(eventBus.getHandlerCount(type)).toBe(0);
    await eventBus.publish({ type, source: "test", data: {}, priority: "normal" } as any);
    expect(count).toBe(1);
  });

  test("publish should return event and be awaitable (Promise)", async () => {
    const type = `test.promise.${Date.now()}.${Math.random().toString(36).slice(2, 6)}`;
    eventBus.subscribe(type, async () => {
      await new Promise((r) => setTimeout(r, 5));
    });
    const result: any = eventBus.publish({ type, source: "test", data: { x: 1 }, priority: "normal" } as any);
    // 修复后 publish 返回 Promise，修复前返回 RuntimeEvent 同步对象
    expect(result instanceof Promise).toBe(true);
    const evt = await result;
    expect(evt.type).toBe(type);
    expect(evt.source).toBe("test");
  });
});

describe("kernel tick 串行 (C-M2-01/02)", () => {
  test("kernel tick 串行：重入不双算 currentTasks / 不重叠", async () => {
    // 使用 Kernel 的真实循环，mock tick 为慢任务，验证无重叠
    const kernel: any = new Kernel({
      dbPath: ":memory:",
      mainLLM: { model: "test", baseUrl: "http://test", apiKey: "test" },
      tickInterval: 10,
      autoTick: false,
    } as any);

    let concurrent = 0;
    let maxConcurrent = 0;
    let tickCount = 0;

    // 替换 tick 为慢异步，避免依赖 scheduler/engine 真实逻辑
    kernel.tick = async () => {
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      tickCount++;
      await new Promise((r) => setTimeout(r, 30));
      concurrent--;
    };

    kernel.startTickLoop();
    // 运行 150ms：interval 10 + tick 30 = 每周期 40ms，预期 ~3 次串行
    await new Promise((r) => setTimeout(r, 150));
    kernel.stopTickLoop();
    await new Promise((r) => setTimeout(r, 60));

    expect(maxConcurrent).toBe(1);
    expect(tickCount).toBeGreaterThanOrEqual(2);
    expect(tickCount).toBeLessThan(6); // 串行应 ~3 次，若并发则会 8+ 次

    try {
      await kernel.shutdown();
    } catch {}
  });

  test("kernel stopTickLoop should halt ticks", async () => {
    const kernel: any = new Kernel({
      dbPath: ":memory:",
      mainLLM: { model: "test", baseUrl: "http://test", apiKey: "test" },
      tickInterval: 10,
      autoTick: false,
    } as any);
    let count = 0;
    kernel.tick = async () => {
      count++;
      await new Promise((r) => setTimeout(r, 5));
    };
    kernel.startTickLoop();
    await new Promise((r) => setTimeout(r, 50));
    kernel.stopTickLoop();
    const afterStop = count;
    await new Promise((r) => setTimeout(r, 50));
    // 停止后不应再增长（允许一次 in-flight 完成）
    expect(count - afterStop).toBeLessThanOrEqual(1);
    try {
      await kernel.shutdown();
    } catch {}
  });
});
