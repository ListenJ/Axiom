/**
 * 编排闭环回归测试（审计 H1 — Agent 能力强化）
 *
 * 行为规格：
 * 1. ask() 必须能拿到目标 Actor 的响应（replyTo 配对），即使发送方不是注册 Actor。
 * 2. 不支持的主题必须返回结构化 error 响应（NACK），而非静默返回 null。
 * 3. ask() 超时必须抛错（可被 kernel 映射为任务失败）。
 * 4. scheduler.fail() 的重试回退与最终失败路径可达（task.retrying / task.failed 事件）。
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { ActorSystem, type ActorBehavior, type ActorMessage } from "../../src/dre/actor/system.js";
import { scheduler } from "../../src/dre/runtime/scheduler.js";
import { eventBus } from "../../src/dre/runtime/event-bus.js";

function echoBehavior(id: string): ActorBehavior {
  return {
    id,
    type: id,
    async handle(message: ActorMessage): Promise<ActorMessage | null> {
      if (message.topic === "ping") {
        return {
          id: `resp-${message.id}`,
          type: "response",
          from: id,
          to: message.from,
          topic: "pong",
          payload: { echoed: message.payload },
          timestamp: Date.now(),
          replyTo: message.id,
        };
      }
      // 其余主题交给系统默认 NACK（由实现保证）；此处显式 sleep 模拟慢处理用于超时用例
      if (message.topic === "slow") {
        await new Promise((r) => setTimeout(r, 300));
        return null;
      }
      return null;
    },
  };
}

describe("ActorSystem ask/NACK 闭环（H1 回归）", () => {
  let system: ActorSystem;

  beforeEach(async () => {
    system = new ActorSystem();
    await system.register(echoBehavior("worker"));
    scheduler.reset();
  });

  afterEach(async () => {
    await system.shutdown(1000);
  });

  test("ask 收到注册 Actor 的响应（发送方无需注册）", async () => {
    const reply = await system.ask("caller", "worker", "request", "ping", { n: 42 }, 1000);
    expect(reply.type).toBe("response");
    expect(reply.topic).toBe("pong");
    expect(reply.payload).toEqual({ echoed: { n: 42 } });
  });

  test("不支持的主题返回结构化 NACK（不再静默丢失）", async () => {
    const reply = await system.ask("caller", "worker", "request", "totally-unknown-topic", {}, 1000);
    expect(reply.type).toBe("error");
    const err = (reply.payload as { error?: string }).error ?? "";
    expect(err).toContain("Unsupported topic");
    expect(err).toContain("totally-unknown-topic");
  });

  test("超时抛错（供上层判定失败）", async () => {
    await expect(
      system.ask("caller", "worker", "request", "slow", {}, 50),
    ).rejects.toThrow(/timeout/i);
  });

  test("send() 旧接口保持 fire-and-forget 兼容（不因新增 ask 破坏）", async () => {
    await expect(system.send("caller", "worker", "request", "ping", { ok: 1 })).resolves.toBeUndefined();
  });
});

describe("scheduler 失败→重试/终态 可达性（H1 回归）", () => {
  beforeEach(() => scheduler.reset());

  test("fail 在重试预算内回到 pending 且设置退避；超出后终态 failed 并发布事件", () => {
    const events: string[] = [];
    const subIds = ["task.retrying", "task.failed"].map((t) =>
      eventBus.subscribe(t, (event) => {
        events.push(event.type);
      }),
    );

    const task = scheduler.submit({
      name: "h1-probe",
      priority: "normal",
      payload: {},
      maxRetries: 1,
      dependencies: [],
    });

    const picked = scheduler.getNext();
    expect(picked?.id).toBe(task.id);

    // 第一次失败 → 应重试（pending + notBefore）
    scheduler.fail(task.id, "boom-1");
    let t = scheduler.getTask(task.id)!;
    expect(t.status).toBe("pending");
    expect(t.retries).toBe(1);
    expect(t.notBefore).toBeGreaterThan(Date.now() - 1);

    // 未到退避时间不可再取
    expect(scheduler.getNext()).toBeNull();

    // 手动越过退避后再取（模拟时间流逝）
    t.notBefore = Date.now() - 1;
    const repicked = scheduler.getNext();
    expect(repicked?.id).toBe(task.id);

    // 第二次失败 → 超出 maxRetries=1 → 终态 failed
    scheduler.fail(task.id, "boom-2");
    t = scheduler.getTask(task.id)!;
    expect(t.status).toBe("failed");
    expect(t.error).toBe("boom-2");

    expect(events).toContain("task.retrying");
    expect(events).toContain("task.failed");
    for (const id of subIds) eventBus.unsubscribe(id);
  });

  test("complete 正常闭环（既有行为防回归）", () => {
    const task = scheduler.submit({ name: "ok", priority: "high", payload: {}, maxRetries: 0, dependencies: [] });
    scheduler.getNext();
    scheduler.complete(task.id, { done: true });
    expect(scheduler.getTask(task.id)?.status).toBe("completed");
  });
});
