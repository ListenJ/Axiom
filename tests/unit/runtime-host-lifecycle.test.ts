/**
 * Step 5 回归：RuntimeHost 生命周期状态机与并发串行化。
 *
 * 证据（OCR medium）：
 *   - src/runtime/host.ts:179 error 状态跳过 initialize 直接 start；
 *   - src/runtime/host.ts:135 重复注册运行中 Agent 覆盖记录、孤立旧适配器；
 *   - src/runtime/host.ts:168 lifecycle check-then-await 无串行化，并发双重初始化/停止；
 *   - src/runtime/host.ts:59 默认 scheduler running Set 只写不读、complete 丢 result；
 *   - src/runtime/types.ts:87 文档写“6 个方法”，实际 4 个必需 + 2 个可选。
 */
import { describe, test, expect } from "bun:test";
import { createRuntimeHost } from "../../src/runtime/host.js";
import type { AgentAdapter, RuntimeContext, RuntimeResult, RuntimeTask } from "../../src/runtime/types.js";

class TestAdapter implements AgentAdapter {
  readonly id = "test-agent";
  readonly name = "Test Agent";
  readonly version = "1.0.0";
  readonly capabilities = ["test"];

  initializeCalls = 0;
  startCalls = 0;
  stopCalls = 0;
  destroyCalls = 0;
  failInitialize = false;
  failStart = false;
  destroyCtx: RuntimeContext | undefined;

  async initialize(_ctx: RuntimeContext): Promise<void> {
    this.initializeCalls++;
    if (this.failInitialize) throw new Error("init failed");
  }

  async start(_ctx: RuntimeContext): Promise<void> {
    this.startCalls++;
    if (this.failStart) throw new Error("start failed");
  }

  async stop(_ctx: RuntimeContext): Promise<void> {
    this.stopCalls++;
  }

  async destroy(ctx?: RuntimeContext): Promise<void> {
    this.destroyCalls++;
    this.destroyCtx = ctx;
  }

  async handleTask(task: RuntimeTask, _ctx: RuntimeContext): Promise<RuntimeResult> {
    return { taskId: task.id, success: true, output: null, durationMs: 0 };
  }
}

describe("Step 5 — RuntimeHost 生命周期", () => {
  test("AC-1 initialize 失败后 state=error；再次 startAgent 拒绝且不调用 start", async () => {
    const host = createRuntimeHost();
    const a = new TestAdapter();
    a.failInitialize = true;
    host.registerAgent(a);

    await host.startAgent("test-agent");
    const health = await host.getHealthStatus();
    expect(health.agents["test-agent"].details?.state).toBe("error");

    await expect(host.startAgent("test-agent")).rejects.toThrow(/error state/i);
    expect(a.startCalls).toBe(0);
  });

  test("AC-2 运行中同 id 重复注册被拒绝，旧适配器不被孤立", async () => {
    const host = createRuntimeHost();
    const a = new TestAdapter();
    host.registerAgent(a);
    await host.startAgent("test-agent");

    const b = new TestAdapter();
    expect(() => host.registerAgent(b)).toThrow(/running|stop/i);

    const health = await host.getHealthStatus();
    expect(health.agents["test-agent"].details?.state).toBe("running");
    const result = await host.dispatchTask({ id: "t1", type: "test", input: null });
    expect(result.success).toBe(true);
  });

  test("AC-3 并发 startAgent 只初始化/启动一次；并发 stopAgent 只停止一次", async () => {
    const host = createRuntimeHost();
    const a = new TestAdapter();
    a.initialize = async () => { a.initializeCalls++; await new Promise((r) => setTimeout(r, 20)); };
    a.start = async () => { a.startCalls++; await new Promise((r) => setTimeout(r, 20)); };
    a.stop = async () => { a.stopCalls++; await new Promise((r) => setTimeout(r, 20)); };
    host.registerAgent(a);

    await Promise.all([host.startAgent("test-agent"), host.startAgent("test-agent")]);
    expect(a.initializeCalls).toBe(1);
    expect(a.startCalls).toBe(1);

    await Promise.all([host.stopAgent("test-agent"), host.stopAgent("test-agent")]);
    expect(a.stopCalls).toBe(1);
    expect(a.destroyCalls).toBe(1);
    expect(a.destroyCtx).toBeDefined();
  });

  // 轮 7 审计三梯队⑥（H3）：原 AC-4/AC-5 后半段 readFileSync 实现源码断言
  // （toContain 中文注释文本 / 正则匹配私有签名）已删除——断言私有实现文本
  // 而非公共行为：内部变量改名即误报、行为回归仍假绿，且依赖 cwd=仓库根。
  // AC-5 前半段的行为断言（双 complete 不抛、result 被接受）保留在下一用例。

  test("AC-5 默认 scheduler complete 接受 result（行为断言，双 complete 幂等）", () => {
    const host = createRuntimeHost();
    const sched = host.getContext().scheduler;
    const { id } = sched.submit({ name: "task", priority: "normal", payload: null, maxRetries: 0, dependencies: [] });
    const next = sched.getNext();
    expect(next?.id).toBe(id);
    expect(() => sched.complete(id, { ok: true })).not.toThrow();
    expect(() => sched.complete(id, { ok: true })).not.toThrow();
  });
});
