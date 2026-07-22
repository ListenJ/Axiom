/**
 * 性能门禁测试 — CI 用统一阈值断言
 *
 * 设计目标:
 *  - 短小精悍：CI 在 ~10s 内跑完，避免拖慢流水线
 *  - 绝对阈值：与 scripts/stress-runner.ts THRESHOLDS 对齐，单独跑也能门禁
 *  - 覆盖热路径：Cache / ThompsonRouter / ConstraintSolver / EventBus / ConfigCenter / AtomEngine / Scheduler / normalizeQuery
 *  - 失败即门禁：任何一项超阈值整批失败，CI 阻断合并
 *
 * 用法:
 *   bun test tests/stress/perf-gate.test.ts
 *   bun run scripts/stress-runner.ts --suite=gate
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { scheduler } from "../../src/dre/runtime/scheduler.js";
import { atomStore } from "../../src/dre/runtime/atom-engine.js";
import { knowledgeNetwork } from "../../src/dre/runtime/knowledge-network.js";
import { ReasoningGraph } from "../../src/dre/reasoning/graph.js";

// ═══════════════════════════════════════════════════════════════
// 阈值表 — 与 scripts/stress-runner.ts THRESHOLDS 保持一致
// 单位：ms（wall-clock，单次测量，允许抖动）
// ═══════════════════════════════════════════════════════════════

const GATE_THRESHOLDS = {
  // 高频热路径（单 op 阈值）
  cacheSetGet_10k: 200,         // Cache set+get × 10000 次
  thompsonRoute_1k: 100,        // ThompsonRouter.route × 1000 次
  solverCheck_10k: 500,         // ConstraintSolver.check × 10000 次
  eventBus_10k: 50,             // EventBus.publish × 10000 次
  configCenterReads_10k: 100,   // ConfigCenter 混合读 × 10000 次
  normalizeQuery_10k: 100,      // normalizeQuery × 10000 次
  // 压力门禁（批次阈值）
  scheduler_500_tasks: 5000,    // Scheduler 500 任务调度
  atomEngine_5000_create: 2000, // AtomEngine 5000 原子创建
  atomEngine_search_5000: 100,  // AtomEngine 5000 原子中检索
  knowledge_2000_entities: 3000,// KnowledgeNetwork 2000 实体 + 5000 链接
  graph_5000_nodes: 3000,       // ReasoningGraph 5000 节点构建
  graph_gap_detect: 1000,       // ReasoningGraph gap 检测（1500 节点）
} as const;

// ═══════════════════════════════════════════════════════════════
// 工具函数
// ═══════════════════════════════════════════════════════════════

function benchSync(fn: () => void, iterations: number): number {
  const start = performance.now();
  for (let i = 0; i < iterations; i++) fn();
  return performance.now() - start;
}

function clearAtomStore(): void {
  const stats = atomStore.getStats();
  if (stats.total === 0) return;
  for (const kind of Object.keys(stats.byKind)) {
    const atoms = atomStore.queryByKind(kind as never);
    for (const a of atoms) atomStore.delete(a.id);
  }
}

function assertGate(label: string, actualMs: number, thresholdMs: number): void {
  console.log(`[Gate] ${label}: ${actualMs.toFixed(2)}ms / ${thresholdMs}ms threshold`);
  expect(actualMs).toBeLessThan(thresholdMs);
}

// ═══════════════════════════════════════════════════════════════
// 门禁测试
// ═══════════════════════════════════════════════════════════════

describe("性能门禁 — 热路径", () => {
  test("[gate] Cache set+get ×10k < 200ms", () => {
    const { Cache } = require("../../src/utils/cache.js");
    const cache = new Cache({ maxSize: 1000, defaultTtlMs: 60000, redis: false, persistent: false });
    const total = benchSync(() => {
      cache.set("gate-k", "gate-v");
      cache.getSync("gate-k");
    }, 10000);
    cache.destroy();
    assertGate("cacheSetGet_10k", total, GATE_THRESHOLDS.cacheSetGet_10k);
  });

  test("[gate] ThompsonRouter.route ×1k < 100ms", async () => {
    const { ThompsonRouter } = require("../../src/router/thompson-router.js");
    const router = new ThompsonRouter({
      arms: [
        { id: "fast", model: "gpt-3.5", provider: "openai", alpha: 5, beta: 1 },
        { id: "cheap", model: "claude-haiku", provider: "anthropic", alpha: 3, beta: 3 },
      ],
      minSamples: 5, decayFactor: 0.95, inMemory: true,
    });
    const ctx = { taskType: "qa", inputLength: 100 };
    const start = performance.now();
    for (let i = 0; i < 1000; i++) await router.route(ctx);
    const total = performance.now() - start;
    assertGate("thompsonRoute_1k", total, GATE_THRESHOLDS.thompsonRoute_1k);
  });

  test("[gate] ConstraintSolver.check ×10k < 500ms", () => {
    const { ConstraintSolver, RESOURCE_CONSTRAINTS } = require("../../src/dre/constraint/solver.js");
    const s = new ConstraintSolver();
    s.registerAll(RESOURCE_CONSTRAINTS);
    s.register({
      id: "gate-mem-min", dimension: "physical", type: "min_value",
      name: "", description: "", subject: "mem",
      params: { min: 500 }, priority: 1, enabled: true, createdAt: 0,
    });
    const total = benchSync(() => {
      s.check("deploy", { mem: 2000, env: "staging", role: "admin" });
    }, 10000);
    assertGate("solverCheck_10k", total, GATE_THRESHOLDS.solverCheck_10k);
  });

  test("[gate] EventBus.publish ×10k < 50ms", () => {
    const { eventBus } = require("../../src/dre/runtime/event-bus.js");
    const subs: string[] = [];
    for (let i = 0; i < 5; i++) {
      subs.push(eventBus.subscribe(`gate.test.${i}`, () => { /* noop */ }));
    }
    const total = benchSync(() => {
      eventBus.publish({ type: "gate.test.0", source: "gate", data: {}, priority: "normal" });
    }, 10000);
    for (const id of subs) eventBus.unsubscribe(id);
    assertGate("eventBus_10k", total, GATE_THRESHOLDS.eventBus_10k);
  });

  test("[gate] ConfigCenter mixed reads ×10k < 100ms", () => {
    const { ConfigCenter } = require("../../src/core/config-center.js");
    const cc = new ConfigCenter(":memory:");
    const total = benchSync(() => {
      for (let i = 0; i < 100; i++) {
        cc.get("gateway.port");
        cc.getString("gateway.bind");
        cc.getNumber("crawler.max_concurrent");
      }
    }, 100); // 100 × 100 = 10000 reads
    assertGate("configCenterReads_10k", total, GATE_THRESHOLDS.configCenterReads_10k);
  });

  test("[gate] normalizeQuery ×10k < 100ms", () => {
    const { normalizeQuery } = require("../../src/tools/types.js");
    const queries = ["What is the capital of France?", "你好世界", "binary search tree", ""];
    const total = benchSync(() => {
      for (const q of queries) normalizeQuery(q);
    }, 2500); // 2500 × 4 = 10000 calls
    assertGate("normalizeQuery_10k", total, GATE_THRESHOLDS.normalizeQuery_10k);
  });
});

describe("性能门禁 — 压力测试", () => {
  beforeEach(() => {
    scheduler.reset();
    clearAtomStore();
    knowledgeNetwork.reset();
  });
  afterEach(() => {
    scheduler.reset();
    clearAtomStore();
    knowledgeNetwork.reset();
  });

  test("[gate] Scheduler 500 tasks < 5000ms", () => {
    const start = performance.now();
    const taskIds: string[] = [];
    for (let i = 0; i < 500; i++) {
      const priority = i % 5 === 0 ? "critical" : i % 2 === 0 ? "normal" : "low";
      const deps = i > 0 && i % 10 === 0 ? [taskIds[i - 10]] : [];
      const task = scheduler.submit({
        name: `gate-task-${i}`,
        priority: priority as "critical" | "normal" | "low",
        payload: { index: i },
        maxRetries: 0,
        dependencies: deps,
      });
      taskIds.push(task.id);
    }
    let completed = 0;
    let task: ReturnType<typeof scheduler.getNext>;
    while ((task = scheduler.getNext()) !== null) {
      scheduler.complete(task.id, { ok: true });
      completed++;
    }
    const total = performance.now() - start;
    expect(completed).toBe(500);
    assertGate("scheduler_500_tasks", total, GATE_THRESHOLDS.scheduler_500_tasks);
  });

  test("[gate] AtomEngine 5000 create < 2000ms", () => {
    const start = performance.now();
    for (let i = 0; i < 5000; i++) {
      atomStore.create("entity", `Gate atom #${i}`, {
        metadata: { index: i },
        source: "gate-test",
      });
    }
    const total = performance.now() - start;
    expect(atomStore.getStats().total).toBe(5000);
    assertGate("atomEngine_5000_create", total, GATE_THRESHOLDS.atomEngine_5000_create);
  });

  test("[gate] AtomEngine search 5000 < 100ms", () => {
    for (let i = 0; i < 5000; i++) {
      atomStore.create("entity", `Searchable gate atom ${i}`, { source: "gate-test" });
    }
    const start = performance.now();
    const results = atomStore.search("Searchable", 100);
    const total = performance.now() - start;
    expect(results.length).toBe(100);
    assertGate("atomEngine_search_5000", total, GATE_THRESHOLDS.atomEngine_search_5000);
  });

  test("[gate] KnowledgeNetwork 2000 entities + 5000 links < 3000ms", () => {
    const start = performance.now();
    const ids: string[] = [];
    for (let i = 0; i < 2000; i++) {
      const ent = knowledgeNetwork.create(
        i % 2 === 0 ? "agent" : "tool",
        `GateEntity-${i}`,
        `Entity ${i}`,
        { confidence: 0.7, source: "gate-test" },
      );
      ids.push(ent.id);
    }
    for (let i = 0; i < 5000; i++) {
      knowledgeNetwork.link(ids[i % 2000], ids[(i + 1) % 2000], `gate-rel-${i}`, { weight: 0.5 });
    }
    const total = performance.now() - start;
    const stats = knowledgeNetwork.getStats();
    expect(stats.total).toBe(2000);
    expect(stats.links).toBe(5000);
    assertGate("knowledge_2000_entities", total, GATE_THRESHOLDS.knowledge_2000_entities);
  });

  test("[gate] ReasoningGraph 5000 nodes < 3000ms", () => {
    const graph = new ReasoningGraph();
    const start = performance.now();
    const premiseIds: string[] = [];
    for (let i = 0; i < 2500; i++) {
      const node = graph.addPremise(`Gate premise ${i}`, 0.7);
      premiseIds.push(node.id);
    }
    for (let i = 0; i < 2500; i++) {
      const fromIds = [premiseIds[i % 2500], premiseIds[(i + 1) % 2500]];
      graph.addInference(`Gate inference ${i}`, fromIds, 0.7);
    }
    const total = performance.now() - start;
    expect(graph.getStats().totalNodes).toBe(5000);
    assertGate("graph_5000_nodes", total, GATE_THRESHOLDS.graph_5000_nodes);
  });

  test("[gate] ReasoningGraph gap detection < 1000ms", () => {
    const graph = new ReasoningGraph();
    const linkedIds: string[] = [];
    for (let i = 0; i < 500; i++) {
      const p = graph.addPremise(`Linked ${i}`, 0.8);
      linkedIds.push(p.id);
    }
    for (let i = 0; i < 500; i++) {
      graph.addInference(`Weak ${i}`, [linkedIds[i]], 0.1);
    }
    for (let i = 0; i < 500; i++) {
      graph.addPremise(`Isolated ${i}`, 0.8);
    }
    const start = performance.now();
    const gaps = graph.detectGaps();
    const total = performance.now() - start;
    expect(gaps.length).toBe(1000);
    assertGate("graph_gap_detect", total, GATE_THRESHOLDS.graph_gap_detect);
  });
});
