/**
 * 超高压力测试 — 模拟远超预期的并发、数据量及请求频率
 *
 * 测试维度:
 * 1. Scheduler: 500+ 混合优先级任务 + 依赖链 + 截止时间
 * 2. AtomEngine: 5000+ 原子写入 + 查询 + 删除
 * 3. KnowledgeNetwork: 2000+ 实体 + 5000+ 链接
 * 4. ReasoningGraph: 5000+ 节点 + gap 检测
 * 5. LLMClient: 并发请求 + 熔断器行为
 * 6. ConsciousnessStream: 5000+ 步进 + 反思触发
 * 7. CapabilityRegistry: 1000+ 能力注册 + 并发选择
 * 8. 内存占用跟踪
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { scheduler } from "../../src/dre/runtime/scheduler.js";
import { capabilityRegistry, type CapabilityContract } from "../../src/dre/runtime/capability-registry.js";
import { knowledgeNetwork } from "../../src/dre/runtime/knowledge-network.js";
import { atomStore } from "../../src/dre/runtime/atom-engine.js";
import { ReasoningGraph } from "../../src/dre/reasoning/graph.js";
import { LLMClient } from "../../src/dre/llm/client.js";
import { ConsciousnessStream } from "../../src/dre/consciousness/stream.js";

// ========== 辅助函数 ==========

function getMemoryUsageMB(): { rss: number; heap: number } {
  const mem = process.memoryUsage();
  return {
    rss: Math.round(mem.rss / 1024 / 1024),
    heap: Math.round(mem.heapUsed / 1024 / 1024),
  };
}

function clearAtomStore(): void {
  const stats = atomStore.getStats();
  if (stats.total === 0) return;
  // Query all kinds and delete all atoms
  for (const kind of Object.keys(stats.byKind)) {
    const atoms = atomStore.queryByKind(kind as never);
    for (const a of atoms) {
      atomStore.delete(a.id);
    }
  }
}

// ========== 1. Scheduler 超高压力 ==========

describe("Scheduler: extreme stress (500+ tasks)", () => {
  beforeEach(() => scheduler.reset());
  afterEach(() => scheduler.reset());

  test("500 mixed-priority tasks with dependencies", () => {
    const startMem = getMemoryUsageMB();
    const start = performance.now();

    const taskIds: string[] = [];
    for (let i = 0; i < 500; i++) {
      const priority = i % 5 === 0 ? "critical" : i % 3 === 0 ? "high" : i % 2 === 0 ? "normal" : "low";
      const deps = i > 0 && i % 10 === 0 ? [taskIds[i - 10]] : [];
      const task = scheduler.submit({
        name: `task-${i}`,
        priority: priority as "critical" | "high" | "normal" | "low",
        payload: { index: i, data: "x".repeat(100) },
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

    const duration = performance.now() - start;
    const endMem = getMemoryUsageMB();

    expect(completed).toBe(500);
    expect(duration).toBeLessThan(5000);
    console.log(`[Stress] 500 tasks: ${duration.toFixed(0)}ms, mem delta: ${endMem.heap - startMem.heap}MB`);
  });

  test("100 tasks with deadline expiry burst", () => {
    const now = Date.now();
    for (let i = 0; i < 50; i++) {
      scheduler.submit({
        name: `expired-${i}`,
        priority: "normal",
        payload: {},
        maxRetries: 0,
        dependencies: [],
        deadline: now - 1000 - i,
      });
    }
    for (let i = 0; i < 50; i++) {
      scheduler.submit({
        name: `alive-${i}`,
        priority: "normal",
        payload: {},
        maxRetries: 0,
        dependencies: [],
        deadline: now + 60000,
      });
    }

    let completed = 0;
    let task: ReturnType<typeof scheduler.getNext>;
    while ((task = scheduler.getNext()) !== null) {
      scheduler.complete(task.id, { ok: true });
      completed++;
    }

    expect(completed).toBe(50);
  });

  test("rapid submit + complete cycle (1000 rounds)", () => {
    const start = performance.now();

    for (let i = 0; i < 1000; i++) {
      const task = scheduler.submit({
        name: `rapid-${i}`,
        priority: "normal",
        payload: {},
        maxRetries: 0,
        dependencies: [],
      });
      const next = scheduler.getNext();
      expect(next).not.toBeNull();
      scheduler.complete(task.id, { ok: true });
    }

    const duration = performance.now() - start;
    console.log(`[Stress] 1000 rapid cycles: ${duration.toFixed(0)}ms`);
    expect(duration).toBeLessThan(3000);
  });

  test("preemption under extreme load (critical burst)", () => {
    for (let i = 0; i < 4; i++) {
      scheduler.submit({
        name: `bg-${i}`,
        priority: "low",
        payload: {},
        maxRetries: 0,
        dependencies: [],
      });
      const t = scheduler.getNext();
      expect(t).not.toBeNull();
    }

    scheduler.submit({
      name: "critical-urgent",
      priority: "critical",
      payload: {},
      maxRetries: 0,
      dependencies: [],
    });

    const next = scheduler.getNext();
    expect(next).not.toBeNull();
    expect(next?.name).toBe("critical-urgent");
  });
});

// ========== 2. AtomEngine 超高压力 ==========

describe("AtomEngine: extreme stress (5000+ atoms)", () => {
  beforeEach(() => clearAtomStore());
  afterEach(() => clearAtomStore());

  test("batch create 5000 atoms", () => {
    const startMem = getMemoryUsageMB();
    const start = performance.now();

    for (let i = 0; i < 5000; i++) {
      atomStore.create("entity", `Stress atom #${i}`, {
        metadata: { index: i, batch: "stress" },
        confidence: "inferred",
        source: "stress-test",
      });
    }

    const stats = atomStore.getStats();
    const duration = performance.now() - start;
    const endMem = getMemoryUsageMB();

    expect(stats.total).toBe(5000);
    expect(duration).toBeLessThan(2000);
    console.log(`[Stress] 5000 atoms create: ${duration.toFixed(0)}ms, mem delta: ${endMem.heap - startMem.heap}MB`);
  });

  test("query 5000 atoms by kind", () => {
    for (let i = 0; i < 5000; i++) {
      atomStore.create("entity", `Query atom #${i}`, {
        source: "stress-test",
      });
    }

    const start = performance.now();
    const result = atomStore.queryByKind("entity");
    const duration = performance.now() - start;

    expect(result.length).toBe(5000);
    expect(duration).toBeLessThan(100);
  });

  test("delete 1000 atoms", () => {
    const ids: string[] = [];
    for (let i = 0; i < 2000; i++) {
      const atom = atomStore.create("entity", `Delete atom #${i}`, {
        source: "stress-test",
      });
      ids.push(atom.id);
    }

    const start = performance.now();
    for (let i = 0; i < 1000; i++) {
      atomStore.delete(ids[i]);
    }
    const duration = performance.now() - start;

    const stats = atomStore.getStats();
    expect(stats.total).toBe(1000);
    expect(duration).toBeLessThan(500);
  });

  test("search 5000 atoms by content", () => {
    for (let i = 0; i < 5000; i++) {
      atomStore.create("entity", `Searchable atom ${i} with content`, {
        source: "stress-test",
      });
    }

    const start = performance.now();
    const results = atomStore.search("Searchable", 100);
    const duration = performance.now() - start;

    expect(results.length).toBe(100);
    expect(duration).toBeLessThan(100);
  });
});

// ========== 3. KnowledgeNetwork 超高压力 ==========

describe("KnowledgeNetwork: extreme stress (2000+ entities, 5000+ links)", () => {
  beforeEach(() => knowledgeNetwork.reset());
  afterEach(() => knowledgeNetwork.reset());

  test("create 2000 entities + 5000 links", () => {
    const startMem = getMemoryUsageMB();
    const start = performance.now();

    const entityIds: string[] = [];
    for (let i = 0; i < 2000; i++) {
      const kind = i % 3 === 0 ? "agent" : i % 3 === 1 ? "capability" : "tool";
      const ent = knowledgeNetwork.create(
        kind as never,
        `Entity-${i}`,
        `Entity #${i} for stress testing`,
        { confidence: 0.7, source: "stress-test" },
      );
      entityIds.push(ent.id);
    }

    // 创建 5000 个唯一链接 — link() 按 (src, dst, relation) 三元组去重,
    // 所以必须变化 relation 或 (src,dst) 对。这里每个链接用唯一 relation。
    for (let i = 0; i < 5000; i++) {
      const src = entityIds[i % 2000];
      const dst = entityIds[(i + 1) % 2000];
      knowledgeNetwork.link(src, dst, `related-${i}`, { weight: Math.random() });
    }

    const duration = performance.now() - start;
    const endMem = getMemoryUsageMB();
    const stats = knowledgeNetwork.getStats();

    expect(stats.total).toBe(2000);
    expect(stats.links).toBe(5000);
    expect(duration).toBeLessThan(3000);
    console.log(`[Stress] 2000 entities + 5000 links: ${duration.toFixed(0)}ms, mem delta: ${endMem.heap - startMem.heap}MB`);
  });

  test("delete 500 entities with link cascade", () => {
    const ids: string[] = [];
    for (let i = 0; i < 1000; i++) {
      const ent = knowledgeNetwork.create("agent", `DelEntity-${i}`, `Entity ${i}`, {
        confidence: 0.7,
        source: "stress-test",
      });
      ids.push(ent.id);
    }
    for (let i = 0; i < 2000; i++) {
      knowledgeNetwork.link(ids[i % 1000], ids[(i + 1) % 1000], "related", { weight: 0.5 });
    }

    const start = performance.now();
    for (let i = 0; i < 500; i++) {
      knowledgeNetwork.delete(ids[i]);
    }
    const duration = performance.now() - start;

    const stats = knowledgeNetwork.getStats();
    expect(stats.total).toBe(500);
    expect(duration).toBeLessThan(2000);
  });

  test("concurrent create + delete (race condition detection)", async () => {
    const createdIds: string[] = [];

    const createPromise = (async () => {
      for (let i = 0; i < 500; i++) {
        const ent = knowledgeNetwork.create("agent", `Race-${i}`, "concurrent", {
          confidence: 0.7,
          source: "stress-test",
        });
        createdIds.push(ent.id);
      }
    })();

    const deletePromise = (async () => {
      await new Promise((r) => setTimeout(r, 5));
      for (let i = 0; i < 250; i++) {
        if (createdIds[i]) {
          try {
            knowledgeNetwork.delete(createdIds[i]);
          } catch {
            // 可能还没创建 — 可接受
          }
        }
      }
    })();

    await Promise.all([createPromise, deletePromise]);

    const stats = knowledgeNetwork.getStats();
    expect(stats.total).toBeGreaterThanOrEqual(250);
    expect(stats.total).toBeLessThanOrEqual(500);
  });
});

// ========== 4. ReasoningGraph 超高压力 ==========

describe("ReasoningGraph: extreme stress (5000+ nodes)", () => {
  test("build graph with 5000 premises + inferences", () => {
    const graph = new ReasoningGraph();
    const start = performance.now();

    // 添加 2500 个前提
    const premiseIds: string[] = [];
    for (let i = 0; i < 2500; i++) {
      const node = graph.addPremise(`Premise ${i}`, 0.5 + (i % 5) * 0.1);
      premiseIds.push(node.id);
    }

    // 添加 2500 个推理 (每个从 2 个前提推理)
    for (let i = 0; i < 2500; i++) {
      const fromIds = [premiseIds[i % 2500], premiseIds[(i + 1) % 2500]];
      graph.addInference(`Inference ${i}`, fromIds, 0.7);
    }

    const stats = graph.getStats();
    const duration = performance.now() - start;

    // ID 生成已切换到 crypto.randomUUID().slice(0, 8) (32-bit 熵),
    // 在 5000 节点规模下生日悖论碰撞概率可忽略 (< 0.3%)。
    expect(stats.totalNodes).toBe(5000);
    expect(stats.totalEdges).toBe(5000);
    expect(duration).toBeLessThan(3000);
    console.log(`[Stress] 5000 nodes graph: ${duration.toFixed(0)}ms, nodes: ${stats.totalNodes}, edges: ${stats.totalEdges}`);
  });

  test("detect gaps in large graph (weak links + isolated premises)", () => {
    // 构建一个会产生可预测 gaps 的图:
    // - 500 个前提 + 500 个推理 (1:1 连接, strength=0.1 → 弱链接)
    // - 500 个孤立前提 (无 out-edge → missing_inference gap)
    // 预期 gaps: 500 (weak_link) + 500 (isolated) = 1000
    const graph = new ReasoningGraph();

    const linkedPremiseIds: string[] = [];
    for (let i = 0; i < 500; i++) {
      const p = graph.addPremise(`Linked premise ${i}`, 0.8);
      linkedPremiseIds.push(p.id);
    }
    // 每个推理从 1 个前提推理, 但 confidence=0.1 → 弱边 (strength < 0.5)
    for (let i = 0; i < 500; i++) {
      graph.addInference(`Weak inference ${i}`, [linkedPremiseIds[i]], 0.1);
    }
    // 500 个孤立前提 (没有出边)
    for (let i = 0; i < 500; i++) {
      graph.addPremise(`Isolated premise ${i}`, 0.8);
    }

    const start = performance.now();
    const gaps = graph.detectGaps();
    const duration = performance.now() - start;

    // 500 weak_link gaps + 500 missing_inference (isolated) gaps = 1000
    expect(gaps.length).toBe(1000);
    expect(duration).toBeLessThan(1000);
    console.log(`[Stress] Gap detection 1500 nodes: ${duration.toFixed(0)}ms, gaps: ${gaps.length}`);
  });
});

// ========== 5. LLMClient 并发压力 ==========

describe("LLMClient: concurrent stress + circuit breaker", () => {
  test("50 concurrent requests with unreachable server", async () => {
    const client = new LLMClient({
      baseUrl: "http://127.0.0.1:1",
      model: "test-model",
      retry: { maxRetries: 0, baseDelayMs: 1, maxDelayMs: 10 },
      circuitBreaker: { failureThreshold: 100, cooldownMs: 1000 },
    });

    const start = performance.now();
    const promises = Array.from({ length: 50 }, () =>
      client.generate("test prompt").catch((err) => err),
    );
    const results = await Promise.all(promises);
    const duration = performance.now() - start;

    const errors = results.filter((r) => r instanceof Error);
    expect(errors.length).toBe(50);
    expect(duration).toBeLessThan(5000);

    const stats = client.getStats();
    expect(stats.failureCount).toBe(50);
    console.log(`[Stress] 50 concurrent failures: ${duration.toFixed(0)}ms, circuit: ${stats.circuitState}`);
  });

  test("circuit breaker opens after threshold", async () => {
    const client = new LLMClient({
      baseUrl: "http://127.0.0.1:1",
      model: "test-model",
      retry: { maxRetries: 0, baseDelayMs: 1, maxDelayMs: 10 },
      circuitBreaker: { failureThreshold: 5, cooldownMs: 60000 },
    });

    for (let i = 0; i < 5; i++) {
      await client.generate("test").catch(() => {});
    }

    expect(client.getCircuitState()).toBe("open");

    const start = performance.now();
    await expect(client.generate("test")).rejects.toThrow("circuit breaker");
    const duration = performance.now() - start;
    expect(duration).toBeLessThan(10);
  });
});

// ========== 6. ConsciousnessStream 超高压力 ==========

describe("ConsciousnessStream: extreme stress (5000+ steps)", () => {
  test("5000 step processing with trace cap", async () => {
    const stream = new ConsciousnessStream({ maxTraceLength: 500 });
    const start = performance.now();

    for (let i = 0; i < 5000; i++) {
      await stream.step({ observation: `Observation ${i}` });
    }

    const duration = performance.now() - start;
    const trace = stream.getTrace();

    expect(trace.length).toBe(500);
    expect(duration).toBeLessThan(10000);
    console.log(`[Stress] 5000 steps: ${duration.toFixed(0)}ms, trace: ${trace.length}`);
  });

  test("rapid reflection triggers (1000 diverse steps)", async () => {
    const stream = new ConsciousnessStream();
    const start = performance.now();
    let reflectionCount = 0;

    stream.on("reflection", () => reflectionCount++);

    for (let i = 0; i < 1000; i++) {
      await stream.step({ observation: `Diverse output ${i}-${Math.random()}` });
    }

    const duration = performance.now() - start;
    console.log(`[Stress] 1000 diverse steps: ${duration.toFixed(0)}ms, reflections: ${reflectionCount}`);
    expect(duration).toBeLessThan(5000);
  });
});

// ========== 7. CapabilityRegistry 超高压力 ==========

describe("CapabilityRegistry: extreme stress (1000+ capabilities)", () => {
  const CONTRACT: CapabilityContract = "stress-test" as CapabilityContract;

  beforeEach(() => capabilityRegistry.reset());
  afterEach(() => capabilityRegistry.reset());

  test("register 1000 capabilities + select under load", () => {
    const start = performance.now();

    for (let i = 0; i < 1000; i++) {
      capabilityRegistry.registerProvider({
        id: `prov-${i}`,
        name: `Provider ${i}`,
        type: i % 2 === 0 ? "internal" : "external",
        capabilities: [CONTRACT],
        costPerCall: (i % 10) * 0.01,
        avgLatencyMs: 10 + (i % 100),
        reliability: 0.5 + (i % 50) * 0.01,
        maxConcurrency: 1,
        metadata: { tag: `tag-${i % 5}` },
      });
    }

    for (let i = 0; i < 500; i++) {
      const cap = capabilityRegistry.select(CONTRACT);
      if (cap) {
        capabilityRegistry.recordResult(cap.id, true);
      }
    }

    const duration = performance.now() - start;
    const stats = capabilityRegistry.getStats();

    expect(duration).toBeLessThan(2000);
    expect(stats.capabilities).toBe(1000);
    console.log(`[Stress] 1000 caps + 500 selects: ${duration.toFixed(0)}ms`);
  });

  test("concurrent register + select (race condition)", async () => {
    const registerPromise = (async () => {
      for (let i = 0; i < 200; i++) {
        capabilityRegistry.registerProvider({
          id: `race-prov-${i}`,
          name: `Race Provider ${i}`,
          type: "internal",
          capabilities: [CONTRACT],
          costPerCall: 0.01,
          avgLatencyMs: 10,
          reliability: 0.9,
          maxConcurrency: 1,
          metadata: {},
        });
      }
    })();

    const selectPromise = (async () => {
      for (let i = 0; i < 200; i++) {
        const cap = capabilityRegistry.select(CONTRACT);
        if (cap) {
          capabilityRegistry.recordResult(cap.id, i % 3 !== 0);
        }
      }
    })();

    await Promise.all([registerPromise, selectPromise]);

    const stats = capabilityRegistry.getStats();
    expect(stats.capabilities).toBeGreaterThan(0);
  });
});

// ========== 8. 内存压力综合测试 ==========

describe("Memory pressure: combined workload", () => {
  test("combined atom + entity + graph workload (memory bounded)", () => {
    clearAtomStore();
    knowledgeNetwork.reset();
    const startMem = getMemoryUsageMB();

    const graph = new ReasoningGraph();

    for (let i = 0; i < 2000; i++) {
      atomStore.create("entity", `Combined ${i}`, {
        metadata: { i },
        source: "combined-stress",
      });

      if (i < 1000) {
        knowledgeNetwork.create("agent", `Agent-${i}`, `Agent ${i}`, {
          confidence: 0.7,
          source: "combined-stress",
        });
      }

      graph.addPremise(`Premise ${i}`, 0.7);
    }

    const endMem = getMemoryUsageMB();
    const memDelta = endMem.heap - startMem.heap;

    // KnowledgeNetwork.create() 内部会同步创建 atom (entityToAtom 映射),
    // 因此 atomStore.total = 2000 (直接) + 1000 (来自 KN) = 3000
    console.log(`[Stress] Combined workload mem delta: ${memDelta}MB`);
    expect(memDelta).toBeLessThan(200);
    expect(atomStore.getStats().total).toBe(3000);
    expect(knowledgeNetwork.getStats().total).toBe(1000);
    expect(graph.getStats().totalNodes).toBe(2000);

    clearAtomStore();
    knowledgeNetwork.reset();
  });
});
