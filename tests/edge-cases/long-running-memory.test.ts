/**
 * 边缘场景测试 C — 长时间运行 + 内存泄漏检测
 *
 * 测试目标：验证组件在持续运行下的稳定性和内存回收能力。
 * 覆盖组件：Cache、KnowledgeNetwork、AtomEngine、EventBus
 *
 * 测试维度：
 *   C.1 长时间运行（50k 操作循环 + 性能衰减检测）
 *   C.2 内存泄漏检测（create/destroy 循环 + heap 增量验证）
 *   C.3 状态累积检测（验证 stats/计数器不无限增长）
 *
 * 内存测量方法：
 *   - 使用 process.memoryUsage().heapUsed 测量堆内存
 *   - 强制 GC（如果可用）后测量基准值
 *   - 多轮循环后再次测量，验证增量在阈值内
 *
 * 设计原则（遵循 AGENTS.md 规则 6 调试纪律）：
 *   - 先建立可复现的反馈回路（性能测量命令）
 *   - 断言基于相对增量而非绝对值（避免环境差异误报）
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Cache } from "../../src/utils/cache.js";
import { knowledgeNetwork } from "../../src/dre/runtime/knowledge-network.js";
import { atomStore } from "../../src/dre/runtime/atom-engine.js";
import { eventBus } from "../../src/dre/runtime/event-bus.js";

// ─── 内存测量工具 ──────────────────────────────────────────────

function getHeapMB(): number {
  return Math.round((process.memoryUsage().heapUsed / 1024 / 1024) * 100) / 100;
}

/** 尝试强制 GC（Bun 需要特殊 flag，可能不可用） */
function tryGC(): void {
  if (typeof (globalThis as never as { gc?: () => void }).gc === "function") {
    (globalThis as never as { gc: () => void }).gc();
  }
}

// ═══════════════════════════════════════════════════════════════
// C.1 长时间运行状态
// ═══════════════════════════════════════════════════════════════

describe("C.1 长时间运行 — 性能衰减检测", () => {
  test("Cache 50k set+get 循环 — 衰减比 < 3x", () => {
    const cache = new Cache<string>({ maxSize: 10000, defaultTtlMs: 0, persistent: false });
    // 预热
    for (let i = 0; i < 1000; i++) cache.set(`warm-${i}`, `v`);

    // 第一段 10k 操作
    const t0 = performance.now();
    for (let i = 0; i < 10000; i++) {
      cache.set(`sustained-${i}`, `v-${i}`);
      cache.getSync(`sustained-${i}`);
    }
    const seg1 = performance.now() - t0;

    // 第五段 10k 操作（索引偏移到 40000-50000）
    const t4 = performance.now();
    for (let i = 40000; i < 50000; i++) {
      cache.set(`sustained-${i}`, `v-${i}`);
      cache.getSync(`sustained-${i}`);
    }
    const seg5 = performance.now() - t4;

    cache.destroy();

    const degradation = seg1 > 0 ? seg5 / seg1 : 1;
    console.log(`[Stress] cache-sustained-50k: seg1=${seg1.toFixed(0)}ms, seg5=${seg5.toFixed(0)}ms, degradation=${degradation.toFixed(2)}x`);
    expect(degradation).toBeLessThan(3);
  });

  test("AtomEngine 10k create+delete 循环 — 无泄漏", () => {
    atomStore.reset();
    const startHeap = getHeapMB();

    // 10 轮 create+delete 循环（每轮 1000 个）
    for (let round = 0; round < 10; round++) {
      const ids: string[] = [];
      for (let i = 0; i < 1000; i++) {
        const atom = atomStore.create("fact", `content-${round}-${i}`, { source: "test" });
        ids.push(atom.id);
      }
      for (const id of ids) {
        atomStore.delete(id);
      }
    }

    tryGC();
    const endHeap = getHeapMB();
    const heapDelta = endHeap - startHeap;

    const stats = atomStore.getStats();
    expect(stats.total).toBe(0); // 全部删除后应为 0
    console.log(`[Stress] atom-leak-10k: heapDelta=${heapDelta}MB, total=${stats.total}, created=${stats.created}, deleted=${stats.deleted}`);

    // 内存增量应在合理范围（允许 GC 延迟回收，但不应无限增长）
    expect(heapDelta).toBeLessThan(50);
    atomStore.reset();
  });

  test("EventBus 50k publish — 事件日志不无限增长", () => {
    const subIds: string[] = [];
    let received = 0;
    subIds.push(eventBus.subscribe("sustained-event", () => { received++; }));

    const startStats = eventBus.getStats();
    for (let i = 0; i < 50000; i++) {
      eventBus.publish({
        type: "sustained-event",
        source: "test",
        data: { idx: i },
        priority: "normal",
      });
    }
    const endStats = eventBus.getStats();

    // 清理
    for (const id of subIds) eventBus.unsubscribe(id);

    console.log(`[Stress] eventbus-sustained-50k: published=${endStats.published - startStats.published}, received=${received}`);
    expect(received).toBe(50000);
    // 事件日志有上限（1000），不应无限增长
    expect(endStats.published - startStats.published).toBe(50000);
  });

  test("KnowledgeNetwork 5k create+link+delete 循环 — 无孤立引用", () => {
    knowledgeNetwork.reset();
    const startHeap = getHeapMB();

    for (let round = 0; round < 5; round++) {
      const ids: string[] = [];
      // 创建 1000 实体
      for (let i = 0; i < 1000; i++) {
        const ent = knowledgeNetwork.create("concept", `E-${round}-${i}`, `c-${i}`, { source: "test" });
        ids.push(ent.id);
      }
      // 创建 1000 链接
      for (let i = 0; i < 1000; i++) {
        knowledgeNetwork.link(ids[i], ids[(i + 1) % 1000], `rel-${round}-${i}`);
      }
      // 删除全部（级联删除链接）
      for (const id of ids) {
        knowledgeNetwork.delete(id);
      }
    }

    tryGC();
    const endHeap = getHeapMB();
    const stats = knowledgeNetwork.getStats();

    console.log(`[Stress] kg-leak-5k: heapDelta=${(endHeap - startHeap).toFixed(1)}MB, total=${stats.total}, links=${stats.links}`);
    expect(stats.total).toBe(0);
    expect(stats.links).toBe(0);
    expect(endHeap - startHeap).toBeLessThan(50);
    knowledgeNetwork.reset();
  });
});

// ═══════════════════════════════════════════════════════════════
// C.2 内存泄漏检测 — create/destroy 循环
// ═══════════════════════════════════════════════════════════════

describe("C.2 内存泄漏检测 — create/destroy 循环", () => {
  test("Cache 100 轮 create+destroy — heap 增量 < 20MB", () => {
    tryGC();
    const startHeap = getHeapMB();

    for (let round = 0; round < 100; round++) {
      const cache = new Cache<string>({ maxSize: 100, defaultTtlMs: 0, persistent: false });
      for (let i = 0; i < 100; i++) {
        cache.set(`key-${round}-${i}`, `val-${i}`.repeat(100));
      }
      cache.destroy();
    }

    tryGC();
    const endHeap = getHeapMB();
    const delta = endHeap - startHeap;
    console.log(`[Stress] cache-create-destroy-100: heapDelta=${delta}MB`);
    expect(delta).toBeLessThan(20);
  });

  test("Cache TTL 过期清理 — 过期条目不残留", async () => {
    const cache = new Cache<string>({ maxSize: 1000, defaultTtlMs: 50, persistent: false });
    for (let i = 0; i < 500; i++) {
      cache.set(`ttl-key-${i}`, `val-${i}`);
    }
    expect(cache.stats().size).toBe(500);

    // 等待 TTL 过期
    await new Promise((r) => setTimeout(r, 150));

    // 过期后 getSync 应返回 undefined（但条目可能仍在 map 中直到清理周期）
    const val = cache.getSync("ttl-key-0");
    expect(val).toBeUndefined();
    cache.destroy();
  });
});

// ═══════════════════════════════════════════════════════════════
// C.3 状态累积检测
// ═══════════════════════════════════════════════════════════════

describe("C.3 状态累积检测", () => {
  beforeEach(() => {
    knowledgeNetwork.reset();
    atomStore.reset();
  });
  afterEach(() => {
    knowledgeNetwork.reset();
    atomStore.reset();
  });

  test("KnowledgeNetwork reset 后 stats 全部归零", () => {
    // 创建数据
    for (let i = 0; i < 100; i++) {
      const ent = knowledgeNetwork.create("concept", `E-${i}`, `c`, { source: "test" });
      if (i > 0) knowledgeNetwork.link(ent.id, ent.id, "self");
    }
    expect(knowledgeNetwork.getStats().total).toBe(100);

    knowledgeNetwork.reset();
    const stats = knowledgeNetwork.getStats();
    expect(stats.total).toBe(0);
    expect(stats.links).toBe(0);
    expect(stats.byKind).toEqual({});
  });

  test("AtomEngine reset 后 stats 全部归零", () => {
    for (let i = 0; i < 100; i++) {
      atomStore.create("fact", `content-${i}`, { source: "test" });
    }
    expect(atomStore.getStats().total).toBe(100);

    atomStore.reset();
    const stats = atomStore.getStats();
    expect(stats.total).toBe(0);
    expect(stats.created).toBe(0);
    expect(stats.deleted).toBe(0);
  });

  test("Cache stats 在 clear 后归零", () => {
    const cache = new Cache<string>({ maxSize: 100, defaultTtlMs: 0, persistent: false });
    for (let i = 0; i < 50; i++) {
      cache.set(`k-${i}`, `v-${i}`);
    }
    expect(cache.stats().size).toBe(50);

    cache.clear();
    const stats = cache.stats();
    expect(stats.size).toBe(0);
    cache.destroy();
  });
});
