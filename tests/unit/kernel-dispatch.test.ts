/**
 * 审计 B-1 / 整改 R2 Task 2.8 —— kernel 编排死路修复回归测试
 *
 * 修复前：kernel 以 topic="execute" 派发调度任务，但全部 4 个预注册 Actor
 * 均不处理 "execute" → 结构化 NACK → scheduler.fail 指数退避重试至耗尽，
 * 每个任务最终 status=failed（编排层功能死路）。
 *
 * 修复后契约：
 *   1. KnowledgeActorBehavior 处理 "execute"，返回结构化 response（默认执行者）
 *   2. unsupportedTopicNack 的 payload 带 code="UNSUPPORTED_TOPIC"
 *   3. scheduler.fail 支持 { terminal: true }：终态失败，不重试不回队
 */
import { describe, test, expect } from "bun:test";
import {
  KnowledgeActorBehavior,
  unsupportedTopicNack,
  type ActorMessage,
} from "../../src/dre/actor/system.js";
import { scheduler } from "../../src/dre/runtime/scheduler.js";

function makeMsg(topic: string, payload: unknown = {}): ActorMessage {
  return {
    id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    type: "request",
    from: "kernel",
    to: "knowledge",
    topic,
    payload,
    timestamp: Date.now(),
  };
}

describe("KnowledgeActor execute 兜底（B-1a）", () => {
  test("topic=execute 返回结构化 response 而非 null", async () => {
    const behavior = new KnowledgeActorBehavior();
    const reply = await behavior.handle(
      makeMsg("execute", { id: "task-1", name: "demo", priority: "normal", payload: { q: "x" } }),
      {} as any,
    );
    expect(reply).not.toBeNull();
    expect(reply!.type).toBe("response");
    const payload = reply!.payload as Record<string, unknown>;
    expect(payload.taskId).toBe("task-1");
    expect(payload.handledBy).toBe("knowledge");
  });

  test("query/validate 原有语义保持不变", async () => {
    const behavior = new KnowledgeActorBehavior();
    const q = await behavior.handle(makeMsg("query"), {} as any);
    expect(q!.type).toBe("response");
    const v = await behavior.handle(makeMsg("validate"), {} as any);
    expect(v!.type).toBe("response");
  });
});

describe("NACK 结构化标记（B-1b）", () => {
  test("unsupportedTopicNack payload.code === UNSUPPORTED_TOPIC", () => {
    const nack = unsupportedTopicNack("knowledge", makeMsg("no-such-topic"));
    expect(nack.type).toBe("error");
    expect((nack.payload as Record<string, unknown>).code).toBe("UNSUPPORTED_TOPIC");
  });
});

describe("scheduler.fail 终态模式（B-1c）", () => {
  test("terminal=true 立即 failed，不回队重试", () => {
    const id = `b1c-${Date.now()}`;
    const task = scheduler.submit({
      name: id,
      priority: "normal",
      payload: {},
      maxRetries: 5,
      dependencies: [],
    });
    expect(task.status).toBe("pending");

    // 真实生命周期：任务需经 getNext() 派发进入 running 后才可 fail
    let dispatched = scheduler.getNext();
    let guard = 0;
    while (dispatched && dispatched.id !== task.id && guard++ < 10) {
      // 让位其他测试遗留的队列任务，避免单例状态互相污染
      scheduler.complete(dispatched.id, null);
      dispatched = scheduler.getNext();
    }
    expect(dispatched?.id).toBe(task.id);

    scheduler.fail(task.id, "Unsupported topic \"execute\"", { terminal: true });

    expect(task.status).toBe("failed");
    expect(task.error).toContain("Unsupported topic");
    expect(task.completedAt).toBeDefined();
    // 终态失败不应重新入队
    expect(scheduler.getNext()?.id).not.toBe(task.id);
  });
});
