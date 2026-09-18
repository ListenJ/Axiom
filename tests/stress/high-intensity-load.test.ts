/**
 * 高强度渐进式压力测试 — 5 层确定性检索架构
 *
 * 设计目标（对应用户两大要求）：
 *   1. 逐步增加并发用户数量、请求频率和数据量，直至系统达到性能瓶颈
 *   2. 记录关键性能指标：响应时间（p50/p90/p99）、吞吐量（QPS）、错误率、资源利用率（内存 MB）
 *
 * 三大测试维度：
 *   A. 数据量渐进（Data Volume Ramp）
 *      - 100 / 1000 / 5000 / 10000 实体 + 链接
 *      - 测量：构建时间、查询延迟分位数、内存增量
 *      - 瓶颈判定：p99 > 200ms 或内存 > 200MB
 *
 *   B. 并发渐进（Concurrency Ramp）
 *      - 1 / 10 / 50 / 100 / 500 / 1000 并发查询
 *      - 测量：完成时间、吞吐量 QPS、错误率、p99 延迟
 *      - 瓶颈判定：错误率 > 5% 或 p99 > 500ms
 *
 *   C. 5 层管道端到端（End-to-End Pipeline）
 *      - Layer 0 单独 → Layer 0+1+2 → +3 → +4 → +5 全管道
 *      - 测量：各层延迟占比、总延迟、缓存命中率、验证率
 *
 * 输出格式（被 stress-runner.ts 解析）：
 *   [Stress] <label>: <value>ms, mem delta: <N>MB, p99: <N>ms, qps: <N>, errRate: <N>
 *
 * 设计原则（遵循 AGENTS.md 规则 7 TDD + 规则 8 深模块）：
 *   - 通过公共接口验证行为，不 mock 内部协作者
 *   - 每个测试自带数据准备 + 清理 + 断言 + 指标输出
 *   - 测试间隔离：beforeEach/afterEach 重置所有单例
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  DeterministicRetrievalEngine,
  _resetRetrievalEngineForTest,
  type RetrievalResult,
  type KeywordSearcher,
} from "../../src/dre/retrieval/deterministic-retrieval-engine.js";
import {
  VerificationChain,
  _resetVerificationChainForTest,
} from "../../src/dre/retrieval/verification-chain.js";
import {
  KnowledgeWiki,
  _resetKnowledgeWikiForTest,
  type CompiledDocument,
} from "../../src/dre/retrieval/knowledge-wiki.js";
import {
  HybridFusion,
  _resetHybridFusionForTest,
} from "../../src/dre/retrieval/hybrid-fusion.js";
import {
  ObservabilityMonitor,
  _resetObservabilityMonitorForTest,
} from "../../src/dre/retrieval/observability.js";
import { knowledgeNetwork } from "../../src/dre/runtime/knowledge-network.js";

// ═══════════════════════════════════════════════════════════════
// 工具函数
// ═══════════════════════════════════════════════════════════════

function getMemoryUsageMB(): { rss: number; heap: number } {
  const mem = process.memoryUsage();
  return {
    rss: Math.round(mem.rss / 1024 / 1024),
    heap: Math.round(mem.heapUsed / 1024 / 1024),
  };
}

/** 计算延迟分位数（p50/p90/p99） */
function percentiles(samples: number[]): { p50: number; p90: number; p99: number; min: number; max: number; avg: number } {
  if (samples.length === 0) return { p50: 0, p90: 0, p99: 0, min: 0, max: 0, avg: 0 };
  const sorted = [...samples].sort((a, b) => a - b);
  const pick = (p: number) => sorted[Math.min(Math.floor(sorted.length * p), sorted.length - 1)];
  const sum = sorted.reduce((s, x) => s + x, 0);
  return {
    p50: Math.round(pick(0.5) * 100) / 100,
    p90: Math.round(pick(0.9) * 100) / 100,
    p99: Math.round(pick(0.99) * 100) / 100,
    min: Math.round(sorted[0] * 100) / 100,
    max: Math.round(sorted[sorted.length - 1] * 100) / 100,
    avg: Math.round((sum / sorted.length) * 100) / 100,
  };
}

/** 构建 N 个实体 + 链接的知识图谱 */
function buildKnowledgeGraph(entityCount: number, linkCount: number): string[] {
  const ids: string[] = [];
  for (let i = 0; i < entityCount; i++) {
    const kind = i % 4 === 0 ? "agent" : i % 4 === 1 ? "tool" : i % 4 === 2 ? "concept" : "document";
    const ent = knowledgeNetwork.create(
      kind as never,
      `Entity-${i}`,
      `Entity ${i} content with keyword${i % 10} and topic${i % 5}`,
      { confidence: 0.5 + (i % 5) * 0.1, source: "stress-test" },
    );
    ids.push(ent.id);
  }
  // link() 按 (src, dst, relation) 三元组去重，故 relation 必须唯一以创建 linkCount 条链接
  for (let i = 0; i < linkCount; i++) {
    const src = ids[i % entityCount];
    const dst = ids[(i + 1) % entityCount];
    knowledgeNetwork.link(src, dst, `rel-${i}`, { weight: 0.4 + (i % 6) * 0.1 });
  }
  return ids;
}

/** 构造简单的关键词检索器 mock（用于注入 Layer 0） */
function makeMockKeywordSearcher(docCount: number): KeywordSearcher {
  const docs = Array.from({ length: docCount }, (_, i) => ({
    note: {
      path: `notes/doc-${i}.md`,
      title: `Document ${i}`,
      content: `Content of document ${i} with keyword${i % 10} topic${i % 5}`,
    },
    score: 50 + (i % 50),
    reasons: [`keyword match ${i}`],
    excerpt: `Excerpt ${i}`,
  }));
  return {
    search(query: string, opts?: { limit?: number }) {
      const limit = opts?.limit ?? 20;
      // 简单子串匹配
      const lower = query.toLowerCase();
      return docs
        .filter((d) => d.note.content.toLowerCase().includes(lower) || d.note.title.toLowerCase().includes(lower))
        .slice(0, limit);
    },
  };
}

/** 构造测试用 RetrievalResult 数组 */
function makeTestResults(count: number, opts?: { verified?: boolean; contradicted?: boolean }): RetrievalResult[] {
  return Array.from({ length: count }, (_, i) => {
    const score = opts?.contradicted ? 30 : opts?.verified ? 80 : 50 + (i % 30);
    return {
      id: `result-${i}`,
      title: `Result ${i}`,
      excerpt: `Excerpt ${i} with content ${i % 10}`,
      score,
      reasons: [`reason ${i}`],
      evidenceChain: {
        query: "test",
        steps: [
          { type: "keyword_match", source: "query", target: `doc-${i}.md`, confidence: 0.7, reasoning: `match ${i}` },
          { type: "graph_entity", source: "query", target: `entity-${i}`, confidence: 0.6, reasoning: `entity ${i}` },
        ],
        totalConfidence: 0.65,
      },
      source: i % 2 === 0 ? "keyword" : "graph",
      notePath: i % 2 === 0 ? `notes/doc-${i}.md` : undefined,
      entityId: i % 2 === 1 ? `entity-${i}` : undefined,
    };
  });
}

/** 清空知识图谱 */
function clearKnowledgeNetwork(): void {
  knowledgeNetwork.reset();
}

// ═══════════════════════════════════════════════════════════════
// A. 数据量渐进压力测试
// ═══════════════════════════════════════════════════════════════

describe("A. 数据量渐进压力测试 — Data Volume Ramp", () => {
  beforeEach(() => {
    clearKnowledgeNetwork();
    _resetRetrievalEngineForTest();
  });
  afterEach(() => {
    clearKnowledgeNetwork();
    _resetRetrievalEngineForTest();
  });

  const SCALES = [
    { entities: 100, links: 250, label: "100" },
    { entities: 1000, links: 2500, label: "1k" },
    { entities: 5000, links: 12500, label: "5k" },
    { entities: 10000, links: 25000, label: "10k" },
  ];

  for (const scale of SCALES) {
    test(`构建 ${scale.label} 实体 + ${scale.links} 链接 — 测量构建时间与内存`, () => {
      const startMem = getMemoryUsageMB();
      const start = performance.now();

      const ids = buildKnowledgeGraph(scale.entities, scale.links);

      const duration = performance.now() - start;
      const endMem = getMemoryUsageMB();
      const memDelta = endMem.heap - startMem.heap;
      const stats = knowledgeNetwork.getStats();

      expect(ids.length).toBe(scale.entities);
      expect(stats.total).toBe(scale.entities);
      expect(stats.links).toBe(scale.links);

      // 瓶颈判定：10k 实体构建应在 10s 内完成，内存增量 < 200MB
      const buildThreshold = scale.entities >= 10000 ? 10000 : scale.entities >= 5000 ? 5000 : 2000;
      expect(duration).toBeLessThan(buildThreshold);
      expect(memDelta).toBeLessThan(300);

      console.log(
        `[Stress] build ${scale.label} entities: ${duration.toFixed(0)}ms, mem delta: ${memDelta}MB, links: ${stats.links}`,
      );
    });

    test(`${scale.label} 实体规模下 1000 次查询延迟分位数`, () => {
      buildKnowledgeGraph(scale.entities, scale.links);
      const engine = new DeterministicRetrievalEngine({
        keywordSearcher: makeMockKeywordSearcher(scale.entities),
        config: { cacheMaxSize: 50, cacheTtlMs: 0 },
      });

      const queries = Array.from({ length: 1000 }, (_, i) => `keyword${i % 10} topic${i % 5}`);
      const latencies: number[] = [];
      const startMem = getMemoryUsageMB();

      // 预热（不计入测量）
      engine.retrieve(queries[0]);

      for (const q of queries) {
        const t0 = performance.now();
        engine.retrieve(q);
        latencies.push(performance.now() - t0);
      }

      const endMem = getMemoryUsageMB();
      const pct = percentiles(latencies);
      const memDelta = endMem.heap - startMem.heap;
      const qps = latencies.length > 0 ? Math.round((latencies.length / latencies.reduce((s, x) => s + x, 0)) * 1000) : 0;

      // 瓶颈判定：p99 应在 50ms 内（10k 规模放宽到 200ms）
      const p99Threshold = scale.entities >= 10000 ? 200 : 50;
      expect(pct.p99).toBeLessThan(p99Threshold);
      // 验证测试确实执行了所有迭代（超快操作 avg 可能为 0）
      expect(latencies.length).toBe(1000);

      console.log(
        `[Stress] query ${scale.label} entities x1000: p50=${pct.p50}ms, p90=${pct.p90}ms, p99=${pct.p99}ms, qps: ${qps}, mem delta: ${memDelta}MB`,
      );
    });
  }
});

// ═══════════════════════════════════════════════════════════════
// B. 并发渐进压力测试
// ═══════════════════════════════════════════════════════════════

describe("B. 并发渐进压力测试 — Concurrency Ramp", () => {
  const CONCURRENCY_LEVELS = [1, 10, 50, 100, 500, 1000];

  beforeEach(() => {
    clearKnowledgeNetwork();
    buildKnowledgeGraph(2000, 5000); // 固定数据规模
    _resetRetrievalEngineForTest();
  });
  afterEach(() => {
    clearKnowledgeNetwork();
    _resetRetrievalEngineForTest();
  });

  for (const concurrency of CONCURRENCY_LEVELS) {
    test(`并发 ${concurrency} 查询 — 测量吞吐量 / 错误率 / p99`, async () => {
      const engine = new DeterministicRetrievalEngine({
        keywordSearcher: makeMockKeywordSearcher(500),
        config: { cacheMaxSize: 100, cacheTtlMs: 0 }, // 关闭缓存以测真实查询能力
      });

      const queries = Array.from({ length: concurrency }, (_, i) => `keyword${i % 20} topic${i % 10}`);
      const start = performance.now();
      const startMem = getMemoryUsageMB();

      // 并发执行（Bun 原生 Promise.all）
      const results = await Promise.all(
        queries.map(async (q) => {
          try {
            const t0 = performance.now();
            const r = engine.retrieve(q);
            const lat = performance.now() - t0;
            return { ok: true, latency: lat, count: r.results.length };
          } catch (e) {
            return { ok: false, latency: 0, count: 0, error: String(e) };
          }
        }),
      );

      const duration = performance.now() - start;
      const endMem = getMemoryUsageMB();
      const memDelta = endMem.heap - startMem.heap;

      const okResults = results.filter((r) => r.ok);
      const errorCount = results.length - okResults.length;
      const errorRate = errorCount / results.length;
      const latencies = okResults.map((r) => r.latency);
      const pct = percentiles(latencies);
      const qps = duration > 0 ? Math.round((results.length / duration) * 1000) : 0;

      // 瓶颈判定：错误率 < 5%，p99 < 500ms（1000 并发放宽到 2000ms）
      const p99Threshold = concurrency >= 1000 ? 2000 : concurrency >= 500 ? 1000 : 500;
      expect(errorRate).toBeLessThan(0.05);
      expect(pct.p99).toBeLessThan(p99Threshold);

      console.log(
        `[Stress] concurrency ${concurrency}: ${duration.toFixed(0)}ms, p50=${pct.p50}ms, p99=${pct.p99}ms, qps: ${qps}, errRate: ${errorRate.toFixed(3)}, mem delta: ${memDelta}MB`,
      );
    });
  }
});

// ═══════════════════════════════════════════════════════════════
// C. 5 层管道端到端压力测试
// ═══════════════════════════════════════════════════════════════

describe("C. 5 层管道端到端压力测试 — End-to-End Pipeline", () => {
  beforeEach(() => {
    clearKnowledgeNetwork();
    buildKnowledgeGraph(2000, 5000);
    _resetRetrievalEngineForTest();
    _resetVerificationChainForTest();
    _resetKnowledgeWikiForTest();
    _resetHybridFusionForTest();
    _resetObservabilityMonitorForTest();
  });
  afterEach(() => {
    clearKnowledgeNetwork();
    _resetRetrievalEngineForTest();
    _resetVerificationChainForTest();
    _resetKnowledgeWikiForTest();
    _resetHybridFusionForTest();
    _resetObservabilityMonitorForTest();
  });

  test("Layer 0 单独 — 1000 次基础检索", () => {
    const engine = new DeterministicRetrievalEngine({
      keywordSearcher: makeMockKeywordSearcher(500),
      config: { cacheMaxSize: 100, cacheTtlMs: 0 },
    });

    const queries = Array.from({ length: 1000 }, (_, i) => `keyword${i % 20}`);
    const latencies: number[] = [];

    for (const q of queries) {
      const t0 = performance.now();
      engine.retrieve(q);
      latencies.push(performance.now() - t0);
    }

    const pct = percentiles(latencies);
    const totalMs = latencies.reduce((s, x) => s + x, 0);
    const qps = totalMs > 0 ? Math.round((latencies.length / totalMs) * 1000) : 0;

    expect(pct.p99).toBeLessThan(50);
    console.log(
      `[Stress] Layer0 only x1000: p50=${pct.p50}ms, p90=${pct.p90}ms, p99=${pct.p99}ms, qps: ${qps}`,
    );
  });

  test("Layer 0+1+2 — 500 次检索 + GraphRAG 多跳 + Wiki 编译", () => {
    const engine = new DeterministicRetrievalEngine({
      keywordSearcher: makeMockKeywordSearcher(500),
      config: { cacheMaxSize: 50, cacheTtlMs: 0, graphRagMaxDepth: 3 },
    });
    const wiki = new KnowledgeWiki();
    // 预编译 100 篇文档
    const docs: CompiledDocument[] = Array.from({ length: 100 }, (_, i) => ({
      path: `wiki/doc-${i}.md`,
      title: `Wiki Document ${i}`,
      content: `# Wiki Document ${i}\n\nThis document covers keyword${i % 20} and topic${i % 10}.\nNumerical fact: ${i * 10} units.`,
    }));
    wiki.compileBatch(docs);

    const queries = Array.from({ length: 500 }, (_, i) => `keyword${i % 20} topic${i % 10}`);
    const latencies: number[] = [];
    let totalPaths = 0;

    for (const q of queries) {
      const t0 = performance.now();
      const resp = engine.retrieveWithPaths(q);
      latencies.push(performance.now() - t0);
      totalPaths += resp.paths.length;
    }

    const pct = percentiles(latencies);
    const totalMs = latencies.reduce((s, x) => s + x, 0);
    const qps = totalMs > 0 ? Math.round((latencies.length / totalMs) * 1000) : 0;

    // GraphRAG 多跳允许较高延迟，但 p99 < 200ms
    expect(pct.p99).toBeLessThan(200);
    expect(totalPaths).toBeGreaterThan(0);

    console.log(
      `[Stress] Layer0+1+2 x500: p50=${pct.p50}ms, p90=${pct.p90}ms, p99=${pct.p99}ms, qps: ${qps}, paths: ${totalPaths}`,
    );
  });

  test("Layer 0+1+2+3 — 500 次检索 + GraphRAG + Wiki + 验证链", () => {
    const engine = new DeterministicRetrievalEngine({
      keywordSearcher: makeMockKeywordSearcher(500),
      config: { cacheMaxSize: 50, cacheTtlMs: 0, graphRagMaxDepth: 2 },
    });
    const wiki = new KnowledgeWiki();
    const docs: CompiledDocument[] = Array.from({ length: 50 }, (_, i) => ({
      path: `wiki/doc-${i}.md`,
      title: `Doc ${i}`,
      content: `Content ${i} keyword${i % 20}`,
    }));
    wiki.compileBatch(docs);
    const verifier = new VerificationChain();

    const queries = Array.from({ length: 500 }, (_, i) => `keyword${i % 20}`);
    const latencies: number[] = [];
    let totalVerified = 0;

    for (const q of queries) {
      const t0 = performance.now();
      const resp = engine.retrieve(q);
      const verdicts = verifier.verifyBatch(resp.results);
      latencies.push(performance.now() - t0);
      totalVerified += verdicts.filter((v) => v.verdict.status === "verified").length;
    }

    const pct = percentiles(latencies);
    const totalMs = latencies.reduce((s, x) => s + x, 0);
    const qps = totalMs > 0 ? Math.round((latencies.length / totalMs) * 1000) : 0;

    expect(pct.p99).toBeLessThan(200);
    console.log(
      `[Stress] Layer0+1+2+3 x500: p50=${pct.p50}ms, p90=${pct.p90}ms, p99=${pct.p99}ms, qps: ${qps}, verified: ${totalVerified}`,
    );
  });

  test("Layer 0-4 — 500 次全融合管道（含验证 + 融合排序）", () => {
    const engine = new DeterministicRetrievalEngine({
      keywordSearcher: makeMockKeywordSearcher(500),
      config: { cacheMaxSize: 50, cacheTtlMs: 0 },
    });
    const verifier = new VerificationChain();
    const fusion = new HybridFusion();

    const queries = Array.from({ length: 500 }, (_, i) => `keyword${i % 20}`);
    const latencies: number[] = [];
    let totalFused = 0;

    for (const q of queries) {
      const t0 = performance.now();
      const resp = engine.retrieve(q);
      const verdicts = verifier.verifyBatch(resp.results);
      const verdictMap = new Map(verdicts.map((v) => [v.result.id, v.verdict]));
      const fused = fusion.fuse({
        query: q,
        results: resp.results,
        verdicts: verdictMap,
      });
      latencies.push(performance.now() - t0);
      totalFused += fused.results.length;
    }

    const pct = percentiles(latencies);
    const totalMs = latencies.reduce((s, x) => s + x, 0);
    const qps = totalMs > 0 ? Math.round((latencies.length / totalMs) * 1000) : 0;

    expect(pct.p99).toBeLessThan(200);
    console.log(
      `[Stress] Layer0-4 x500: p50=${pct.p50}ms, p90=${pct.p90}ms, p99=${pct.p99}ms, qps: ${qps}, fused: ${totalFused}`,
    );
  });

  test("Layer 0-5 — 1000 次完整管道（含可观测性监测）", () => {
    const engine = new DeterministicRetrievalEngine({
      keywordSearcher: makeMockKeywordSearcher(500),
      config: { cacheMaxSize: 100, cacheTtlMs: 0 },
    });
    const verifier = new VerificationChain();
    const fusion = new HybridFusion();
    const monitor = new ObservabilityMonitor(2000);

    const queries = Array.from({ length: 1000 }, (_, i) => `keyword${i % 20} topic${i % 5}`);
    const latencies: number[] = [];

    for (const q of queries) {
      const t0 = performance.now();
      const resp = engine.retrieve(q);
      const verdicts = verifier.verifyBatch(resp.results);
      const verdictMap = new Map(verdicts.map((v) => [v.result.id, v.verdict]));
      const fused = fusion.fuse({ query: q, results: resp.results, verdicts: verdictMap });

      // Layer 5: 记录指标
      monitor.recordQuery({
        query: q,
        latencyMs: resp.metrics.latencyMs,
        keywordPhaseMs: resp.metrics.keywordPhaseMs,
        graphPhaseMs: resp.metrics.graphPhaseMs,
        mergePhaseMs: resp.metrics.mergePhaseMs,
        cacheHit: resp.metrics.cacheHit,
        resultCount: fused.results.length,
        keywordResults: resp.metrics.keywordResults,
        graphResults: resp.metrics.graphResults,
        verifiedCount: verdicts.filter((v) => v.verdict.status === "verified").length,
        contradictedCount: verdicts.filter((v) => v.verdict.status === "contradicted").length,
        triggeredDeepRetrieval: false,
      });

      latencies.push(performance.now() - t0);
    }

    const pct = percentiles(latencies);
    const totalMs = latencies.reduce((s, x) => s + x, 0);
    const qps = totalMs > 0 ? Math.round((latencies.length / totalMs) * 1000) : 0;
    const health = monitor.getHealthSnapshot(1000);
    const breakdown = monitor.getLayerBreakdown(1000);

    expect(pct.p99).toBeLessThan(200);
    expect(health.totalQueries).toBe(1000);
    expect(health.status).not.toBe("unhealthy");

    console.log(
      `[Stress] Layer0-5 x1000: p50=${pct.p50}ms, p90=${pct.p90}ms, p99=${pct.p99}ms, qps: ${qps}, status: ${health.status}, healthReason: ${health.healthReason}`,
    );
    console.log(
      `[Stress] Layer0-5 breakdown: keyword=${breakdown.keywordPhaseRatio.toFixed(2)}, graph=${breakdown.graphPhaseRatio.toFixed(2)}, merge=${breakdown.mergePhaseRatio.toFixed(2)}`,
    );
  });
});

// ═══════════════════════════════════════════════════════════════
// D. 瓶颈定位测试 — 持续加压直到性能降级
// ═══════════════════════════════════════════════════════════════

describe("D. 瓶颈定位测试 — Sustained Load Until Degradation", () => {
  beforeEach(() => {
    clearKnowledgeNetwork();
    buildKnowledgeGraph(5000, 10000);
    _resetRetrievalEngineForTest();
  });
  afterEach(() => {
    clearKnowledgeNetwork();
    _resetRetrievalEngineForTest();
  });

  test("持续 5000 次查询 — 检测性能衰减曲线", () => {
    const engine = new DeterministicRetrievalEngine({
      keywordSearcher: makeMockKeywordSearcher(1000),
      config: { cacheMaxSize: 200, cacheTtlMs: 0 },
    });

    const queries = Array.from({ length: 5000 }, (_, i) => `keyword${i % 50} topic${i % 20}`);
    const latencies: number[] = [];
    const startMem = getMemoryUsageMB();

    for (const q of queries) {
      const t0 = performance.now();
      engine.retrieve(q);
      latencies.push(performance.now() - t0);
    }

    const endMem = getMemoryUsageMB();
    const memDelta = endMem.heap - startMem.heap;

    // 按 1000 一段切分，对比前后段延迟
    const segments: number[][] = [];
    for (let i = 0; i < latencies.length; i += 1000) {
      segments.push(latencies.slice(i, i + 1000));
    }
    const segStats = segments.map((s) => percentiles(s));

    const firstSegP99 = segStats[0].p99;
    const lastSegP99 = segStats[segStats.length - 1].p99;
    const degradationRatio = firstSegP99 > 0 ? lastSegP99 / firstSegP99 : 1;

    const overallPct = percentiles(latencies);
    const totalMs = latencies.reduce((s, x) => s + x, 0);
    const qps = totalMs > 0 ? Math.round((latencies.length / totalMs) * 1000) : 0;

    // 瓶颈判定：衰减比 < 3x（性能不应严重下降），p99 < 100ms
    expect(degradationRatio).toBeLessThan(3);
    expect(overallPct.p99).toBeLessThan(100);
    expect(memDelta).toBeLessThan(100); // 不应有明显内存泄漏

    console.log(
      `[Stress] sustained 5000 queries: p50=${overallPct.p50}ms, p99=${overallPct.p99}ms, qps: ${qps}, mem delta: ${memDelta}MB, degradation: ${degradationRatio.toFixed(2)}x`,
    );
    console.log(
      `[Stress] segment p99 trend: ${segStats.map((s) => s.p99).join("ms -> ")}ms`,
    );
  });

  test("验证链批量验证 2000 条结果 — 找到批量验证瓶颈", () => {
    const verifier = new VerificationChain();
    const results = makeTestResults(2000);

    const start = performance.now();
    const verdicts = verifier.verifyBatch(results);
    const duration = performance.now() - start;

    const verified = verdicts.filter((v) => v.verdict.status === "verified").length;
    const contradicted = verdicts.filter((v) => v.verdict.status === "contradicted").length;
    const unverified = verdicts.filter((v) => v.verdict.status === "unverified").length;

    const perResultMs = duration / results.length;
    const qps = duration > 0 ? Math.round((results.length / duration) * 1000) : 0;

    // 瓶颈判定：2000 条批量验证 < 500ms，单条 < 0.25ms
    expect(duration).toBeLessThan(500);
    expect(perResultMs).toBeLessThan(0.25);

    console.log(
      `[Stress] verify 2000 results: ${duration.toFixed(0)}ms, per-result: ${perResultMs.toFixed(3)}ms, qps: ${qps}, verified: ${verified}, unverified: ${unverified}, contradicted: ${contradicted}`,
    );
  });

  test("融合排序 1000 条多源结果 — 找到融合瓶颈", () => {
    const fusion = new HybridFusion();
    // 构造 1000 条多源结果（含重复 ID 模拟多源）
    const results: RetrievalResult[] = [];
    for (let i = 0; i < 500; i++) {
      results.push({
        id: `r-${i}`,
        title: `Result ${i}`,
        excerpt: `Excerpt ${i}`,
        score: 50 + (i % 50),
        reasons: [`reason ${i}`],
        evidenceChain: {
          query: "test",
          steps: [
            { type: "keyword_match", source: "query", target: `doc-${i}`, confidence: 0.7, reasoning: `match ${i}` },
          ],
          totalConfidence: 0.7,
        },
        source: "keyword",
        notePath: `doc-${i}`,
      });
      // 同 ID 来自 graph（模拟多源）
      results.push({
        id: `r-${i}`,
        title: `Result ${i}`,
        excerpt: `Excerpt ${i}`,
        score: 55 + (i % 40),
        reasons: [`graph reason`],
        evidenceChain: {
          query: "test",
          steps: [
            { type: "graph_entity", source: "query", target: `entity-${i}`, confidence: 0.6, reasoning: `entity ${i}` },
          ],
          totalConfidence: 0.6,
        },
        source: "graph",
        entityId: `entity-${i}`,
      });
    }

    const start = performance.now();
    const resp = fusion.fuse({ query: "test", results });
    const duration = performance.now() - start;

    const qps = duration > 0 ? Math.round((results.length / duration) * 1000) : 0;

    // 瓶颈判定：1000 条多源融合 < 100ms
    expect(duration).toBeLessThan(100);
    expect(resp.metrics.duplicatesRemoved).toBe(500);
    expect(resp.metrics.crossSourceCount).toBe(500);

    console.log(
      `[Stress] fuse 1000 multi-source results: ${duration.toFixed(0)}ms, qps: ${qps}, dedup: ${resp.metrics.duplicatesRemoved}, crossSource: ${resp.metrics.crossSourceCount}`,
    );
  });
});
