/**
 * 确定性检索引擎 — Layer 0 基础层
 *
 * 设计目标（对应用户两大技术目标）：
 *   1. 性能优化：查询级 LRU 缓存 + 分阶段延迟监测 + 可配置阈值
 *   2. 确定性推理替代黑盒搜索：关键词检索 + 知识图谱联合，每个结果附带
 *      完整证据链（EvidenceChain），消除"黑盒套黑盒"。
 *
 * 架构分层（由底层到顶层）：
 *   Layer 0（本模块）：确定性检索 + 证据链 + 缓存 + 基准
 *   Layer 1：GraphRAG 多跳图遍历
 *   Layer 2：知识编译（LLM Wiki）
 *   Layer 3：可验证性（ConfRAG / StillMe / Debate）
 *   Layer 4：混合融合排序
 *   Layer 5：持续可观测性
 *
 * 设计原则（遵循 AGENTS.md 规则 8 深模块设计）：
 *   - 小接口：retrieve(query) 是唯一公开入口
 *   - 接受依赖不创建依赖：keywordSearcher 与 graph 通过构造注入
 *   - 接口即测试面：全部可通过 retrieve() 验证
 *   - 检索以 FTS5 + 关键词打分为主（共享 cosineSimilarity 仅 settings-search 可选语义层，需 embedding 时启用），PG vector 为可选历史能力
 */

import { logger } from "../../utils/logger.js";
import { knowledgeNetwork, type KnowledgeEntity } from "../runtime/knowledge-network.js";

// ─── 公共类型 ────────────────────────────────────────────────────────────

/** 证据步骤 — 证据链中的单步推理 */
export interface EvidenceStep {
  /** 步骤类型 */
  type: "keyword_match" | "graph_entity" | "graph_link" | "graph_traverse" | "relation_boost";
  /** 匹配来源（查询词 / 实体名 / 文档标题） */
  source: string;
  /** 匹配目标（文档路径 / 实体 ID） */
  target: string;
  /** 图关系（仅 graph_link / graph_traverse 步骤） */
  relation?: string;
  /** 本步骤置信度 0-1 */
  confidence: number;
  /** 人类可读的推理说明 */
  reasoning: string;
}

/** 证据链 — 从查询到结果的完整可追溯路径 */
export interface EvidenceChain {
  /** 原始查询 */
  query: string;
  /** 推理步骤序列（有序，可追溯） */
  steps: EvidenceStep[];
  /** 综合置信度（各步骤加权） */
  totalConfidence: number;
}

/** 检索结果 — 包含来源信息 + 证据链 */
export interface RetrievalResult {
  /** 结果标识（文档路径或实体 ID） */
  id: string;
  /** 显示标题 */
  title: string;
  /** 内容摘要 */
  excerpt: string;
  /** 综合得分 */
  score: number;
  /** 得分来源说明（人类可读） */
  reasons: string[];
  /** 完整证据链 */
  evidenceChain: EvidenceChain;
  /** 结果来源 */
  source: "keyword" | "graph" | "hybrid";
  /** 关联的文档笔记（若来自关键词检索） */
  notePath?: string;
  /** 关联的知识实体（若来自图谱） */
  entityId?: string;
  /** 实体类型（若来自图谱） */
  entityKind?: string;
}

/** 检索性能指标 */
export interface RetrievalMetrics {
  /** 总延迟（毫秒） */
  latencyMs: number;
  /** 是否命中查询缓存 */
  cacheHit: boolean;
  /** 关键词检索阶段延迟 */
  keywordPhaseMs: number;
  /** 图谱检索阶段延迟 */
  graphPhaseMs: number;
  /** 融合阶段延迟 */
  mergePhaseMs: number;
  /** 关键词结果数 */
  keywordResults: number;
  /** 图谱结果数 */
  graphResults: number;
  /** 最终结果数（去重后） */
  totalResults: number;
}

/** 检索选项 */
export interface RetrievalOptions {
  /** 最大返回数（默认 20） */
  limit?: number;
  /** 图遍历深度（默认 1，Layer 1 会扩展到多跳） */
  graphDepth?: number;
  /** 是否启用图谱扩展（默认 true） */
  enableGraph?: boolean;
  /** 是否启用查询缓存（默认 true） */
  enableCache?: boolean;
}

/** 检索完整响应 */
export interface RetrievalResponse {
  results: RetrievalResult[];
  metrics: RetrievalMetrics;
}

// ─── GraphRAG 多跳证据路径（Layer 1）──────────────────────────────────────

/** 图遍历单跳 — 证据路径中的一步 */
export interface GraphRAGHop {
  /** 实体 ID */
  entityId: string;
  /** 实体名称 */
  entityName: string;
  /** 关系类型 */
  relation: string;
  /** 本跳置信度（含衰减） */
  confidence: number;
}

/** GraphRAG 证据路径 — 从查询起点到终点的完整推理链 */
export interface GraphRAGPath {
  /** 原始查询 */
  query: string;
  /** 起始实体 ID（直接匹配查询的实体） */
  startEntityId: string;
  /** 起始实体名称 */
  startEntityName: string;
  /** 中间跳转序列（不含起点，含终点） */
  hops: GraphRAGHop[];
  /** 终点实体 ID */
  endEntityId: string;
  /** 终点实体名称 */
  endEntityName: string;
  /** 终点实体内容摘要 */
  endEntityContent: string;
  /** 路径综合置信度（按跳数衰减） */
  pathConfidence: number;
  /** 人类可读的推理路径摘要 */
  reasoning: string;
}

/** GraphRAG 检索响应 — 包含结果 + 证据路径 */
export interface GraphRAGResponse {
  results: RetrievalResult[];
  paths: GraphRAGPath[];
  metrics: RetrievalMetrics;
}

// ─── 关键词检索器接口（依赖注入，遵循规则 8）──────────────────────────────

/**
 * 关键词检索器契约 — 任何具备 search(query) 能力的对象均可注入。
 * 默认实现为 DeterministicSearchEngine，但测试可注入 mock。
 */
export interface KeywordSearcher {
  search(query: string, opts?: { limit?: number }): Array<{
    note?: { path: string; title: string; content: string };
    score: number;
    reasons: string[];
    excerpt: string;
  }>;
}

// ─── 查询缓存（LRU）──────────────────────────────────────────────────────

interface CacheEntry {
  results: RetrievalResult[];
  at: number;
}

// ─── 分词器（轻量级，与 goal-tracker 一致）────────────────────────────────

function tokenize(text: string): string[] {
  if (!text) return [];
  const english = text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  const chinese = text.match(/[\u4e00-\u9fff]/g) ?? [];
  return [...english.filter((t) => t.length >= 2), ...chinese];
}

// ─── 确定性检索引擎 ──────────────────────────────────────────────────────

export interface DeterministicRetrievalConfig {
  /** 查询缓存上限（条目数） */
  cacheMaxSize: number;
  /** 缓存 TTL（毫秒，0 = 永不过期） */
  cacheTtlMs: number;
  /** 关键词结果默认上限 */
  keywordLimit: number;
  /** 图谱结果默认上限 */
  graphLimit: number;
  /** 图遍历默认深度 */
  defaultGraphDepth: number;
  /** 图谱扩展加权 */
  graphBoostWeight: number;
  /** 关键词与图谱实体名称匹配的加分 */
  crossLinkBoost: number;
  /** GraphRAG 多跳最大深度（Layer 1） */
  graphRagMaxDepth: number;
  /** 每个起始实体的最大路径数（防爆炸） */
  graphRagMaxPathsPerStart: number;
  /** 每跳置信度衰减因子 */
  graphRagConfidenceDecay: number;
}

export const DEFAULT_RETRIEVAL_CONFIG: DeterministicRetrievalConfig = {
  cacheMaxSize: 128,
  cacheTtlMs: 5 * 60 * 1000, // 5 分钟
  keywordLimit: 20,
  graphLimit: 20,
  defaultGraphDepth: 1,
  graphBoostWeight: 15,
  crossLinkBoost: 20,
  graphRagMaxDepth: 3,
  graphRagMaxPathsPerStart: 10,
  graphRagConfidenceDecay: 0.8,
};

export class DeterministicRetrievalEngine {
  private readonly config: DeterministicRetrievalConfig;
  private readonly keywordSearcher: KeywordSearcher | null;
  private readonly graph: typeof knowledgeNetwork;
  private queryCache = new Map<string, CacheEntry>();
  private cacheHits = 0;
  private cacheMisses = 0;

  constructor(
    opts: {
      keywordSearcher?: KeywordSearcher | null;
      graph?: typeof knowledgeNetwork;
      config?: Partial<DeterministicRetrievalConfig>;
    } = {},
  ) {
    this.config = { ...DEFAULT_RETRIEVAL_CONFIG, ...opts.config };
    this.keywordSearcher = opts.keywordSearcher ?? null;
    this.graph = opts.graph ?? knowledgeNetwork;
  }

  /**
   * 确定性检索 — 唯一公开入口
   *
   * 流程（可追溯）：
   *   1. 查询缓存检查
   *   2. Phase 1 关键词检索（若注入了 keywordSearcher）
   *   3. Phase 2 图谱检索（knowledgeNetwork.search + 图遍历）
   *   4. Phase 3 融合去重 + 交叉链接加分
   *   5. 构建证据链 + 排序 + 缓存写入
   */
  retrieve(query: string, options: RetrievalOptions = {}): RetrievalResponse {
    const startTime = performance.now();
    // 空查询守卫：直接返回空结果（避免空串匹配全部实体）
    if (!query || query.trim().length === 0) {
      return {
        results: [],
        metrics: {
          latencyMs: Math.round(performance.now() - startTime),
          cacheHit: false,
          keywordPhaseMs: 0,
          graphPhaseMs: 0,
          mergePhaseMs: 0,
          keywordResults: 0,
          graphResults: 0,
          totalResults: 0,
        },
      };
    }
    const limit = options.limit ?? this.config.keywordLimit;
    const enableGraph = options.enableGraph ?? true;
    const enableCache = options.enableCache ?? true;

    // 1. 缓存检查
    const cacheKey = this.cacheKey(query, options);
    if (enableCache) {
      const cached = this.getFromCache(cacheKey);
      if (cached) {
        const metrics: RetrievalMetrics = {
          latencyMs: Math.round(performance.now() - startTime),
          cacheHit: true,
          keywordPhaseMs: 0,
          graphPhaseMs: 0,
          mergePhaseMs: 0,
          keywordResults: 0,
          graphResults: 0,
          totalResults: cached.results.length,
        };
        return { results: cached.results, metrics };
      }
    }

    // 2. Phase 1: 关键词检索
    const phase1Start = performance.now();
    const keywordResults = this.phaseKeywordSearch(query, limit);
    const keywordPhaseMs = Math.round(performance.now() - phase1Start);

    // 3. Phase 2: 图谱检索
    const phase2Start = performance.now();
    const graphResults = enableGraph ? this.phaseGraphSearch(query, options.graphDepth ?? this.config.defaultGraphDepth) : [];
    const graphPhaseMs = Math.round(performance.now() - phase2Start);

    // 4. Phase 3: 融合去重
    const phase3Start = performance.now();
    const merged = this.phaseMergeAndRank(keywordResults, graphResults, query);
    const mergePhaseMs = Math.round(performance.now() - phase3Start);

    // 5. 截断 + 缓存
    const results = merged.slice(0, limit);
    if (enableCache) {
      this.putToCache(cacheKey, results);
    }

    const metrics: RetrievalMetrics = {
      latencyMs: Math.round(performance.now() - startTime),
      cacheHit: false,
      keywordPhaseMs,
      graphPhaseMs,
      mergePhaseMs,
      keywordResults: keywordResults.length,
      graphResults: graphResults.length,
      totalResults: results.length,
    };

    logger.debug("[DRE/Retrieval] 检索完成", {
      query: query.slice(0, 50),
      ...metrics,
    });

    return { results, metrics };
  }

  // ─── Phase 1: 关键词检索 ──────────────────────────────────────────────

  private phaseKeywordSearch(query: string, limit: number): RetrievalResult[] {
    if (!this.keywordSearcher) return [];

    const raw = this.keywordSearcher.search(query, { limit });

    return raw.map((r) => {
      const steps: EvidenceStep[] = [];
      // 关键词匹配步骤
      steps.push({
        type: "keyword_match",
        source: query,
        target: r.note?.path ?? "unknown",
        confidence: Math.min(r.score / 100, 1),
        reasoning: `关键词检索匹配，得分 ${r.score}：${r.reasons.join("；")}`,
      });

      return {
        id: r.note?.path ?? `kw-${r.score}`,
        title: r.note?.title ?? "未知标题",
        excerpt: r.excerpt,
        score: r.score,
        reasons: r.reasons,
        evidenceChain: {
          query,
          steps,
          totalConfidence: Math.min(r.score / 100, 1),
        },
        source: "keyword" as const,
        notePath: r.note?.path,
      };
    });
  }

  // ─── Phase 2: 图谱检索 ────────────────────────────────────────────────

  private phaseGraphSearch(query: string, depth: number): RetrievalResult[] {
    // 按 token 检索并去重（knowledgeNetwork.search 做子串匹配，需分词后逐 token 查询）
    const queryTokens = tokenize(query);
    const entityMap = new Map<string, KnowledgeEntity>();
    if (queryTokens.length > 0) {
      for (const token of queryTokens) {
        for (const e of this.graph.search(token, this.config.graphLimit)) {
          if (!entityMap.has(e.id)) entityMap.set(e.id, e);
        }
      }
    } else {
      for (const e of this.graph.search(query, this.config.graphLimit)) {
        entityMap.set(e.id, e);
      }
    }
    const entities = Array.from(entityMap.values());
    const results: RetrievalResult[] = [];

    for (const entity of entities) {
      const steps: EvidenceStep[] = [];

      // 实体匹配步骤
      const matchConfidence = this.computeEntityConfidence(entity, queryTokens);
      steps.push({
        type: "graph_entity",
        source: query,
        target: entity.id,
        confidence: matchConfidence,
        reasoning: `知识图谱实体匹配：kind=${entity.kind}, name="${entity.name}", confidence=${entity.confidence.toFixed(2)}`,
      });

      // 图遍历步骤（1-hop，Layer 1 会扩展到多跳）
      if (depth >= 1) {
        const links = this.graph.getLinksFrom(entity.id);
        for (const link of links.slice(0, 5)) {
          // 限制每实体最多 5 条出边，避免爆炸
          steps.push({
            type: "graph_traverse",
            source: entity.id,
            target: link.dst,
            relation: link.relation,
            confidence: link.weight * entity.confidence,
            reasoning: `图遍历：${entity.name} --[${link.relation}]--> ${link.dst}${link.evidence ? `（证据：${link.evidence}）` : ""}`,
          });
        }
      }

      const score = matchConfidence * 100 + steps.length * this.config.graphBoostWeight;
      results.push({
        id: entity.id,
        title: entity.name,
        excerpt: entity.content.slice(0, 200),
        score,
        reasons: [`图谱实体匹配 (kind=${entity.kind}, confidence=${entity.confidence.toFixed(2)})`],
        evidenceChain: {
          query,
          steps,
          totalConfidence: matchConfidence,
        },
        source: "graph",
        entityId: entity.id,
        entityKind: entity.kind,
      });
    }

    return results;
  }

  // ─── Phase 3: 融合去重 + 交叉链接 ─────────────────────────────────────

  private phaseMergeAndRank(
    keywordResults: RetrievalResult[],
    graphResults: RetrievalResult[],
    query: string,
  ): RetrievalResult[] {
    const merged = new Map<string, RetrievalResult>();

    // 加入关键词结果
    for (const r of keywordResults) {
      merged.set(r.id, r);
    }

    // 加入图谱结果，检测交叉链接
    for (const gr of graphResults) {
      const existing = merged.get(gr.id);
      if (existing) {
        // 同一 ID — 合并为 hybrid
        existing.source = "hybrid";
        existing.score += gr.score * 0.5; // 图谱结果半加权合并
        existing.reasons.push(...gr.reasons);
        existing.evidenceChain.steps.push(...gr.evidenceChain.steps);
        existing.evidenceChain.totalConfidence = Math.max(
          existing.evidenceChain.totalConfidence,
          gr.evidenceChain.totalConfidence,
        );
        existing.entityId = gr.entityId;
        existing.entityKind = gr.entityKind;
      } else {
        // 名称交叉链接：关键词结果的标题与图谱实体名匹配
        const crossLinked = this.detectCrossLink(gr, keywordResults, query);
        if (crossLinked) {
          gr.score += this.config.crossLinkBoost;
          gr.source = "hybrid";
          gr.evidenceChain.steps.push({
            type: "relation_boost",
            source: crossLinked.title,
            target: gr.id,
            confidence: 0.8,
            reasoning: `交叉链接：关键词结果 "${crossLinked.title}" 与图谱实体 "${gr.title}" 名称关联`,
          });
        }
        merged.set(gr.id, gr);
      }
    }

    // 按得分降序
    return Array.from(merged.values()).sort((a, b) => b.score - a.score);
  }

  /** 检测图谱结果是否与某个关键词结果名称关联 */
  private detectCrossLink(
    graphResult: RetrievalResult,
    keywordResults: RetrievalResult[],
    _query: string,
  ): RetrievalResult | null {
    const graphTokens = new Set(tokenize(graphResult.title));
    for (const kw of keywordResults) {
      const kwTokens = tokenize(kw.title);
      let overlap = 0;
      for (const t of kwTokens) {
        if (graphTokens.has(t)) overlap++;
      }
      if (overlap >= 1) return kw;
    }
    return null;
  }

  // ─── 辅助方法 ─────────────────────────────────────────────────────────

  /** 计算实体与查询的匹配置信度 */
  private computeEntityConfidence(entity: KnowledgeEntity, queryTokens: string[]): number {
    if (queryTokens.length === 0) return entity.confidence * 0.5;
    const nameTokens = new Set(tokenize(entity.name));
    const contentTokens = new Set(tokenize(entity.content));
    let nameHits = 0;
    let contentHits = 0;
    for (const t of queryTokens) {
      if (nameTokens.has(t)) nameHits++;
      if (contentTokens.has(t)) contentHits++;
    }
    const nameScore = nameHits / queryTokens.length;
    const contentScore = contentHits / queryTokens.length;
    // 名称匹配权重 0.6，内容匹配权重 0.2，实体自身置信度 0.2
    return Math.min(nameScore * 0.6 + contentScore * 0.2 + entity.confidence * 0.2, 1);
  }

  // ─── 缓存管理 ─────────────────────────────────────────────────────────

  private cacheKey(query: string, options: RetrievalOptions): string {
    return `${query}::${options.limit ?? ""}::${options.graphDepth ?? ""}::${options.enableGraph ?? ""}`;
  }

  private getFromCache(key: string): CacheEntry | null {
    const entry = this.queryCache.get(key);
    if (!entry) {
      this.cacheMisses++;
      return null;
    }
    if (this.config.cacheTtlMs > 0 && Date.now() - entry.at > this.config.cacheTtlMs) {
      this.queryCache.delete(key);
      this.cacheMisses++;
      return null;
    }
    // LRU: 重新插入到末尾
    this.queryCache.delete(key);
    this.queryCache.set(key, entry);
    this.cacheHits++;
    return entry;
  }

  private putToCache(key: string, results: RetrievalResult[]): void {
    if (this.queryCache.size >= this.config.cacheMaxSize) {
      const oldest = this.queryCache.keys().next().value;
      if (oldest) this.queryCache.delete(oldest);
    }
    this.queryCache.set(key, { results, at: Date.now() });
  }

  // ─── GraphRAG 多跳检索（Layer 1）──────────────────────────────────────

  /**
   * GraphRAG 多跳检索 — 返回结果 + 完整证据路径
   *
   * 与 retrieve() 的区别：
   *   - 多跳 BFS 遍历（默认 3 跳），将遍历到的实体也作为结果返回（提升召回率）
   *   - 每条路径编译为 GraphRAGPath，含完整跳转序列与人类可读推理摘要
   *   - 适用于复杂多步推理问题（方向一 GraphRAG）
   *
   * @param maxDepth 最大遍历深度（默认 config.graphRagMaxDepth=3）
   */
  retrieveWithPaths(
    query: string,
    options: RetrievalOptions & { maxDepth?: number } = {},
  ): GraphRAGResponse {
    const startTime = performance.now();
    if (!query || query.trim().length === 0) {
      return {
        results: [],
        paths: [],
        metrics: {
          latencyMs: 0, cacheHit: false, keywordPhaseMs: 0, graphPhaseMs: 0, mergePhaseMs: 0,
          keywordResults: 0, graphResults: 0, totalResults: 0,
        },
      };
    }

    const limit = options.limit ?? this.config.keywordLimit;
    const maxDepth = options.maxDepth ?? this.config.graphRagMaxDepth;

    // Phase 1: 基础检索（复用 Layer 0）
    const baseResponse = this.retrieve(query, { ...options, enableCache: false });
    const baseResults = baseResponse.results;

    // Phase 2: 多跳遍历 + 路径编译
    const phase2Start = performance.now();
    const queryTokens = tokenize(query);

    // 找到直接匹配的实体（来自图谱结果）
    const startEntities = baseResults
      .filter((r) => r.entityId !== undefined)
      .map((r) => this.graph.get(r.entityId!))
      .filter((e): e is KnowledgeEntity => e !== undefined);

    const { traversedResults, paths } = this.multiHopTraversal(startEntities, maxDepth, query, queryTokens);
    const graphPhaseMs = Math.round(performance.now() - phase2Start);

    // Phase 3: 合并基础结果 + 遍历结果（去重）
    const phase3Start = performance.now();
    const merged = this.mergeWithTraversed(baseResults, traversedResults, query);
    const mergePhaseMs = Math.round(performance.now() - phase3Start);

    const results = merged.slice(0, limit);

    const metrics: RetrievalMetrics = {
      latencyMs: Math.round(performance.now() - startTime),
      cacheHit: false,
      keywordPhaseMs: baseResponse.metrics.keywordPhaseMs,
      graphPhaseMs: graphPhaseMs + baseResponse.metrics.graphPhaseMs,
      mergePhaseMs,
      keywordResults: baseResponse.metrics.keywordResults,
      graphResults: baseResponse.metrics.graphResults + traversedResults.length,
      totalResults: results.length,
    };

    logger.debug("[DRE/GraphRAG] 多跳检索完成", {
      query: query.slice(0, 50),
      paths: paths.length,
      ...metrics,
    });

    return { results, paths, metrics };
  }

  /**
   * 多跳 BFS 遍历 — 从起始实体出发，沿关系边遍历，编译证据路径
   */
  private multiHopTraversal(
    startEntities: KnowledgeEntity[],
    maxDepth: number,
    query: string,
    queryTokens: string[],
  ): { traversedResults: RetrievalResult[]; paths: GraphRAGPath[] } {
    const traversedResults: RetrievalResult[] = [];
    const paths: GraphRAGPath[] = [];
    const directIds = new Set(startEntities.map((e) => e.id));

    for (const start of startEntities) {
      let pathCount = 0;
      // BFS 队列：{ entity, hops, visited, confidence }
      const queue: Array<{
        entity: KnowledgeEntity;
        hops: GraphRAGHop[];
        visited: Set<string>;
        confidence: number;
      }> = [{
        entity: start,
        hops: [],
        visited: new Set([start.id]),
        confidence: start.confidence,
      }];

      while (queue.length > 0 && pathCount < this.config.graphRagMaxPathsPerStart) {
        const current = queue.shift()!;
        if (current.hops.length >= maxDepth) continue;

        const links = this.graph.getLinksFrom(current.entity.id);
        for (const link of links) {
          if (current.visited.has(link.dst)) continue; // 环检测
          const nextEntity = this.graph.get(link.dst);
          if (!nextEntity) continue;

          const hopConfidence = link.weight * current.confidence * this.config.graphRagConfidenceDecay;
          const newHops: GraphRAGHop[] = [...current.hops, {
            entityId: nextEntity.id,
            entityName: nextEntity.name,
            relation: link.relation,
            confidence: hopConfidence,
          }];
          const newVisited = new Set(current.visited);
          newVisited.add(nextEntity.id);

          // 编译路径（仅对非直接匹配的实体）
          if (!directIds.has(nextEntity.id)) {
            const path: GraphRAGPath = {
              query,
              startEntityId: start.id,
              startEntityName: start.name,
              hops: newHops,
              endEntityId: nextEntity.id,
              endEntityName: nextEntity.name,
              endEntityContent: nextEntity.content.slice(0, 200),
              pathConfidence: hopConfidence,
              reasoning: this.compilePathReasoning(start.name, newHops),
            };
            paths.push(path);
            pathCount++;

            // 添加为遍历结果（得分按跳数衰减）
            const decayedScore = hopConfidence * 100;
            traversedResults.push({
              id: nextEntity.id,
              title: nextEntity.name,
              excerpt: nextEntity.content.slice(0, 200),
              score: decayedScore,
              reasons: [`多跳遍历（${newHops.length} 跳）：${path.reasoning}`],
              evidenceChain: {
                query,
                steps: [
                  {
                    type: "graph_entity",
                    source: query,
                    target: start.id,
                    confidence: start.confidence,
                    reasoning: `起始实体匹配：${start.name}`,
                  },
                  ...newHops.map((h) => ({
                    type: "graph_traverse" as const,
                    source: h.entityId,
                    target: h.entityId,
                    relation: h.relation,
                    confidence: h.confidence,
                    reasoning: `--${h.relation}--> ${h.entityName}`,
                  })),
                ],
                totalConfidence: hopConfidence,
              },
              source: "graph",
              entityId: nextEntity.id,
              entityKind: nextEntity.kind,
            });
          }

          // 继续扩展
          queue.push({
            entity: nextEntity,
            hops: newHops,
            visited: newVisited,
            confidence: hopConfidence,
          });
        }
      }
    }

    return { traversedResults, paths };
  }

  /** 编译人类可读的路径推理摘要 */
  private compilePathReasoning(startName: string, hops: GraphRAGHop[]): string {
    const parts = [startName];
    for (const hop of hops) {
      parts.push(`--[${hop.relation}]-->`);
      parts.push(hop.entityName);
    }
    return parts.join(" ");
  }

  /** 合并基础结果与遍历结果（去重，保留较高分） */
  private mergeWithTraversed(
    baseResults: RetrievalResult[],
    traversedResults: RetrievalResult[],
    query: string,
  ): RetrievalResult[] {
    const merged = new Map<string, RetrievalResult>();
    for (const r of baseResults) merged.set(r.id, r);
    for (const tr of traversedResults) {
      const existing = merged.get(tr.id);
      if (!existing || tr.score > existing.score) {
        merged.set(tr.id, tr);
      }
    }
    return Array.from(merged.values()).sort((a, b) => b.score - a.score);
  }

  // ─── 公共 API（统计与维护）────────────────────────────────────────────

  /** 获取缓存统计 */
  getCacheStats(): { hits: number; misses: number; hitRate: number; size: number; maxSize: number } {
    const total = this.cacheHits + this.cacheMisses;
    return {
      hits: this.cacheHits,
      misses: this.cacheMisses,
      hitRate: total > 0 ? this.cacheHits / total : 0,
      size: this.queryCache.size,
      maxSize: this.config.cacheMaxSize,
    };
  }

  /** 清空查询缓存 */
  clearCache(): void {
    this.queryCache.clear();
    this.cacheHits = 0;
    this.cacheMisses = 0;
  }

  /** 获取图谱统计（透传） */
  getGraphStats(): ReturnType<typeof knowledgeNetwork.getStats> {
    return this.graph.getStats();
  }
}

// ─── 单例 ───────────────────────────────────────────────────────────────

let _instance: DeterministicRetrievalEngine | null = null;

/**
 * 获取确定性检索引擎单例。
 * keywordSearcher 默认为 null（无 Vault 时仅用图谱检索）；
 * 在 Vault 可用时由调用方通过 setKeywordSearcher 注入。
 */
export function getRetrievalEngine(): DeterministicRetrievalEngine {
  if (!_instance) _instance = new DeterministicRetrievalEngine();
  return _instance;
}

/** 注入关键词检索器（Vault 初始化后调用） */
export function setKeywordSearcher(searcher: KeywordSearcher | null): void {
  const engine = getRetrievalEngine();
  // 重建实例以注入 searcher（保持单例语义）
  _instance = new DeterministicRetrievalEngine({
    keywordSearcher: searcher,
    config: {
      cacheMaxSize: engine["config"].cacheMaxSize,
      cacheTtlMs: engine["config"].cacheTtlMs,
      keywordLimit: engine["config"].keywordLimit,
      graphLimit: engine["config"].graphLimit,
      defaultGraphDepth: engine["config"].defaultGraphDepth,
      graphBoostWeight: engine["config"].graphBoostWeight,
      crossLinkBoost: engine["config"].crossLinkBoost,
    },
  });
}

/** 测试用：重置单例 */
export function _resetRetrievalEngineForTest(): void {
  _instance = null;
}

/** 测试用：设置自定义实例 */
export function _setRetrievalEngineForTest(engine: DeterministicRetrievalEngine | null): void {
  _instance = engine;
}
