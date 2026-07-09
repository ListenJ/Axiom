/**
 * 维度五：确定性与回放测试
 *
 * 验证 Axiom Runtime 的核心承诺——确定性。
 *
 * 严苛点:
 * - Runtime 仿真: 相同输入产生相同事件序列 (除时间戳/ID 外)
 * - ConstraintSolver 确定性: 相同输入 100 次调用结果完全一致
 *
 * 注意: EventBus 和 WorldState 是全局单例, 无法完全隔离。
 * 本测试通过订阅具体事件类型 + 比较事件序列 (排除 timestamp/id) 验证确定性。
 */

import { describe, test, expect, afterEach } from "bun:test";
import { eventBus, type RuntimeEvent } from "../../src/dre/runtime/event-bus.js";
import {
  ConstraintSolver,
  RESOURCE_CONSTRAINTS,
  POLICY_CONSTRAINTS,
} from "../../src/dre/constraint/solver.js";
import { ReasoningRuntime } from "../../src/dre/runtime/reasoner/reasoning-runtime.js";

const SUBSCRIPTIONS: string[] = [];

afterEach(() => {
  for (const id of SUBSCRIPTIONS.splice(0)) {
    try { eventBus.unsubscribe(id); } catch { /* already removed */ }
  }
});

// ========== ReasoningRuntime 回放一致性 ==========

describe("Determinism: ReasoningRuntime replay", () => {
  test("same input should produce same event type sequence", async () => {
    const input = "deterministic replay test input";

    // 收集事件的辅助函数
    const collectEvents = (): { events: Array<{ type: string }>; subIds: string[] } => {
      const events: Array<{ type: string }> = [];
      const subIds: string[] = [];

      // 订阅 pipeline 相关事件类型 (精确匹配, 无通配符)
      const eventTypes = [
        "pipeline.completed",
        "pipeline.llm_needed",
        "pipeline.constraint_violation",
        "atom.created",
        "state.changed",
      ];

      for (const type of eventTypes) {
        const id = eventBus.subscribe(type, (e: RuntimeEvent) => {
          events.push({ type: e.type });
        });
        subIds.push(id);
      }

      return { events, subIds };
    };

    // Run 1
    const runtime1 = new ReasoningRuntime();
    const collector1 = collectEvents();
    await runtime1.run(input);
    await new Promise((r) => setTimeout(r, 100)); // 等微任务清空
    collector1.subIds.forEach((id) => eventBus.unsubscribe(id));

    // Run 2 (相同输入, 新 runtime 实例)
    const runtime2 = new ReasoningRuntime();
    const collector2 = collectEvents();
    await runtime2.run(input);
    await new Promise((r) => setTimeout(r, 100));
    collector2.subIds.forEach((id) => eventBus.unsubscribe(id));

    // 断言: 两次运行产生相同数量的事件
    // 注意: state.changed 事件可能因单例 WorldState 累积而略有差异,
    // 但 pipeline.* 事件应一致
    const pipelineEvents1 = collector1.events.filter((e) => e.type.startsWith("pipeline."));
    const pipelineEvents2 = collector2.events.filter((e) => e.type.startsWith("pipeline."));

    // pipeline.completed 事件应至少各有一个
    expect(pipelineEvents1.some((e) => e.type === "pipeline.completed")).toBe(true);
    expect(pipelineEvents2.some((e) => e.type === "pipeline.completed")).toBe(true);

    // 事件类型序列应一致 (确定性)
    const types1 = pipelineEvents1.map((e) => e.type);
    const types2 = pipelineEvents2.map((e) => e.type);
    expect(types2).toEqual(types1);
  });

  test("same input should produce same needsLLM flag", async () => {
    const input = "deterministic needsLLM test";

    const runtime1 = new ReasoningRuntime();
    const ctx1 = await runtime1.run(input);
    const needsLLM1 = ctx1.needsLLM;

    const runtime2 = new ReasoningRuntime();
    const ctx2 = await runtime2.run(input);
    const needsLLM2 = ctx2.needsLLM;

    // 相同输入应产生相同 needsLLM 标志
    expect(needsLLM2).toBe(needsLLM1);
  });

  test("same input should produce same stats increment", async () => {
    const input = "deterministic stats test";

    const runtime1 = new ReasoningRuntime();
    const stats1Before = runtime1.getStats();
    await runtime1.run(input);
    const stats1After = runtime1.getStats();
    const runsDelta1 = stats1After.runs - stats1Before.runs;

    const runtime2 = new ReasoningRuntime();
    const stats2Before = runtime2.getStats();
    await runtime2.run(input);
    const stats2After = runtime2.getStats();
    const runsDelta2 = stats2After.runs - stats2Before.runs;

    // 两次都应增加 1 次 run
    expect(runsDelta1).toBe(1);
    expect(runsDelta2).toBe(1);
  });
});

// ========== ConstraintSolver 确定性 ==========

describe("Determinism: ConstraintSolver same input → same output", () => {
  test("100 calls with identical input produce identical results", () => {
    const solver = new ConstraintSolver();
    // 排除 temporal (因 new Date() 非幂等)
    solver.registerAll([...RESOURCE_CONSTRAINTS, ...POLICY_CONSTRAINTS]);

    const action = "deterministic-test-action";
    const ctx = {
      environment: "development",
      available_memory_mb: 2048,
      gpu_free_vram_mb: 1024,
    };

    const results = [];
    for (let i = 0; i < 100; i++) {
      results.push(solver.check(action, ctx));
    }

    // 所有结果必须一致
    const first = results[0];
    for (let i = 1; i < results.length; i++) {
      const r = results[i];
      expect(r.satisfied).toBe(first.satisfied);
      expect(r.violations.length).toBe(first.violations.length);
      expect(r.satisfiedConstraints).toEqual(first.satisfiedConstraints);
      expect(r.suggestions).toEqual(first.suggestions);

      // 逐个 violation 对比
      for (let j = 0; j < r.violations.length; j++) {
        expect(r.violations[j].constraintId).toBe(first.violations[j].constraintId);
        expect(r.violations[j].dimension).toBe(first.violations[j].dimension);
        expect(r.violations[j].reason).toBe(first.violations[j].reason);
        expect(r.violations[j].severity).toBe(first.violations[j].severity);
      }
    }
  });

  test("selectBest should be deterministic for same candidates", () => {
    const solver = new ConstraintSolver();
    solver.registerAll([...RESOURCE_CONSTRAINTS, ...POLICY_CONSTRAINTS]);

    const candidates = ["action-a", "action-b", "action-c"];
    const ctx = {
      environment: "development",
      available_memory_mb: 2048,
    };

    const first = solver.selectBest(candidates, ctx);

    for (let i = 0; i < 50; i++) {
      const result = solver.selectBest(candidates, ctx);
      expect(result.selected).toBe(first.selected);
      expect(result.results.length).toBe(first.results.length);
      // 每个候选的 check 结果应一致
      for (let j = 0; j < result.results.length; j++) {
        expect(result.results[j].action).toBe(first.results[j].action);
        expect(result.results[j].check.satisfied).toBe(first.results[j].check.satisfied);
      }
    }
  });
});

// ========== EventBus 确定性 ==========

describe("Determinism: EventBus event ordering", () => {
  test("same publish sequence produces same delivery order", () => {
    const EVENT_TYPE = `determinism.order.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`;

    const collectDelivery = () => {
      const received: number[] = [];
      const subId = eventBus.subscribe(EVENT_TYPE, (e) => {
        received.push((e.data as { id: number }).id);
      });
      return { received, subId };
    };

    // Run 1
    const c1 = collectDelivery();
    for (let i = 0; i < 100; i++) {
      eventBus.publish({
        type: EVENT_TYPE,
        source: "determinism-test",
        data: { id: i },
        priority: "normal",
      });
    }
    eventBus.unsubscribe(c1.subId);

    // Run 2 (相同发布序列)
    const c2 = collectDelivery();
    for (let i = 0; i < 100; i++) {
      eventBus.publish({
        type: EVENT_TYPE,
        source: "determinism-test",
        data: { id: i },
        priority: "normal",
      });
    }
    eventBus.unsubscribe(c2.subId);

    // 断言: 两次的投递顺序必须完全一致
    expect(c2.received).toEqual(c1.received);
    expect(c2.received).toEqual(Array.from({ length: 100 }, (_, i) => i));
  });

  test("priority ordering is deterministic", () => {
    const EVENT_TYPE = `determinism.priority.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`;

    const collectDelivery = () => {
      const received: string[] = [];
      const subId = eventBus.subscribe(EVENT_TYPE, (e) => {
        received.push((e.data as { tag: string }).tag);
      }, 0); // 默认优先级
      return { received, subId };
    };

    const c = collectDelivery();

    // 同一优先级, 按 publish 顺序投递
    const tags = ["a", "b", "c", "d", "e"];
    for (const tag of tags) {
      eventBus.publish({
        type: EVENT_TYPE,
        source: "determinism-test",
        data: { tag },
        priority: "normal",
      });
    }

    eventBus.unsubscribe(c.subId);

    // 投递顺序应与发布顺序一致 (同优先级 FIFO)
    expect(c.received).toEqual(tags);
  });
});
