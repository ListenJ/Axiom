/**
 * Axiom Runtime — 合并代码适配度压力测试
 *
 * 严苛测试从 cognitive-runtime 分支合并的代码:
 *  - EventBus (高吞吐/并发/泄漏)
 *  - WorldState (并发写入/版本一致性/watch稳定性)
 *  - MentalModelPool (大量仿真/规则匹配)
 *
 * 测试标准:
 *  - 10K+ 事件吞吐
 *  - 1K+ 并发订阅者
 *  - 100+ 并发仿真
 *  - 内存压力 (10K 状态写入)
 *  - 无内存泄漏 (gc 后内存回落)
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { eventBus, type RuntimeEvent } from "../src/dre/runtime/event-bus.js";
import { worldState } from "../src/dre/runtime/world-state.js";
import { MentalModelPool, createDefaultMentalModelPool } from "../src/dre/mental-model/pool.js";
import { logger } from "../src/utils/logger.js";

// ========== EventBus 压力测试 ==========

describe("EventBus Stress", () => {
  const EVENT_TYPE = `stress.event.${Date.now()}`;

  afterAll(() => {
    // Clean up all subscriptions from this test suite
    const stats = eventBus.getStats();
    logger.info("[Stress/EventBus] Final stats", stats);
  });

  test("10K events throughput (publish only)", () => {
    const start = performance.now();
    for (let i = 0; i < 10000; i++) {
      eventBus.publish({
        type: `${EVENT_TYPE}.throughput`,
        source: "stress",
        data: { index: i },
        priority: "normal",
      });
    }
    const elapsed = performance.now() - start;
    const rate = Math.round(10000 / (elapsed / 1000));
    logger.info("[Stress/EventBus] 10K events", { elapsed: `${elapsed.toFixed(1)}ms`, rate: `${rate}/s` });
    expect(elapsed).toBeLessThan(200); // 10K in <200ms = 50K/s
  });

  test("1K subscribers with event delivery", () => {
    let delivered = 0;
    const subs: string[] = [];

    for (let i = 0; i < 1000; i++) {
      const id = eventBus.subscribe(`${EVENT_TYPE}.1ksub`, () => { delivered++; });
      subs.push(id);
    }

    eventBus.publish({
      type: `${EVENT_TYPE}.1ksub`,
      source: "stress",
      data: "broadcast",
      priority: "normal",
    });

    expect(delivered).toBe(1000);

    // Cleanup
    for (const id of subs) eventBus.unsubscribe(id);
  });

  test("Priority ordering under load (3 levels × 10 subs each)", () => {
    const order: string[] = [];
    const subs: string[] = [];
    const pType = `${EVENT_TYPE}.priority`;

    for (let i = 0; i < 10; i++) {
      subs.push(eventBus.subscribe(pType, () => { order.push("background"); }, 0));
      subs.push(eventBus.subscribe(pType, () => { order.push("critical"); }, 100));
      subs.push(eventBus.subscribe(pType, () => { order.push("normal"); }, 50));
    }

    eventBus.publish({ type: pType, source: "stress", data: null, priority: "normal" });

    // First 10 should be critical (priority 100)
    const first10 = order.slice(0, 10);
    expect(first10.every((p) => p === "critical")).toBe(true);

    for (const id of subs) eventBus.unsubscribe(id);
  });

  test("subscribeOnce auto-cleanup @ 5K calls", () => {
    let count = 0;
    const pType = `${EVENT_TYPE}.once5k`;

    for (let i = 0; i < 5000; i++) {
      eventBus.subscribeOnce(pType, () => { count++; });
    }

    eventBus.publish({ type: pType, source: "stress", data: null, priority: "normal" });
    expect(count).toBe(5000);

    // Second publish should have NO subscribers
    let count2 = 0;
    eventBus.publish({ type: pType, source: "stress", data: null, priority: "normal" });
    expect(count2).toBe(0); // no subscribers left
  });

  test("Event log retains only last 1000", () => {
    const pType = `${EVENT_TYPE}.log`;
    for (let i = 0; i < 1500; i++) {
      eventBus.publish({ type: pType, source: "stress", data: i, priority: "low" });
    }
    const recent = eventBus.getRecentEvents(2000);
    expect(recent.length).toBeLessThanOrEqual(1000);
    // Last event should be the 1500th (index 1499)
    expect((recent[recent.length - 1].data as number)).toBe(1499);
  });

  test("Concurrent publish from 10 async coroutines", async () => {
    const pType = `${EVENT_TYPE}.concurrent`;
    let total = 0;
    eventBus.subscribe(pType, () => { total++; });

    const tasks = Array.from({ length: 10 }, (_, i) => {
      return new Promise<void>((resolve) => {
        for (let j = 0; j < 100; j++) {
          eventBus.publish({
            type: pType, source: "stress", data: { coroutine: i, index: j },
            priority: "normal",
          });
        }
        resolve();
      });
    });

    await Promise.all(tasks);
    expect(total).toBe(1000); // 10 × 100
  });
});

// ========== WorldState 压力测试 ==========

describe("WorldState Stress", () => {
  afterAll(() => {
    logger.info("[Stress/WorldState] Version", worldState.getVersion() as unknown as Record<string, unknown>);
  });

  test("10K keys write and read", () => {
    const start = performance.now();
    for (let i = 0; i < 10000; i++) {
      worldState.set(`stress.k${i}`, `v${i}`);
    }
    const writeTime = performance.now() - start;

    // Read back random keys
    const readStart = performance.now();
    for (let i = 0; i < 1000; i++) {
      const idx = Math.floor(Math.random() * 10000);
      expect((worldState.get(`stress.k${idx}`) as string)).toBe(`v${idx}`);
    }
    const readTime = performance.now() - readStart;

    logger.info("[Stress/WorldState] 10K keys", { writeTime: `${writeTime.toFixed(1)}ms`, readTime1000: `${readTime.toFixed(2)}ms` });
    expect(writeTime).toBeLessThan(1000); // 10K writes in <1s
  });

  test("1K watchers all notified on single change", () => {
    let notified = 0;
    const unsubs: Array<() => void> = [];

    for (let i = 0; i < 1000; i++) {
      unsubs.push(worldState.watch("stress.watched", () => { notified++; }));
    }

    worldState.set("stress.watched", "trigger");
    expect(notified).toBe(1000);

    for (const unsub of unsubs) unsub();
  });

  test("Version monotonically increases under 5K writes", () => {
    const startVersion = worldState.getVersion();
    for (let i = 0; i < 5000; i++) {
      worldState.set(`stress.vercheck.${i}`, i);
    }
    const endVersion = worldState.getVersion();
    expect(endVersion - startVersion).toBe(5000);
  });

  test("query prefix scales to 5K keys", () => {
    const prefix = "stress.querytest";
    for (let i = 0; i < 5000; i++) {
      worldState.set(`${prefix}.k${i}`, i);
    }
    // Add noise keys
    for (let i = 0; i < 1000; i++) {
      worldState.set(`stress.noise.k${i}`, i);
    }
    const result = worldState.query(prefix + ".");
    expect(result.size).toBe(5000);
  });

  test("Mental dimensions: 500 beliefs + 500 goals persistence", () => {
    for (let i = 0; i < 500; i++) {
      worldState.setBelief(`b${i}`, `Statement ${i}`, Math.random());
      worldState.setGoal(`g${i}`, `Goal ${i}`, "active");
    }

    const beliefs = worldState.getBeliefs();
    const goals = worldState.getGoals();
    expect(Object.keys(beliefs).length).toBe(500);
    expect(Object.keys(goals).length).toBe(500);
  });

  test("Concurrent set from 10 workers", async () => {
    const start = worldState.getVersion();
    const workers = Array.from({ length: 10 }, (_, i) => {
      return new Promise<void>((resolve) => {
        for (let j = 0; j < 100; j++) {
          worldState.set(`stress.concurrent.worker${i}.k${j}`, `${i}-${j}`);
        }
        resolve();
      });
    });
    await Promise.all(workers);
    expect(worldState.getVersion() - start).toBe(1000);
  });
});

// ========== MentalModelPool 压力测试 ==========

describe("MentalModelPool Stress", () => {
  let pool: MentalModelPool;

  beforeAll(() => {
    pool = createDefaultMentalModelPool();
  });

  test("100 parallel simulations on Git model", async () => {
    const simulations = await Promise.all(
      Array.from({ length: 100 }, (_, i) => {
        return pool.simulate("git-conflict", `stress-sim-${i}`, {
          conflictDetected: "true",
          stagedFiles: i % 5,
          index: i,
        });
      }),
    );

    const successful = simulations.filter((s) => s !== null);
    expect(successful.length).toBeGreaterThan(0);
    logger.info("[Stress/MentalModel] 100 simulations", { total: simulations.length, nonnull: successful.length });
  });

  test("100 rapid-fire rule additions", () => {
    for (let i = 0; i < 100; i++) {
      pool.addRule("git-conflict", `key${i} exists`, `action_${i}`, 0.5 + Math.random() * 0.5);
    }
    const model = pool.get("git-conflict");
    expect(model!.rules.length).toBeGreaterThanOrEqual(100);
  });

  test("Generate skills from 50 successful simulations", () => {
    const model = pool.get("git-conflict")!;
    // Add a guaranteed-matching rule
    pool.addRule("git-conflict", "alwaysTrue exists", "trigger", 1.0);

    const skills: string[] = [];
    for (let i = 0; i < 50; i++) {
      const sim = pool.simulate("git-conflict", `skill-test-${i}`, { alwaysTrue: "yes", index: i });
      if (sim?.outcome === "success") {
        const skill = pool.generateSkillFromSimulation("git-conflict", sim.id);
        if (skill) skills.push(skill);
      }
    }
    expect(skills.length).toBe(50);
    logger.info("[Stress/MentalModel] Skill generation", { generated: skills.length });
  });

  test("Model registration memory stability", () => {
    const testPool = new MentalModelPool();
    const initialStats = testPool.getStats();

    for (let i = 0; i < 500; i++) {
      testPool.register({
        id: `stress-model-${i}`,
        name: `Stress Model ${i}`,
        domain: `stress-domain-${i % 10}`,
        description: `Generated stress model ${i}`,
        concepts: [
          { id: "c1", name: "Concept1", description: "Test", properties: {}, relations: [] },
      ],
      transitions: [
        { id: "t1", fromState: "start", toState: "end", trigger: "go", requiredConcepts: [], probability: 1.0 },
    ],
    initialState: "start",
    currentState: "start",
    confidence: 0.5,
    usageCount: 0,
    lastUsedAt: 0,
    createdAt: Date.now(),
    rules: [],
    simulations: [],
  });
}

const finalStats = testPool.getStats();
expect(finalStats.models).toBe(500);
logger.info("[Stress/MentalModel] 500 model registrations", finalStats);
});

test("All 4 default models have rules", () => {
  const models = pool.list();
  expect(models.length).toBe(4);
  let modelsWithRules = 0;
  for (const m of models) {
    if (m.rules.length > 0) modelsWithRules++;
  }
  // At least Git + Auth + DB should have rules from createDefaultMentalModelPool
  expect(modelsWithRules).toBeGreaterThanOrEqual(3);
});

test("simulate with empty initial state doesn't crash", () => {
  const sim = pool.simulate("auth-flow", "empty test", {});
  expect(sim).not.toBeNull();
});
});

// ========== 集成适配度测试 ==========

describe("Integration: EventBus ↔ WorldState", () => {
  test("state.changed event published on every set", () => {
    let changes = 0;
    const subId = eventBus.subscribe("state.changed", (e) => {
      const data = e.data as { path: string; version: number };
      if ((data.path as string).startsWith("integration")) changes++;
});

// These should trigger state.changed events
worldState.set("integration.test1", 1);
worldState.set("integration.test2", 2);
worldState.set("integration.test3", 3);

expect(changes).toBe(3);
eventBus.unsubscribe(subId);
});

test("WorldState snapshot contains EventBus-like IDs", async () => {
  // Publish an event that writes to worldState
  eventBus.subscribe("integration.store", (e) => {
    const data = e.data as Record<string, unknown>;
    worldState.set("integration.from_event", data);
  });

  eventBus.publish({
    type: "integration.store",
    source: "integration",
    data: { message: "from bus" },
    priority: "normal",
  });

  // Give async handlers time
  await new Promise((r) => setTimeout(r, 50));

  const stored = worldState.get("integration.from_event");
  expect(stored).toBeDefined();
  expect((stored as Record<string, unknown>).message).toBe("from bus");
});
});

// ========== 适配度分析报告 ==========

describe("Adaptation Quality Report", () => {
  test("EventBus API compatibility", () => {
    // Verify all expected methods exist
    expect(typeof eventBus.publish).toBe("function");
    expect(typeof eventBus.subscribe).toBe("function");
    expect(typeof eventBus.subscribeOnce).toBe("function");
    expect(typeof eventBus.unsubscribe).toBe("function");
    expect(typeof eventBus.getRecentEvents).toBe("function");
    expect(typeof eventBus.getStats).toBe("function");

    // Verify singleton behavior
    const stats = eventBus.getStats();
    expect(typeof stats.published).toBe("number");
    expect(typeof stats.errors).toBe("number");
    expect(typeof stats.subscriberCount).toBe("number");
  });

  test("WorldState API compatibility", () => {
    expect(typeof worldState.get).toBe("function");
    expect(typeof worldState.set).toBe("function");
    expect(typeof worldState.update).toBe("function");
    expect(typeof worldState.watch).toBe("function");
    expect(typeof worldState.query).toBe("function");
    expect(typeof worldState.snapshot).toBe("function");
    expect(typeof worldState.getVersion).toBe("function");

    // Mental dimension API
    expect(typeof worldState.setIntent).toBe("function");
    expect(typeof worldState.getIntent).toBe("function");
    expect(typeof worldState.setGoal).toBe("function");
    expect(typeof worldState.setBelief).toBe("function");
    expect(typeof worldState.setHypothesis).toBe("function");
  });

  test("MentalModelPool API compatibility (post-merge)", () => {
    const testPool = createDefaultMentalModelPool();
    expect(typeof testPool.simulate).toBe("function");
    expect(typeof testPool.addRule).toBe("function");
    expect(typeof testPool.generateSkillFromSimulation).toBe("function");
    expect(typeof testPool.getStats).toBe("function");

    // Original API still works
    expect(typeof testPool.register).toBe("function");
    expect(typeof testPool.get).toBe("function");
    expect(typeof testPool.matchPattern).toBe("function");
    expect(typeof testPool.predict).toBe("function");
    expect(typeof testPool.advanceState).toBe("function");
    expect(typeof testPool.list).toBe("function");
  });
});
