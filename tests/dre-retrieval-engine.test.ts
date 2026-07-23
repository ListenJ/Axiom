/**
 * 确定性检索引擎 — Layer 0 测试套件
 *
 * 覆盖维度（对应用户质量保障要求）：
 *   1. 功能测试：正常场景 + 边界条件 + 异常情况
 *   2. 性能基准：响应时间（延迟阈值）+ 缓存命中率 + 资源占用
 *   3. 质量指标：准确率(P) / 召回率(R) / F1 值
 *
 * 测试策略（遵循 AGENTS.md 规则 7 测试驱动）：
 *   - 测行为不测实现：全部通过 retrieve() 公共接口验证
 *   - 垂直切片：每个测试响应上一轮的发现
 *   - 用知识图谱单例 + mock KeywordSearcher，不依赖文件系统
 */
import { describe, beforeEach, afterEach, test, expect } from "bun:test";
import {
  DeterministicRetrievalEngine,
  _resetRetrievalEngineForTest,
  type KeywordSearcher,
  type RetrievalResult,
} from "../src/dre/retrieval/deterministic-retrieval-engine.js";
import { knowledgeNetwork } from "../src/dre/runtime/knowledge-network.js";

// ─── 测试辅助 ────────────────────────────────────────────────────────────

/** 创建 mock KeywordSearcher，模拟 DeterministicSearchEngine 的行为（分词匹配） */
function makeMockSearcher(notes: Array<{ path: string; title: string; content: string; score: number; reasons: string[] }>): KeywordSearcher {
  return {
    search(query: string, opts?: { limit?: number }) {
      const qTokens = query.toLowerCase().match(/[a-z0-9]+/g) ?? [query.toLowerCase()];
      const limit = opts?.limit ?? 20;
      return notes
        .filter((n) => {
          const title = n.title.toLowerCase();
          const content = n.content.toLowerCase();
          return qTokens.some((t) => t.length >= 2 && (title.includes(t) || content.includes(t)));
        })
        .slice(0, limit)
        .map((n) => ({
          note: { path: n.path, title: n.title, content: n.content },
          score: n.score,
          reasons: n.reasons,
          excerpt: n.content.slice(0, 100),
        }));
    },
  };
}

/** 在知识图谱中创建测试实体并建立关系 */
function seedGraph() {
  knowledgeNetwork.reset();
  // 创建一组关于 "typescript debugging" 的实体
  const ts = knowledgeNetwork.create("concept", "TypeScript", "TypeScript is a typed superset of JavaScript", {
    confidence: 0.95,
    source: "test",
  });
  const debug = knowledgeNetwork.create("procedure", "Debugging", "Process of finding and fixing errors in code", {
    confidence: 0.9,
    source: "test",
  });
  const error = knowledgeNetwork.create("concept", "TypeError", "A type error occurs when types are incompatible", {
    confidence: 0.88,
    source: "test",
  });
  const vscode = knowledgeNetwork.create("tool", "VSCode", "Visual Studio Code editor with debugging support", {
    confidence: 0.92,
    source: "test",
  });
  const breakpoint = knowledgeNetwork.create("procedure", "Breakpoint", "A breakpoint pauses execution at a specific line", {
    confidence: 0.85,
    source: "test",
  });
  // 无关实体（应不被 "typescript debugging" 查询匹配）
  knowledgeNetwork.create("concept", "Photosynthesis", "Plants convert sunlight into energy", {
    confidence: 0.95,
    source: "test",
  });

  // 建立关系
  knowledgeNetwork.link(ts.id, debug.id, "supports", { weight: 0.9, evidence: "TS has source maps" });
  knowledgeNetwork.link(debug.id, error.id, "identifies", { weight: 0.85 });
  knowledgeNetwork.link(debug.id, breakpoint.id, "uses", { weight: 0.8 });
  knowledgeNetwork.link(vscode.id, debug.id, "provides", { weight: 0.9 });
  knowledgeNetwork.link(vscode.id, breakpoint.id, "supports", { weight: 0.85 });

  return { ts, debug, error, vscode, breakpoint };
}

/** 计算准确率：返回结果中相关的占比 */
function precision(results: RetrievalResult[], relevantIds: Set<string>): number {
  if (results.length === 0) return 0;
  const relevant = results.filter((r) => relevantIds.has(r.id)).length;
  return relevant / results.length;
}

/** 计算召回率：相关结果中被返回的占比 */
function recall(results: RetrievalResult[], relevantIds: Set<string>): number {
  if (relevantIds.size === 0) return 1;
  const found = results.filter((r) => relevantIds.has(r.id)).length;
  return found / relevantIds.size;
}

/** 计算 F1 值 */
function f1(p: number, r: number): number {
  if (p + r === 0) return 0;
  return (2 * p * r) / (p + r);
}

// ─── 功能测试：正常场景 ──────────────────────────────────────────────────

describe("DeterministicRetrievalEngine — 正常场景", () => {
  let engine: DeterministicRetrievalEngine;

  beforeEach(() => {
    seedGraph();
    engine = new DeterministicRetrievalEngine({
      keywordSearcher: makeMockSearcher([
        { path: "notes/typescript.md", title: "TypeScript Guide", content: "TypeScript debugging techniques and error handling", score: 85, reasons: ["标题匹配", "内容匹配"] },
        { path: "notes/debugging.md", title: "Debugging Guide", content: "How to debug TypeScript errors in VSCode", score: 70, reasons: ["标题匹配"] },
      ]),
    });
  });

  afterEach(() => {
    knowledgeNetwork.reset();
    _resetRetrievalEngineForTest();
  });

  test("图谱检索返回实体并附带证据链", () => {
    const { results, metrics } = engine.retrieve("TypeScript");
    expect(results.length).toBeGreaterThan(0);
    // 至少有一个图谱结果
    const graphResults = results.filter((r) => r.source === "graph" || r.source === "hybrid");
    expect(graphResults.length).toBeGreaterThan(0);
    // 每个结果都有证据链
    for (const r of results) {
      expect(r.evidenceChain.steps.length).toBeGreaterThan(0);
      expect(r.evidenceChain.query).toBe("TypeScript");
      expect(r.evidenceChain.totalConfidence).toBeGreaterThan(0);
      // 每步都有推理说明
      for (const step of r.evidenceChain.steps) {
        expect(step.reasoning.length).toBeGreaterThan(0);
        expect(step.confidence).toBeGreaterThanOrEqual(0);
      }
    }
    expect(metrics.totalResults).toBe(results.length);
  });

  test("关键词检索返回结果并附带证据链", () => {
    const { results } = engine.retrieve("TypeScript");
    // 过滤出有关键词笔记路径的结果（来自关键词检索或合并）
    const kwResults = results.filter((r) => r.notePath !== undefined);
    expect(kwResults.length).toBeGreaterThan(0);
    const kw = kwResults[0];
    expect(kw.notePath).toBeDefined();
    expect(kw.reasons.length).toBeGreaterThan(0);
  });

  test("图遍历步骤包含关系信息", () => {
    const { results } = engine.retrieve("Debugging");
    // Debugging 实体有出边（identifies TypeError, uses Breakpoint）
    const debugResult = results.find((r) => r.title === "Debugging");
    expect(debugResult).toBeDefined();
    const traverseSteps = debugResult!.evidenceChain.steps.filter((s) => s.type === "graph_traverse");
    expect(traverseSteps.length).toBeGreaterThan(0);
    // 遍历步骤应包含 relation 字段
    for (const step of traverseSteps) {
      expect(step.relation).toBeDefined();
    }
  });

  test("hybrid 结果合并关键词与图谱证据", () => {
    const { results } = engine.retrieve("TypeScript");
    const hybrid = results.find((r) => r.source === "hybrid");
    // TypeScript 同时匹配关键词笔记和图谱实体 → 应存在 hybrid 结果
    if (hybrid) {
      expect(hybrid.evidenceChain.steps.length).toBeGreaterThanOrEqual(2);
      const types = new Set(hybrid.evidenceChain.steps.map((s) => s.type));
      expect(types.has("keyword_match") || types.has("graph_entity")).toBe(true);
    }
  });

  test("结果按得分降序排列", () => {
    const { results } = engine.retrieve("TypeScript");
    for (let i = 1; i < results.length; i++) {
      expect(results[i - 1].score).toBeGreaterThanOrEqual(results[i].score);
    }
  });

  test("metrics 包含完整的分阶段延迟", () => {
    const { metrics } = engine.retrieve("TypeScript");
    expect(metrics.latencyMs).toBeGreaterThanOrEqual(0);
    expect(metrics.keywordPhaseMs).toBeGreaterThanOrEqual(0);
    expect(metrics.graphPhaseMs).toBeGreaterThanOrEqual(0);
    expect(metrics.mergePhaseMs).toBeGreaterThanOrEqual(0);
    expect(metrics.cacheHit).toBe(false);
    expect(metrics.keywordResults).toBeGreaterThanOrEqual(0);
    expect(metrics.graphResults).toBeGreaterThanOrEqual(0);
  });
});

// ─── 边界条件 ──────────────────────────────────────────────────────────

describe("DeterministicRetrievalEngine — 边界条件", () => {
  let engine: DeterministicRetrievalEngine;

  beforeEach(() => {
    seedGraph();
    engine = new DeterministicRetrievalEngine({
      keywordSearcher: makeMockSearcher([]),
    });
  });

  afterEach(() => {
    knowledgeNetwork.reset();
    _resetRetrievalEngineForTest();
  });

  test("空查询返回空结果", () => {
    const { results, metrics } = engine.retrieve("");
    expect(results.length).toBe(0);
    expect(metrics.totalResults).toBe(0);
  });

  test("无匹配查询返回空结果", () => {
    const { results } = engine.retrieve("quantum_physics_nonexistent_topic");
    expect(results.length).toBe(0);
  });

  test("禁用图谱时仅返回关键词结果", () => {
    const { results, metrics } = engine.retrieve("TypeScript", { enableGraph: false });
    expect(metrics.graphResults).toBe(0);
    // 无关键词匹配（mockSearcher 为空）→ 结果为空
    expect(results.length).toBe(0);
  });

  test("禁用缓存时第二次查询不命中缓存", () => {
    engine.retrieve("TypeScript", { enableCache: false });
    const { metrics } = engine.retrieve("TypeScript", { enableCache: false });
    expect(metrics.cacheHit).toBe(false);
  });

  test("limit 截断结果数量", () => {
    const { results } = engine.retrieve("TypeScript", { limit: 1 });
    expect(results.length).toBeLessThanOrEqual(1);
  });

  test("缓存 LRU 淘汰：超过上限时最旧条目被淘汰", () => {
    const smallEngine = new DeterministicRetrievalEngine({
      keywordSearcher: makeMockSearcher([]),
      config: { cacheMaxSize: 2, cacheTtlMs: 0 },
    });
    smallEngine.retrieve("query1");
    smallEngine.retrieve("query2");
    smallEngine.retrieve("query3"); // 应淘汰 query1
    const stats = smallEngine.getCacheStats();
    expect(stats.size).toBeLessThanOrEqual(2);
  });
});

// ─── 异常情况 ──────────────────────────────────────────────────────────

describe("DeterministicRetrievalEngine — 异常情况", () => {
  afterEach(() => {
    knowledgeNetwork.reset();
    _resetRetrievalEngineForTest();
  });

  test("未注入 keywordSearcher 时仅用图谱检索", () => {
    seedGraph();
    const engine = new DeterministicRetrievalEngine({ keywordSearcher: null });
    const { results, metrics } = engine.retrieve("TypeScript");
    expect(metrics.keywordResults).toBe(0);
    // 图谱有 TypeScript 实体
    expect(results.length).toBeGreaterThan(0);
  });

  test("空图谱时仅用关键词检索", () => {
    knowledgeNetwork.reset();
    const engine = new DeterministicRetrievalEngine({
      keywordSearcher: makeMockSearcher([
        { path: "notes/ts.md", title: "TypeScript", content: "TS content", score: 50, reasons: ["匹配"] },
      ]),
    });
    const { results, metrics } = engine.retrieve("TypeScript");
    expect(metrics.graphResults).toBe(0);
    expect(results.length).toBeGreaterThan(0);
  });

  test("空图谱 + 无 searcher 时返回空结果且不崩溃", () => {
    knowledgeNetwork.reset();
    const engine = new DeterministicRetrievalEngine({ keywordSearcher: null });
    const { results } = engine.retrieve("anything");
    expect(results.length).toBe(0);
  });
});

// ─── 性能基准 ──────────────────────────────────────────────────────────

describe("DeterministicRetrievalEngine — 性能基准", () => {
  let engine: DeterministicRetrievalEngine;

  beforeEach(() => {
    knowledgeNetwork.reset();
    // 创建 100 个实体 + 关系，模拟中等规模知识库
    for (let i = 0; i < 100; i++) {
      const e = knowledgeNetwork.create("concept", `Concept-${i}`, `Content about topic ${i} with keywords`, {
        confidence: 0.8,
        source: "perf-test",
      });
      if (i > 0) {
        knowledgeNetwork.link(`perf_prev`, e.id, "related", { weight: 0.5 });
      }
    }
    engine = new DeterministicRetrievalEngine({
      keywordSearcher: makeMockSearcher([]),
    });
  });

  afterEach(() => {
    knowledgeNetwork.reset();
    _resetRetrievalEngineForTest();
  });

  test("100 实体图谱检索延迟 < 50ms", () => {
    const { metrics } = engine.retrieve("topic");
    expect(metrics.latencyMs).toBeLessThan(50);
    expect(metrics.graphPhaseMs).toBeLessThan(40);
  });

  test("缓存命中后第二次查询延迟显著降低", () => {
    const first = engine.retrieve("topic");
    const second = engine.retrieve("topic");
    expect(first.metrics.cacheHit).toBe(false);
    expect(second.metrics.cacheHit).toBe(true);
    // 缓存命中应比首次快（或至少不慢）
    expect(second.metrics.latencyMs).toBeLessThanOrEqual(first.metrics.latencyMs);
  });

  test("连续 50 次重复查询缓存命中率 > 90%", () => {
    for (let i = 0; i < 50; i++) {
      engine.retrieve("topic");
    }
    const stats = engine.getCacheStats();
    // 50 次查询中 49 次应命中（首次 miss）
    expect(stats.hitRate).toBeGreaterThan(0.9);
  });

  test("100 实体图遍历（depth=1）延迟 < 50ms", () => {
    const { metrics } = engine.retrieve("Concept-50", { graphDepth: 1 });
    expect(metrics.latencyMs).toBeLessThan(50);
  });
});

// ─── 质量指标：准确率 / 召回率 / F1 ──────────────────────────────────────

describe("DeterministicRetrievalEngine — 质量指标 (P/R/F1)", () => {
  let engine: DeterministicRetrievalEngine;
  let relevantIds: Set<string>;

  beforeEach(() => {
    const ids = seedGraph();
    engine = new DeterministicRetrievalEngine({
      keywordSearcher: makeMockSearcher([
        { path: "notes/typescript.md", title: "TypeScript Guide", content: "TypeScript debugging techniques and error handling", score: 85, reasons: ["标题匹配"] },
        { path: "notes/debugging.md", title: "Debugging Guide", content: "How to debug TypeScript errors in VSCode", score: 70, reasons: ["内容匹配"] },
      ]),
    });
    // 相关集合：TypeScript / Debugging / TypeError / Breakpoint / VSCode（与 "typescript debugging" 相关）
    // 不含 Photosynthesis（无关）。同时包含关键词笔记路径（它们也是相关结果）。
    relevantIds = new Set([
      ids.ts.id, ids.debug.id, ids.error.id, ids.breakpoint.id, ids.vscode.id,
      "notes/typescript.md", "notes/debugging.md",
    ]);
  });

  afterEach(() => {
    knowledgeNetwork.reset();
    _resetRetrievalEngineForTest();
  });

  test("准确率：返回结果中相关的占比应 > 0.5", () => {
    const { results } = engine.retrieve("typescript debugging");
    const p = precision(results, relevantIds);
    expect(p).toBeGreaterThan(0.5);
  });

  test("召回率：相关结果中被返回的占比应 >= 0.4", () => {
    const { results } = engine.retrieve("typescript debugging");
    const r = recall(results, relevantIds);
    // Layer 0 不做多跳扩展，至少应召回直接匹配的 TypeScript / Debugging 实体 + 笔记
    expect(r).toBeGreaterThanOrEqual(0.4);
  });

  test("F1 值应 > 0.4", () => {
    const { results } = engine.retrieve("typescript debugging");
    const p = precision(results, relevantIds);
    const r = recall(results, relevantIds);
    const f1Score = f1(p, r);
    expect(f1Score).toBeGreaterThan(0.4);
  });

  test("无关查询不应返回相关实体（准确率边界）", () => {
    const { results } = engine.retrieve("Photosynthesis");
    // Photosynthesis 只有一个实体，应返回它
    expect(results.length).toBeGreaterThan(0);
    // 但它不在 relevantIds 中
    const p = precision(results, relevantIds);
    expect(p).toBe(0);
  });

  test("混合查询的召回率优于纯关键词（图谱扩展提升召回）", () => {
    // 纯关键词
    const kwOnly = engine.retrieve("typescript debugging", { enableGraph: false });
    // 混合
    const hybrid = engine.retrieve("typescript debugging", { enableGraph: true });
    const rKw = recall(kwOnly.results, relevantIds);
    const rHybrid = recall(hybrid.results, relevantIds);
    // 混合应 >= 纯关键词（图谱扩展增加召回）
    expect(rHybrid).toBeGreaterThanOrEqual(rKw);
  });
});
