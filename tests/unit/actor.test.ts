import { describe, test, expect } from "bun:test";
import { ActorSystem, type ActorBehavior, type ActorMessage, type ActorContext } from "../../src/dre/actor/system";

describe("actor receive 顺序 (H-M2-03)", () => {
  test("receive should return Promise and await handler completion", async () => {
    const system = new ActorSystem();
    let handled = false;

    class TestBehavior implements ActorBehavior {
      id = "test-await";
      type = "test";
      async handle(message: ActorMessage, context: ActorContext): Promise<ActorMessage | null> {
        await new Promise((r) => setTimeout(r, 20));
        handled = true;
        return null;
      }
    }

    await system.register(new TestBehavior());
    const actor: any = (system as any).actors.get("test-await");
    expect(actor).toBeDefined();

    const msg: ActorMessage = {
      id: "m1",
      type: "request",
      from: "tester",
      to: "test-await",
      topic: "x",
      payload: {},
      timestamp: Date.now(),
    };

    const result: any = actor.receive(msg);
    // 修复前 receive 返回 void，修复后返回 Promise<void>
    expect(result instanceof Promise).toBe(true);
    await result;
    expect(handled).toBe(true);

    await system.shutdown();
  });

  test("actor messages processed in order even with varying delays", async () => {
    const system = new ActorSystem();
    const order: number[] = [];

    class OrderBehavior implements ActorBehavior {
      id = "order";
      type = "test";
      async handle(message: ActorMessage, context: ActorContext): Promise<ActorMessage | null> {
        const n = message.payload as number;
        const delay = n === 1 ? 30 : n === 2 ? 10 : 5;
        await new Promise((r) => setTimeout(r, delay));
        order.push(n);
        return null;
      }
    }

    await system.register(new OrderBehavior());

    system.deliver({ id: "1", type: "request", from: "a", to: "order", topic: "x", payload: 1, timestamp: Date.now() });
    system.deliver({ id: "2", type: "request", from: "a", to: "order", topic: "x", payload: 2, timestamp: Date.now() });
    system.deliver({ id: "3", type: "request", from: "a", to: "order", topic: "x", payload: 3, timestamp: Date.now() });

    await new Promise((r) => setTimeout(r, 250));
    expect(order).toEqual([1, 2, 3]);

    await system.shutdown();
  });

  test("concurrent receives should remain serial (no double processing)", async () => {
    const system = new ActorSystem();
    let concurrent = 0;
    let maxConcurrent = 0;
    const seen: number[] = [];

    class SerialBehavior implements ActorBehavior {
      id = "serial";
      type = "test";
      async handle(message: ActorMessage, context: ActorContext): Promise<ActorMessage | null> {
        concurrent++;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        await new Promise((r) => setTimeout(r, 15));
        seen.push(message.payload as number);
        concurrent--;
        return null;
      }
    }

    await system.register(new SerialBehavior());

    // 快速连续发送 5 条
    for (let i = 1; i <= 5; i++) {
      system.deliver({ id: `${i}`, type: "request", from: "a", to: "serial", topic: "x", payload: i, timestamp: Date.now() });
    }

    await new Promise((r) => setTimeout(r, 300));
    expect(maxConcurrent).toBe(1);
    expect(seen).toEqual([1, 2, 3, 4, 5]);

    await system.shutdown();
  });

  test("processNext should await next message (no fire-and-forget)", async () => {
    const system = new ActorSystem();
    const log: string[] = [];

    class ChainedBehavior implements ActorBehavior {
      id = "chained";
      type = "test";
      async handle(message: ActorMessage, context: ActorContext): Promise<ActorMessage | null> {
        log.push(`start-${message.payload}`);
        await new Promise((r) => setTimeout(r, 10));
        log.push(`end-${message.payload}`);
        return null;
      }
    }

    await system.register(new ChainedBehavior());
    const actor: any = (system as any).actors.get("chained");

    // 通过 receive 直接测试串行性：await 第一消息完成后再发第二消息，日志应为 start-1,end-1,start-2,end-2
    // 若 processNext 未 await，可能出现交错
    const p1 = actor.receive({ id: "1", type: "request", from: "a", to: "chained", topic: "x", payload: 1, timestamp: Date.now() });
    // 稍微延迟再发第二消息，模拟并发
    await new Promise((r) => setTimeout(r, 2));
    const p2 = actor.receive({ id: "2", type: "request", from: "a", to: "chained", topic: "x", payload: 2, timestamp: Date.now() });

    // 等待两者都完成（若 receive 返回 Promise，则可 await）
    if (p1 instanceof Promise) await p1;
    if (p2 instanceof Promise) await p2;
    await new Promise((r) => setTimeout(r, 100));

    // 期望严格串行：1 完整完成后再处理 2
    expect(log).toEqual(["start-1", "end-1", "start-2", "end-2"]);

    await system.shutdown();
  });
});
