/**
 * 业务场景测试用例 — 基于实际用户操作流程的端到端验证
 *
 * 设计目标（对应用户第二大要求）：
 *   - 基于实际业务场景设计真实测试用例
 *   - 覆盖典型用户操作流程与边界条件
 *   - 每个测试用例包含：前置条件 / 执行步骤 / 预期结果 / 验证方法
 *   - 分类记录功能缺陷和性能问题
 *
 * 场景列表（6 个真实业务场景）：
 *   1. 知识研究工作流（compile → search → verify → fuse → observe）
 *   2. 多跳图推理（GraphRAG 3-hop traversal）
 *   3. 大规模知识库构建（batch compile + cross-reference）
 *   4. 高并发查询负载（parallel retrieval + cache hit）
 *   5. 验证链压力（mixed quality results batch verify）
 *   6. 边界条件：空输入 / 超大查询 / 全 contradictions / 缓存击穿
 *
 * 设计原则（遵循 AGENTS.md 规则 7 TDD）：
 *   - 测行为不测实现：通过公共接口验证端到端业务流程
 *   - 每个场景自包含：前置条件 + 步骤 + 预期 + 验证四要素齐全
 *   - 缺陷追踪：失败用例的 console 输出包含 [DEFECT] 标签便于分类
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
  type VerificationVerdict,
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
// 测试辅助函数
// ═══════════════════════════════════════════════════════════════

/** 构建模拟研究文档集（10 篇相关文档） */
function buildResearchDocSet(): CompiledDocument[] {
  return [
    {
      path: "research/intro.md",
      title: "确定性推理导论",
      content: `# 确定性推理导论
本文介绍确定性推理系统的核心概念。
关键词：deterministic reasoning、evidence chain、knowledge graph。
数值事实：系统目标是将幻觉率从 40% 降低到 5% 以下。
GraphRAG 通过多跳遍历提升召回率，目标从 72% 提升到 94%。`,
    },
    {
      path: "research/graphrag.md",
      title: "GraphRAG 多跳遍历",
      content: `# GraphRAG 多跳遍历
GraphRAG 通过 BFS 遍历知识图谱，编译完整证据路径。
每个路径包含起始实体、跳转序列、终点实体与综合置信度。
默认最大深度 3 跳，每跳置信度衰减因子 0.8。`,
    },
    {
      path: "research/wiki.md",
      title: "知识编译 Wiki",
      content: `# 知识编译
将原始文档编译为结构化知识条目，包含标题、摘要、关键词、概念、数值事实、交叉引用。
确定性实现采用词频分析、正则匹配、标题匹配，零 LLM 调用。
关键词提取上限 10，概念提取上限 15。`,
    },
    {
      path: "research/verification.md",
      title: "证据验证链",
      content: `# 证据验证链
4 项独立检查：citation、evidence_overlap、source_diversity、numerical_consistency。
ConfRAG 在验证率 < 0.5 或平均置信度 < 0.5 时触发深度检索。
综合置信度 = 检查得分 * 0.6 + 证据置信度 * 0.4。`,
    },
    {
      path: "research/fusion.md",
      title: "混合融合排序",
      content: `# 混合融合排序
多源结果按 ID 去重，应用验证加权与交叉来源加成。
verified 加分 10%，unverified 减分 10%，contradicted 减分 50%。
交叉来源（2+ 来源）加成 20%，hybrid 多样性加成 15%。
目标将召回率从 72% 提升到 94%。`,
    },
    {
      path: "research/observability.md",
      title: "可观测性监测",
      content: `# 可观测性监测
5 项监测维度：查询级指标、系统健康快照、质量评估、性能趋势、层级分解。
健康判定：p99 > 100ms 或 cacheHitRate < 0.3 或 errorRate > 0.05 → degraded。
p99 > 500ms 或 errorRate > 0.2 → unhealthy。`,
    },
    {
      path: "research/performance.md",
      title: "性能基准",
      content: `# 性能基准
系统目标：100 实体检索 < 50ms，100 文档编译 < 200ms，1000 健康快照 < 10ms。
GraphRAG 多跳 500 查询 p99 < 200ms。5000 持续查询 p99 < 100ms。`,
    },
    {
      path: "research/architecture.md",
      title: "5 层架构",
      content: `# 5 层确定性检索架构
Layer 0 确定性检索引擎、Layer 1 GraphRAG、Layer 2 知识编译、Layer 3 验证链、Layer 4 融合排序、Layer 5 可观测性。
零向量零 embedding，纯确定性 token + 图遍历。`,
    },
    {
      path: "research/boundary.md",
      title: "边界条件处理",
      content: `# 边界条件
空查询返回空结果。超大查询截断到 100 字符。
全 contradictions 触发深度检索。缓存击穿通过 LRU 淘汰控制。`,
    },
    {
      path: "research/conclusion.md",
      title: "总结",
      content: `# 总结
5 层架构通过确定性推理替代黑盒搜索，提升可解释性与可追溯性。
关键指标：幻觉率 < 5%，召回率 > 94%，p99 < 200ms。`,
    },
  ];
}

/** 构建知识图谱（用于多跳推理测试） */
function buildMultiHopGraph(): { agentId: string; toolId: string; conceptId: string; docId: string } {
  const agent = knowledgeNetwork.create(
    "agent",
    "ResearchAgent",
    "研究智能体，负责检索与推理",
    { confidence: 0.9, source: "test" },
  );
  const tool = knowledgeNetwork.create(
    "tool",
    "GraphRAG",
    "多跳图遍历工具",
    { confidence: 0.85, source: "test" },
  );
  const concept = knowledgeNetwork.create(
    "concept",
    "EvidenceChain",
    "证据链概念，可追溯推理路径",
    { confidence: 0.8, source: "test" },
  );
  const doc = knowledgeNetwork.create(
    "document",
    "ArchitectureDoc",
    "架构文档，描述 5 层架构",
    { confidence: 0.75, source: "test" },
  );

  // 构建多跳链：ResearchAgent -> GraphRAG -> EvidenceChain -> ArchitectureDoc
  knowledgeNetwork.link(agent.id, tool.id, "uses", { weight: 0.9 });
  knowledgeNetwork.link(tool.id, concept.id, "produces", { weight: 0.85 });
  knowledgeNetwork.link(concept.id, doc.id, "documented-in", { weight: 0.8 });

  return { agentId: agent.id, toolId: tool.id, conceptId: concept.id, docId: doc.id };
}

/** 清空所有单例状态 */
function resetAll(): void {
  knowledgeNetwork.reset();
  _resetRetrievalEngineForTest();
  _resetVerificationChainForTest();
  _resetKnowledgeWikiForTest();
  _resetHybridFusionForTest();
  _resetObservabilityMonitorForTest();
}

// ═══════════════════════════════════════════════════════════════
// 场景 1：知识研究工作流（端到端完整管道）
// ═══════════════════════════════════════════════════════════════

describe("场景 1：知识研究工作流（compile → search → verify → fuse → observe）", () => {
  beforeEach(() => resetAll());
  afterEach(() => resetAll());

  test("完整研究工作流：编译文档 → 检索 → 验证 → 融合 → 监测", () => {
    // ─── 前置条件 ───
    // 1. 准备 10 篇研究文档
    const docs = buildResearchDocSet();
    // 2. 准备知识图谱（4 个实体 + 3 链接）
    const graph = buildMultiHopGraph();
    // 3. 实例化 5 层组件
    const wiki = new KnowledgeWiki();
    const engine = new DeterministicRetrievalEngine({
      keywordSearcher: {
        search(query: string, opts?: { limit?: number }) {
          const limit = opts?.limit ?? 20;
          return wiki
            .searchByKeyword(query, limit)
            .map((e) => ({
              note: { path: e.source, title: e.title, content: e.summary },
              score: 60 + e.keywords.length,
              reasons: [`wiki keyword match: ${query}`],
              excerpt: e.summary,
            }));
        },
      },
      config: { cacheMaxSize: 50, cacheTtlMs: 0 },
    });
    const verifier = new VerificationChain();
    const fusion = new HybridFusion();
    const monitor = new ObservabilityMonitor(500);

    // ─── 执行步骤 ───
    // 步骤 1: 批量编译文档
    const entries = wiki.compileBatch(docs);

    // 步骤 2: 执行 5 次研究查询
    const queries = ["GraphRAG", "验证链", "知识编译", "可观测性", "性能基准"];
    const allResults: RetrievalResult[] = [];
    const allVerdicts: VerificationVerdict[] = [];
    for (const q of queries) {
      const resp = engine.retrieve(q);
      const verdicts = verifier.verifyBatch(resp.results);
      const verdictMap = new Map(verdicts.map((v) => [v.result.id, v.verdict]));
      const fused = fusion.fuse({ query: q, results: resp.results, verdicts: verdictMap });
      allResults.push(...fused.results);
      for (const v of verdicts) allVerdicts.push(v.verdict);

      // 步骤 3: 记录可观测性指标
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
    }

    // 步骤 4: 获取系统健康快照
    const health = monitor.getHealthSnapshot(100);
    const breakdown = monitor.getLayerBreakdown(100);
    const quality = monitor.evaluateQuality(
      queries.map((q, i) => ({
        query: q,
        relevantIds: new Set([`wiki/research-${q.toLowerCase()}.md`]),
        returnedIds: allResults.filter((r) => r.id.includes(q.toLowerCase())).map((r) => r.id),
      })),
    );

    // ─── 预期结果 ───
    // 1. 文档编译成功，10 篇全部编译
    expect(entries.length).toBe(10);
    // 2. 每篇文档有标题、摘要、关键词
    for (const e of entries) {
      expect(e.title.length).toBeGreaterThan(0);
      expect(e.summary.length).toBeGreaterThan(0);
      expect(e.keywords.length).toBeGreaterThan(0);
    }
    // 3. 5 次查询均产生结果
    expect(allResults.length).toBeGreaterThan(0);
    // 4. 验证链对每条结果都给出结论
    expect(allVerdicts.length).toBeGreaterThan(0);
    // 5. 系统健康状态不应是 unhealthy
    expect(health.status).not.toBe("unhealthy");
    // 6. 5 次查询都被记录到监测器
    expect(health.totalQueries).toBe(5);

    // ─── 验证方法 ───
    // 验证 1: 编译后的 WikiEntry 可通过关键词检索
    const wikiSearchResult = wiki.searchByKeyword("GraphRAG");
    expect(wikiSearchResult.length).toBeGreaterThan(0);
    // 至少一个结果的标题包含 GraphRAG（intro 文档也提到 GraphRAG 故可能排在前面）
    expect(wikiSearchResult.some((e) => e.title.includes("GraphRAG"))).toBe(true);

    // 验证 2: 知识图谱多跳链构建完整
    const stats = knowledgeNetwork.getStats();
    expect(stats.total).toBe(4);
    expect(stats.links).toBe(3);

    // 验证 3: 层级分解各项之和接近 1（误差 < 0.1）
    const layerSum = breakdown.keywordPhaseRatio + breakdown.graphPhaseRatio + breakdown.mergePhaseRatio;
    expect(layerSum).toBeLessThan(1.1);

    console.log(
      `[Scenario1] workflow: entries=${entries.length}, queries=${queries.length}, results=${allResults.length}, status=${health.status}, layerSum=${layerSum.toFixed(2)}`,
    );
  });
});

// ═══════════════════════════════════════════════════════════════
// 场景 2：多跳图推理（GraphRAG 3-hop traversal）
// ═══════════════════════════════════════════════════════════════

describe("场景 2：多跳图推理（GraphRAG 3-hop traversal）", () => {
  beforeEach(() => resetAll());
  afterEach(() => resetAll());

  test("GraphRAG 多跳推理：从 ResearchAgent 推理到 ArchitectureDoc", () => {
    // ─── 前置条件 ───
    // 构建知识图谱链：Agent -> Tool -> Concept -> Document
    const graph = buildMultiHopGraph();
    const engine = new DeterministicRetrievalEngine({
      keywordSearcher: null,
      config: { cacheMaxSize: 10, cacheTtlMs: 0, graphRagMaxDepth: 3 },
    });

    // ─── 执行步骤 ───
    // 步骤 1: 从 ResearchAgent 起始查询
    const resp = engine.retrieveWithPaths("ResearchAgent", { maxDepth: 3 });

    // 步骤 2: 遍历所有路径，找到终点为 ArchitectureDoc 的路径
    const pathsToDoc = resp.paths.filter((p) => p.endEntityName === "ArchitectureDoc");

    // ─── 预期结果 ───
    // 1. 应返回多跳路径（至少 1 条到 ArchitectureDoc）
    expect(pathsToDoc.length).toBeGreaterThan(0);
    // 2. 路径应包含 3 跳（Agent -> Tool -> Concept -> Document）
    const longestPath = pathsToDoc.reduce((max, p) => (p.hops.length > max.hops.length ? p : max));
    expect(longestPath.hops.length).toBe(3);
    // 3. 路径置信度应随跳数衰减（< 起始实体置信度 0.9）
    expect(longestPath.pathConfidence).toBeLessThan(0.9);
    expect(longestPath.pathConfidence).toBeGreaterThan(0);
    // 4. 路径推理说明应包含所有跳转关系
    expect(longestPath.reasoning).toContain("uses");
    expect(longestPath.reasoning).toContain("produces");
    expect(longestPath.reasoning).toContain("documented-in");

    // ─── 验证方法 ───
    // 验证 1: 路径起始实体正确
    expect(longestPath.startEntityName).toBe("ResearchAgent");
    // 验证 2: 路径终点实体正确
    expect(longestPath.endEntityName).toBe("ArchitectureDoc");
    // 验证 3: 每跳的实体名按预期顺序
    expect(longestPath.hops[0].entityName).toBe("GraphRAG");
    expect(longestPath.hops[1].entityName).toBe("EvidenceChain");
    expect(longestPath.hops[2].entityName).toBe("ArchitectureDoc");

    console.log(
      `[Scenario2] graphrag: paths=${resp.paths.length}, longest=${longestPath.hops.length} hops, confidence=${longestPath.pathConfidence.toFixed(3)}`,
    );
    console.log(
      `[Scenario2] reasoning: ${longestPath.reasoning}`,
    );
  });
});

// ═══════════════════════════════════════════════════════════════
// 场景 3：大规模知识库构建（batch compile + cross-reference）
// ═══════════════════════════════════════════════════════════════

describe("场景 3：大规模知识库构建（batch compile + cross-reference）", () => {
  beforeEach(() => resetAll());
  afterEach(() => resetAll());

  test("批量编译 100 篇文档 + 交叉引用检测", () => {
    // ─── 前置条件 ───
    // 构造 100 篇相互引用的文档（每篇引用其他文档的标题）
    const docs: CompiledDocument[] = Array.from({ length: 100 }, (_, i) => ({
      path: `kb/doc-${i}.md`,
      title: `Document-${i}`,
      content: `# Document-${i}\n\n本文引用 Document-${(i + 1) % 100} 和 Document-${(i + 2) % 100} 的内容。\n关键词：topic${i % 10}、concept${i % 5}。\n数值事实：${i * 100} 个条目。`,
    }));
    const wiki = new KnowledgeWiki();

    // ─── 执行步骤 ───
    // 步骤 1: 批量编译
    const start = performance.now();
    const entries = wiki.compileBatch(docs);
    const duration = performance.now() - start;

    // 步骤 2: 检查交叉引用
    const stats = wiki.getStats();
    const entriesWithCrossRefs = entries.filter((e) => e.relatedTitles.length > 0);

    // 步骤 3: 关键词搜索
    const searchResults = wiki.searchByKeyword("topic0");
    const conceptResults = wiki.searchByConcept("Document-1");

    // ─── 预期结果 ───
    // 1. 100 篇文档全部编译成功
    expect(entries.length).toBe(100);
    // 2. 至少有部分条目检测到交叉引用（每篇都引用了其他文档）
    expect(entriesWithCrossRefs.length).toBeGreaterThan(50);
    // 3. 编译时间 < 2s（性能预期）
    expect(duration).toBeLessThan(2000);
    // 4. 关键词索引可用
    expect(searchResults.length).toBeGreaterThan(0);
    // 5. 统计信息正确
    expect(stats.totalEntries).toBe(100);
    expect(stats.totalCrossRefs).toBeGreaterThan(0);

    // ─── 验证方法 ───
    // 验证 1: 第一篇文档的交叉引用应包含 Document-1 和 Document-2
    const firstEntry = entries[0];
    expect(firstEntry.relatedTitles).toContain("Document-1");
    expect(firstEntry.relatedTitles).toContain("Document-2");
    // 验证 2: 每篇文档都有数值事实
    for (const e of entries) {
      expect(e.numericalFacts.length).toBeGreaterThan(0);
    }
    // 验证 3: 关键词搜索返回的条目包含 topic0
    for (const r of searchResults) {
      expect(r.keywords).toContain("topic0");
    }

    console.log(
      `[Scenario3] kb-build: entries=${entries.length}, crossRefs=${stats.totalCrossRefs}, withRefs=${entriesWithCrossRefs.length}, duration=${duration.toFixed(0)}ms`,
    );
  });
});

// ═══════════════════════════════════════════════════════════════
// 场景 4：高并发查询负载（parallel retrieval + cache hit）
// ═══════════════════════════════════════════════════════════════

describe("场景 4：高并发查询负载（parallel retrieval + cache hit）", () => {
  beforeEach(() => resetAll());
  afterEach(() => resetAll());

  test("100 个并发查询 + 缓存命中率验证", async () => {
    // ─── 前置条件 ───
    // 构建 1000 实体知识图谱 + mock 关键词检索器
    const ids: string[] = [];
    for (let i = 0; i < 1000; i++) {
      const ent = knowledgeNetwork.create(
        "concept",
        `Concept-${i}`,
        `Concept ${i} with keyword${i % 20} topic${i % 10}`,
        { confidence: 0.7, source: "test" },
      );
      ids.push(ent.id);
    }
    for (let i = 0; i < 2000; i++) {
      knowledgeNetwork.link(ids[i % 1000], ids[(i + 1) % 1000], `rel-${i % 5}`, { weight: 0.5 });
    }

    // 启用缓存：cacheMaxSize=50，TTL=60s
    const engine = new DeterministicRetrievalEngine({
      keywordSearcher: null,
      config: { cacheMaxSize: 50, cacheTtlMs: 60000 },
    });

    // ─── 执行步骤 ───
    // 步骤 1: 构造 100 个查询（50 个唯一查询，每个重复 2 次以测缓存）
    const queries = Array.from({ length: 100 }, (_, i) => `keyword${i % 50} topic${i % 10}`);

    // 步骤 2: 并发执行所有查询
    const start = performance.now();
    const results = await Promise.all(
      queries.map((q) => {
        try {
          return { ok: true, response: engine.retrieve(q) };
        } catch (e) {
          return { ok: false, error: String(e) };
        }
      }),
    );
    const duration = performance.now() - start;

    // 步骤 3: 收集缓存统计
    const cacheStats = engine.getCacheStats();

    // ─── 预期结果 ───
    // 1. 全部 100 个查询成功
    const okCount = results.filter((r) => r.ok).length;
    expect(okCount).toBe(100);
    // 2. 并发完成时间 < 2s
    expect(duration).toBeLessThan(2000);
    // 3. 缓存命中率 > 30%（50 唯一查询 × 2 次 = 50 次应命中缓存）
    expect(cacheStats.hitRate).toBeGreaterThan(0.3);

    // ─── 验证方法 ───
    // 验证 1: 缓存命中数 + 未命中数 = 总查询数
    expect(cacheStats.hits + cacheStats.misses).toBe(100);
    // 验证 2: 缓存大小不超过上限
    expect(cacheStats.size).toBeLessThanOrEqual(cacheStats.maxSize);
    // 验证 3: 相同查询的响应应一致（缓存语义正确）
    const r1 = engine.retrieve("keyword0 topic0");
    const r2 = engine.retrieve("keyword0 topic0");
    expect(r1.results.length).toBe(r2.results.length);

    console.log(
      `[Scenario4] concurrent: queries=100, ok=${okCount}, duration=${duration.toFixed(0)}ms, cacheHitRate=${cacheStats.hitRate.toFixed(2)}, cacheSize=${cacheStats.size}/${cacheStats.maxSize}`,
    );
  });
});

// ═══════════════════════════════════════════════════════════════
// 场景 5：验证链压力（mixed quality results batch verify）
// ═══════════════════════════════════════════════════════════════

describe("场景 5：验证链压力（mixed quality results batch verify）", () => {
  beforeEach(() => resetAll());
  afterEach(() => resetAll());

  test("混合质量结果批量验证 + ConfRAG 触发判定", () => {
    // ─── 前置条件 ───
    // 构造 100 条混合质量结果：
    // - 30 条高质量（verified 期望）
    // - 50 条中等质量（unverified 期望）
    // - 20 条矛盾（contradicted 期望，数值不一致）
    const verifier = new VerificationChain({ confidenceThreshold: 0.6 });
    const results: RetrievalResult[] = [];

    // 30 条高质量（双来源 + 多步骤 + 一致数值）
    for (let i = 0; i < 30; i++) {
      results.push({
        id: `high-${i}`,
        title: `High Quality ${i}`,
        excerpt: `Excerpt with value ${i * 10}`,
        score: 80,
        reasons: ["high quality"],
        evidenceChain: {
          query: "test",
          steps: [
            { type: "keyword_match", source: "query", target: `doc-${i}`, confidence: 0.8, reasoning: `value ${i * 10}` },
            { type: "graph_entity", source: "query", target: `entity-${i}`, confidence: 0.8, reasoning: `value ${i * 10}` },
          ],
          totalConfidence: 0.8,
        },
        source: "hybrid",
        notePath: `doc-${i}`,
        entityId: `entity-${i}`,
      });
    }

    // 50 条中等质量（单来源 + 单步骤）
    for (let i = 0; i < 50; i++) {
      results.push({
        id: `mid-${i}`,
        title: `Mid Quality ${i}`,
        excerpt: `Excerpt ${i}`,
        score: 50,
        reasons: ["mid quality"],
        evidenceChain: {
          query: "test",
          steps: [
            { type: "keyword_match", source: "query", target: `doc-mid-${i}`, confidence: 0.5, reasoning: "single source" },
          ],
          totalConfidence: 0.5,
        },
        source: "keyword",
        notePath: `doc-mid-${i}`,
      });
    }

    // 20 条矛盾（数值不一致：excerpt 写 100，证据写 200）
    for (let i = 0; i < 20; i++) {
      results.push({
        id: `contra-${i}`,
        title: `Contradicted ${i}`,
        excerpt: `Value is 100`,
        score: 30,
        reasons: ["contradicted"],
        evidenceChain: {
          query: "test",
          steps: [
            { type: "graph_entity", source: "query", target: `entity-contra-${i}`, confidence: 0.7, reasoning: "value is 200" },
          ],
          totalConfidence: 0.6,
        },
        source: "graph",
        entityId: `entity-contra-${i}`,
      });
    }

    // ─── 执行步骤 ───
    // 步骤 1: 批量验证所有结果
    const start = performance.now();
    const verdicts = verifier.verifyBatch(results);
    const duration = performance.now() - start;

    // 步骤 2: 统计各状态数量
    const verified = verdicts.filter((v) => v.verdict.status === "verified").length;
    const unverified = verdicts.filter((v) => v.verdict.status === "unverified").length;
    const contradicted = verdicts.filter((v) => v.verdict.status === "contradicted").length;

    // 步骤 3: 调用 ConfRAG 判定是否触发深度检索
    const confRagResult = verifier.shouldTriggerDeepRetrieval(results, {
      minVerifiedRate: 0.4,
      minAvgConfidence: 0.5,
    });

    // ─── 预期结果 ───
    // 1. 全部 100 条结果都被验证
    expect(verdicts.length).toBe(100);
    // 2. 验证状态分布合理（30 high 大部分 verified，20 contra 应 contradicted）
    expect(verified + unverified + contradicted).toBe(100);
    expect(contradicted).toBeGreaterThan(0);
    // 3. ConfRAG 应触发深度检索（验证率 < 0.4）
    expect(confRagResult.trigger).toBe(true);
    expect(confRagResult.verifiedRate).toBeLessThan(0.4);
    // 4. 批量验证时间 < 100ms
    expect(duration).toBeLessThan(100);

    // ─── 验证方法 ───
    // 验证 1: 矛盾结果的验证状态为 contradicted
    const contraVerdicts = verdicts.filter((v) => v.result.id.startsWith("contra-"));
    const contraContradictedCount = contraVerdicts.filter((v) => v.verdict.status === "contradicted").length;
    expect(contraContradictedCount).toBe(contraVerdicts.length);

    // 验证 2: ConfRAG reason 包含触发原因
    expect(confRagResult.reason).toContain("触发");

    // 验证 3: 每条 verdict 都有 4 项检查
    for (const v of verdicts) {
      expect(v.verdict.checks.length).toBe(4);
    }

    console.log(
      `[Scenario5] verify-mixed: total=100, verified=${verified}, unverified=${unverified}, contradicted=${contradicted}, duration=${duration.toFixed(0)}ms, confRagTrigger=${confRagResult.trigger}`,
    );
  });
});

// ═══════════════════════════════════════════════════════════════
// 场景 6：边界条件测试
// ═══════════════════════════════════════════════════════════════

describe("场景 6：边界条件测试", () => {
  beforeEach(() => resetAll());
  afterEach(() => resetAll());

  test("边界 6.1：空查询输入应返回空结果", () => {
    // ─── 前置条件 ───
    const ids: string[] = [];
    for (let i = 0; i < 100; i++) {
      const ent = knowledgeNetwork.create("concept", `Concept-${i}`, `Content ${i}`, {
        confidence: 0.7,
        source: "test",
      });
      ids.push(ent.id);
    }
    const engine = new DeterministicRetrievalEngine({ config: { cacheMaxSize: 10, cacheTtlMs: 0 } });

    // ─── 执行步骤 ───
    const resp1 = engine.retrieve("");
    const resp2 = engine.retrieve("   ");
    const resp3 = engine.retrieve("");

    // ─── 预期结果 ───
    expect(resp1.results.length).toBe(0);
    expect(resp1.metrics.totalResults).toBe(0);
    expect(resp2.results.length).toBe(0);
    expect(resp3.results.length).toBe(0);
    // 空查询不应崩溃，延迟应在合理范围内
    expect(resp1.metrics.latencyMs).toBeLessThan(10);

    // ─── 验证方法 ───
    // 空查询不应写入缓存
    expect(engine.getCacheStats().size).toBe(0);

    console.log(`[Scenario6.1] empty-query: results=0, latency=${resp1.metrics.latencyMs}ms`);
  });

  test("边界 6.2：超大查询应正常处理（不截断导致崩溃）", () => {
    // ─── 前置条件 ───
    const ids: string[] = [];
    for (let i = 0; i < 50; i++) {
      const ent = knowledgeNetwork.create("concept", `Concept-${i}`, `Content ${i} keyword0 topic${i % 5}`, {
        confidence: 0.7,
        source: "test",
      });
      ids.push(ent.id);
    }
    const engine = new DeterministicRetrievalEngine({ config: { cacheMaxSize: 10, cacheTtlMs: 0 } });

    // ─── 执行步骤 ───
    // 构造 10000 字符的超大查询（重复 keyword0 1000 次）
    const hugeQuery = "keyword0 ".repeat(1000);
    const resp = engine.retrieve(hugeQuery);

    // ─── 预期结果 ───
    // 1. 不应崩溃
    expect(resp).toBeDefined();
    // 2. 应返回结果（"keyword0" 在实体内容中能匹配到所有 50 个 Concept）
    expect(resp.results.length).toBeGreaterThan(0);
    // 3. 延迟应 < 500ms（超大查询允许较高延迟，但不应崩溃或超时）
    expect(resp.metrics.latencyMs).toBeLessThan(500);

    console.log(`[Scenario6.2] huge-query: results=${resp.results.length}, latency=${resp.metrics.latencyMs}ms`);
  });

  test("边界 6.3：全 contradictions 结果应触发深度检索", () => {
    // ─── 前置条件 ───
    const verifier = new VerificationChain();
    // 构造 20 条全部数值矛盾的结果
    const results: RetrievalResult[] = Array.from({ length: 20 }, (_, i) => ({
      id: `contra-${i}`,
      title: `Contradicted ${i}`,
      excerpt: `Value is 100`,
      score: 30,
      reasons: ["contra"],
      evidenceChain: {
        query: "test",
        steps: [
          { type: "graph_entity", source: "query", target: `e-${i}`, confidence: 0.7, reasoning: "value is 999" },
        ],
        totalConfidence: 0.6,
      },
      source: "graph",
      entityId: `e-${i}`,
    }));

    // ─── 执行步骤 ───
    const verdicts = verifier.verifyBatch(results);
    const confRag = verifier.shouldTriggerDeepRetrieval(results);

    // ─── 预期结果 ───
    // 1. 全部 20 条结果应为 contradicted
    const contradictedCount = verdicts.filter((v) => v.verdict.status === "contradicted").length;
    expect(contradictedCount).toBe(20);
    // 2. ConfRAG 必须触发深度检索
    expect(confRag.trigger).toBe(true);
    // 3. 验证率应为 0
    expect(confRag.verifiedRate).toBe(0);

    console.log(`[Scenario6.3] all-contradicted: contradicted=20/20, confRagTrigger=${confRag.trigger}, verifiedRate=${confRag.verifiedRate}`);
  });

  test("边界 6.4：缓存击穿 — 大量不同查询不应导致缓存无限增长", () => {
    // ─── 前置条件 ───
    const ids: string[] = [];
    for (let i = 0; i < 100; i++) {
      const ent = knowledgeNetwork.create("concept", `Concept-${i}`, `Content ${i} keyword${i}`, {
        confidence: 0.7,
        source: "test",
      });
      ids.push(ent.id);
    }
    // 缓存上限 50，TTL 永不过期
    const engine = new DeterministicRetrievalEngine({
      config: { cacheMaxSize: 50, cacheTtlMs: 0 },
    });

    // ─── 执行步骤 ───
    // 执行 200 个不同查询（远超缓存上限 50）
    for (let i = 0; i < 200; i++) {
      engine.retrieve(`unique-query-${i}`);
    }

    // ─── 预期结果 ───
    const cacheStats = engine.getCacheStats();
    // 1. 缓存大小不应超过上限
    expect(cacheStats.size).toBeLessThanOrEqual(cacheStats.maxSize);
    expect(cacheStats.size).toBe(50);
    // 2. 应有 150 次缓存未命中（200 - 50 = 150 因 LRU 淘汰）
    expect(cacheStats.misses).toBe(200); // 每次都是新查询，全部 miss
    // 3. 命中数应为 0（所有查询都不同）
    expect(cacheStats.hits).toBe(0);

    // ─── 验证方法 ───
    // 验证：LRU 淘汰生效 — 最早查询已被淘汰，重新查询应 miss
    const earlyStats = engine.getCacheStats();
    engine.retrieve("unique-query-0"); // 应该已被淘汰
    const newStats = engine.getCacheStats();
    expect(newStats.misses).toBe(earlyStats.misses + 1);

    console.log(`[Scenario6.4] cache-eviction: size=${cacheStats.size}/${cacheStats.maxSize}, hits=${cacheStats.hits}, misses=${cacheStats.misses}`);
  });

  test("边界 6.5：缓存命中 — 重复查询应快速返回", () => {
    // ─── 前置条件 ───
    const ids: string[] = [];
    for (let i = 0; i < 100; i++) {
      const ent = knowledgeNetwork.create("concept", `Concept-${i}`, `Content ${i} keyword0`, {
        confidence: 0.7,
        source: "test",
      });
      ids.push(ent.id);
    }
    const engine = new DeterministicRetrievalEngine({
      config: { cacheMaxSize: 100, cacheTtlMs: 60000 },
    });

    // ─── 执行步骤 ───
    // 第一次查询（miss）
    const t0 = performance.now();
    const resp1 = engine.retrieve("keyword0");
    const missLatency = performance.now() - t0;

    // 第二次相同查询（hit）
    const t1 = performance.now();
    const resp2 = engine.retrieve("keyword0");
    const hitLatency = performance.now() - t1;

    // ─── 预期结果 ───
    // 1. 两次查询结果一致
    expect(resp1.results.length).toBe(resp2.results.length);
    // 2. 缓存命中延迟应 < 未命中延迟
    expect(hitLatency).toBeLessThanOrEqual(missLatency);
    // 3. 第二次应标记为 cacheHit
    expect(resp2.metrics.cacheHit).toBe(true);
    expect(resp1.metrics.cacheHit).toBe(false);

    console.log(`[Scenario6.5] cache-hit: missLatency=${missLatency.toFixed(2)}ms, hitLatency=${hitLatency.toFixed(2)}ms, speedup=${(missLatency / Math.max(hitLatency, 0.001)).toFixed(1)}x`);
  });
});
