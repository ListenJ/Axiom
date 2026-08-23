/**
 * 统一搜索接口
 * 合并 SearchAggregator + EnhancedSearchAggregator 为单一入口
 *
 * 搜索引擎优先级：SearXNG > Bing > DDG（国内可用性优先）
 * 功能：LRU缓存、查询优化、相关性评分、去重、搜索历史
 */
import {
  searchAggregator,
  type SearchEngineResult,
  type SearchOptions,
} from "./search-engines.js";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";

/** L12a：SHA-256 强缓存键（替代 32 位弱 hash，消除串缓存碰撞面） */
export function strongCacheKey(
  ...parts: Array<string | number | readonly (string | number)[]>
): string {
  const flat = parts.flatMap((p) => (Array.isArray(p) ? p.map(String) : [String(p)]));
  return "cache_" + createHash("sha256").update(flat.join("|")).digest("hex").slice(0, 32);
}

// ========== 类型定义 ==========

export interface UnifiedSearchOptions extends SearchOptions {
  /** 搜索引擎列表（默认：SearXNG优先） */
  engines?: string[];
  /** 是否启用缓存 */
  useCache?: boolean;
  /** 缓存有效期（分钟） */
  cacheTtl?: number;
  /** 是否启用查询优化 */
  optimizeQuery?: boolean;
  /** 是否启用相关性重排序 */
  rerank?: boolean;
  /** 相关性评分阈值 */
  relevanceThreshold?: number;
  /** 是否去重 */
  dedup?: boolean;
  /** 是否记录搜索历史 */
  recordHistory?: boolean;
}

export interface UnifiedSearchResult extends SearchEngineResult {
  /** 搜索查询 */
  query: string;
  /** 相关性评分 (0-1) */
  relevanceScore: number;
  /** 原始引擎列表 */
  engines: string[];
  /** 搜索时间戳 */
  searchedAt: string;
}

export interface SearchHistory {
  id: number;
  query: string;
  engines: string;
  resultCount: number;
  latencyMs: number;
  createdAt: string;
}

export interface SearchStats {
  totalSearches: number;
  uniqueQueries: number;
  avgResults: number;
  avgLatency: number;
  topQueries: { query: string; count: number }[];
}

/** LRU 缓存条目 */
interface CacheEntry {
  results: UnifiedSearchResult[];
  timestamp: number;
}

// ========== 停用词 ==========

const STOP_WORDS = new Set([
  "the", "a", "an", "is", "are", "was", "were", "be", "been", "being",
  "have", "has", "had", "do", "does", "did", "will", "would", "could",
  "should", "may", "might", "can", "shall", "of", "in", "for", "on",
  "with", "at", "by", "from", "as", "to", "and", "or", "but", "not",
  "的", "了", "在", "是", "有", "和", "与", "或", "但", "从", "对",
  "为", "以", "就", "都", "而", "及", "等", "一个", "这个",
]);

// ========== 权威域名 ==========

const AUTHORITATIVE_DOMAINS = [
  "wikipedia.org", "github.com", "stackoverflow.com", "arxiv.org",
  "pubmed.ncbi.nlm.nih.gov", "scholar.google.com", "docs.python.org",
  "developer.mozilla.org", "apache.org", "npmjs.com", "go.dev",
  "rust-lang.org", "docs.microsoft.com", "cloud.google.com",
  "aws.amazon.com", "azure.microsoft.com",
];

// ========== 统一搜索聚合器 ==========

export class UnifiedSearch {
  private db: Database;
  private cache: Map<string, CacheEntry> = new Map();
  private cacheMaxSize = 100;

  /** 默认引擎优先级：SearXNG > Bing > DDG（国内可用性） */
  static readonly DEFAULT_ENGINES = ["searxng", "bing", "duckduckgo"];

  constructor(dbPath?: string) {
    this.db = new Database(dbPath || "./data/search-cache.db");
    this.initDatabase();
  }

  private initDatabase() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS search_cache (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        query TEXT NOT NULL,
        engines TEXT,
        results TEXT,
        created_at INTEGER DEFAULT (unixepoch())
      );
      CREATE INDEX IF NOT EXISTS idx_cache_query ON search_cache(query);
      CREATE INDEX IF NOT EXISTS idx_cache_time ON search_cache(created_at);

      CREATE TABLE IF NOT EXISTS search_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        query TEXT NOT NULL,
        engines TEXT,
        result_count INTEGER,
        latency_ms INTEGER,
        created_at INTEGER DEFAULT (unixepoch())
      );
      CREATE INDEX IF NOT EXISTS idx_hist_query ON search_history(query);
      CREATE INDEX IF NOT EXISTS idx_hist_time ON search_history(created_at);
    `);
  }

  // ========== 核心搜索 ==========

  /**
   * 统一搜索入口
   */
  async search(opts: UnifiedSearchOptions): Promise<UnifiedSearchResult[]> {
    const startTime = performance.now();
    const {
      query: rawQuery,
      engines = UnifiedSearch.DEFAULT_ENGINES,
      useCache = true,
      cacheTtl = 30,
      optimizeQuery = true,
      rerank = true,
      relevanceThreshold = 0.3,
      dedup = true,
      recordHistory = true,
      ...baseOpts
    } = opts;

    const query = optimizeQuery ? this.optimizeQuery(rawQuery) : rawQuery;

    // Cache check
    const cacheKey = this.buildCacheKey(query, engines, opts.num ?? 10, relevanceThreshold);
    if (useCache) {
      const cached = this.getFromCache(cacheKey, cacheTtl);
      if (cached) return cached;
    }

    // Multi-engine search
    const rawResults = await searchAggregator.searchMulti(
      { query, ...baseOpts },
      engines
    );

    if (rawResults.length === 0) return [];

    // Dedup
    const deduped = dedup ? this.deduplicate(rawResults) : rawResults;

    // Single-pass: convert → score → filter → reposition
    const queryWords = rerank ? this.extractKeywords(query) : [];
    const now = new Date().toISOString();
    const results: UnifiedSearchResult[] = [];

    for (let i = 0; i < deduped.length; i++) {
      const r = deduped[i];
      // toUnifiedResult (no spread)
      const unified: UnifiedSearchResult = {
        position: i + 1,
        title: r.title,
        link: r.link,
        displayedUrl: r.displayedUrl,
        snippet: r.snippet,
        date: r.date,
        source: r.source,
        engine: r.engine,
        richSnippets: r.richSnippets,
        query,
        relevanceScore: rerank ? this.calculateRelevance(r, queryWords, query) : 0,
        engines: [r.engine],
        searchedAt: now,
      };

      // Filter by threshold (skip if below)
      if (rerank && unified.relevanceScore < relevanceThreshold) continue;

      results.push(unified);
    }

    // Sort by relevance (stable, only if reranked)
    if (rerank) results.sort((a, b) => b.relevanceScore - a.relevanceScore);

    // Cache
    if (useCache) this.putToCache(cacheKey, results);

    // History
    if (recordHistory) {
      const latency = Math.round(performance.now() - startTime);
      this.recordHistory(query, engines, results.length, latency);
    }

    return results;
  }

  // ========== 便捷方法 ==========

  /** 快速搜索 */
  async quickSearch(query: string, num = 10): Promise<UnifiedSearchResult[]> {
    return this.search({ query, num, engines: ["searxng", "duckduckgo"] });
  }

  /** 深度搜索（多引擎） */
  async deepSearch(query: string, num = 20): Promise<UnifiedSearchResult[]> {
    return this.search({
      query,
      num,
      engines: ["searxng", "bing", "duckduckgo"],
      rerank: true,
      relevanceThreshold: 0.2,
    });
  }

  /** 学术搜索 */
  async academicSearch(query: string, num = 15): Promise<UnifiedSearchResult[]> {
    const academicQuery = `${query} site:arxiv.org OR site:scholar.google.com OR site:pubmed.ncbi.nlm.nih.gov`;
    return this.search({
      query: academicQuery,
      num,
      engines: ["searxng", "bing"],
      rerank: true,
      relevanceThreshold: 0.25,
    });
  }

  /** 新闻搜索 */
  async newsSearch(query: string, num = 15): Promise<UnifiedSearchResult[]> {
    return this.search({
      query,
      num,
      engines: ["searxng", "bing"],
      timeRange: "w",
      rerank: true,
      relevanceThreshold: 0.2,
    });
  }

  /** 代码搜索 */
  async codeSearch(query: string, num = 15): Promise<UnifiedSearchResult[]> {
    const codeQuery = `${query} site:github.com OR site:stackoverflow.com OR site:developer.mozilla.org`;
    return this.search({
      query: codeQuery,
      num,
      engines: ["searxng", "duckduckgo"],
      rerank: true,
      relevanceThreshold: 0.3,
    });
  }

  // ========== 查询优化 ==========

  private optimizeQuery(query: string): string {
    let optimized = query.trim().replace(/\s+/g, " ");
    // 补全未闭合引号
    if ((optimized.match(/"/g) || []).length % 2 === 1) {
      optimized += '"';
    }
    return optimized;
  }

  // ========== 缓存管理 ==========

  private buildCacheKey(query: string, engines: string[], num: number, threshold: number): string {
    // 纳入 num 与 relevanceThreshold：quickSearch(num=10) 与 deepSearch(num=20) 须命中不同缓存键，
    // 否则会因缓存返回错误条数/过滤结果。
    return strongCacheKey(query, engines.join(","), num, threshold);
  }

  private getFromCache(key: string, ttlMinutes: number): UnifiedSearchResult[] | null {
    // 内存缓存
    const entry = this.cache.get(key);
    if (entry && (Date.now() - entry.timestamp) / 1000 / 60 < ttlMinutes) {
      return entry.results;
    }
    this.cache.delete(key);

    // 数据库缓存
    const stmt = this.db.prepare(`
      SELECT results FROM search_cache
      WHERE query = ? AND (unixepoch() - created_at) < ?
      ORDER BY created_at DESC LIMIT 1
    `);
    const row = stmt.get(key, ttlMinutes * 60) as { results: string } | undefined;
    if (row) {
      try { return JSON.parse(row.results); } catch { return null; }
    }
    return null;
  }

  private putToCache(key: string, results: UnifiedSearchResult[]) {
    if (this.cache.size >= this.cacheMaxSize) {
      const firstKey = this.cache.keys().next().value;
      if (firstKey) this.cache.delete(firstKey);
    }
    this.cache.set(key, { results, timestamp: Date.now() });

    // 异步写入数据库缓存
    try {
      this.db.prepare(`
        INSERT INTO search_cache (query, engines, results) VALUES (?, ?, ?)
      `).run(key, results[0]?.engines?.join(",") || "", JSON.stringify(results));
    } catch { /* ignore */ }
  }

  // ========== 结果处理 ==========

  private deduplicate(results: SearchEngineResult[]): SearchEngineResult[] {
    const seen = new Map<string, SearchEngineResult>();
    for (const r of results) {
      let key: string;
      try {
        const u = new URL(r.link);
        u.hash = "";
        ["utm_source", "utm_medium", "utm_campaign", "fbclid", "gclid"].forEach(
          (p) => u.searchParams.delete(p)
        );
        key = `${u.hostname}${u.pathname}`;
      } catch {
        key = r.link;
      }
      const existing = seen.get(key);
      if (!existing) {
        seen.set(key, r);
      } else {
        if (r.snippet.length > existing.snippet.length) existing.snippet = r.snippet;
        if (r.date && !existing.date) existing.date = r.date;
        if (!existing.engine.includes(r.engine)) existing.engine += `+${r.engine}`;
      }
    }
    return Array.from(seen.values());
  }

  // ========== 相关性评分 ==========

  private extractKeywords(text: string): string[] {
    return text
      .toLowerCase()
      .replace(/[^\w\s\u4e00-\u9fff]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 1 && !STOP_WORDS.has(w));
  }

  private calculateRelevance(result: SearchEngineResult, queryWords: string[], query: string): number {
    let score = 0;
    const text = `${result.title} ${result.snippet}`.toLowerCase();
    const words = this.extractKeywords(text);

    // 关键词匹配度 (0-0.4)
    const matched = queryWords.filter((qw) => words.some((w) => w.includes(qw) || qw.includes(w)));
    score += (matched.length / Math.max(queryWords.length, 1)) * 0.4;

    // 标题匹配 (0-0.25)
    const titleLower = result.title.toLowerCase();
    if (titleLower.includes(query.toLowerCase())) {
      score += 0.25;
    } else {
      const titleMatches = queryWords.filter((w) => titleLower.includes(w)).length;
      score += (titleMatches / queryWords.length) * 0.2;
    }

    // 来源权威性 (0-0.2)
    if (AUTHORITATIVE_DOMAINS.some((d) => result.source.includes(d))) {
      score += 0.2;
    }

    // 新鲜度 (0-0.1)
    if (result.date) {
      const daysAgo = (Date.now() - new Date(result.date).getTime()) / (1000 * 60 * 60 * 24);
      if (daysAgo < 7) score += 0.1;
      else if (daysAgo < 30) score += 0.07;
      else if (daysAgo < 90) score += 0.05;
    }

    return Math.min(score, 1);
  }

  // ========== 历史记录 ==========

  private recordHistory(query: string, engines: string[], resultCount: number, latencyMs: number) {
    try {
      this.db.prepare(`
        INSERT INTO search_history (query, engines, result_count, latency_ms) VALUES (?, ?, ?, ?)
      `).run(query, engines.join(","), resultCount, latencyMs);
    } catch { /* ignore */ }
  }

  /** 获取搜索统计 */
  getStats(days = 7): SearchStats {
    const since = Math.floor(Date.now() / 1000) - days * 86400;

    const total = this.db.prepare(`
      SELECT COUNT(*) as c, AVG(result_count) as avg_r, AVG(latency_ms) as avg_l
      FROM search_history WHERE created_at >= ?
    `).get(since) as { c: number; avg_r: number; avg_l: number };

    const unique = this.db.prepare(`
      SELECT COUNT(DISTINCT query) as c FROM search_history WHERE created_at >= ?
    `).get(since) as { c: number };

    const topQueries = this.db.prepare(`
      SELECT query, COUNT(*) as count FROM search_history
      WHERE created_at >= ? GROUP BY query ORDER BY count DESC LIMIT 10
    `).all(since) as { query: string; count: number }[];

    return {
      totalSearches: total.c || 0,
      uniqueQueries: unique.c || 0,
      avgResults: Math.round(total.avg_r || 0),
      avgLatency: Math.round(total.avg_l || 0),
      topQueries,
    };
  }

  /** 获取搜索历史 */
  getHistory(limit = 50, offset = 0): SearchHistory[] {
    return this.db.prepare(`
      SELECT * FROM search_history ORDER BY created_at DESC LIMIT ? OFFSET ?
    `).all(limit, offset) as SearchHistory[];
  }

  /** 清除缓存 */
  clearCache() {
    this.cache.clear();
    this.db.exec("DELETE FROM search_cache");
  }

  /** 清除历史 */
  clearHistory() {
    this.db.exec("DELETE FROM search_history");
  }

  /** 关闭数据库 */
  close() {
    this.db.close();
  }
}

/** 全局统一搜索实例 */
export const unifiedSearch = new UnifiedSearch();
