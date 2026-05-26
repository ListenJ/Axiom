/**
 * 增强搜索聚合器
 * 提供缓存、查询优化、内容增强、相关性评分等功能
 */
import { searchAggregator as baseAggregator, SearchEngineResult, SearchOptions } from "./search-engines.js";
import { DataPipeline } from "./data-pipeline.js";
import { Database } from "bun:sqlite";

export interface EnhancedSearchOptions extends SearchOptions {
  /** 搜索引擎列表 */
  engines?: string[];
  /** 是否启用缓存 */
  useCache?: boolean;
  /** 缓存有效期（分钟） */
  cacheTtl?: number;
  /** 是否自动获取页面内容增强摘要 */
  enhanceContent?: boolean;
  /** 增强摘要最大长度 */
  enhanceMaxLength?: number;
  /** 是否启用查询优化 */
  optimizeQuery?: boolean;
  /** 是否启用相关性重排序 */
  rerank?: boolean;
  /** 相关性评分阈值 */
  relevanceThreshold?: number;
  /** 是否去重（基于URL和内容相似度） */
  dedup?: boolean;
  /** 是否记录搜索历史 */
  recordHistory?: boolean;
  /** 用户ID（用于个性化和记录） */
  userId?: string;
  /** 会话ID */
  sessionId?: string;
}

export interface EnhancedSearchResult extends SearchEngineResult {
  /** 搜索查询 */
  query: string;
  /** 相关性评分 (0-1) */
  relevanceScore: number;
  /** 内容摘要（增强后的） */
  enhancedSnippet?: string;
  /** 内容质量评分 (0-1) */
  contentQuality?: number;
  /** 是否为权威来源 */
  isAuthoritative?: boolean;
  /** 结果新鲜度 (0-1) */
  freshness?: number;
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
  userId?: string;
  sessionId?: string;
  createdAt: string;
}

export interface SearchStats {
  totalSearches: number;
  uniqueQueries: number;
  avgResults: number;
  avgLatency: number;
  topQueries: { query: string; count: number }[];
  topEngines: { engine: string; count: number }[];
  hourlyDistribution: Record<number, number>;
}

/** LRU 缓存条目 */
interface CacheEntry {
  results: EnhancedSearchResult[];
  timestamp: number;
  query: string;
  engines: string[];
}

/**
 * 增强搜索聚合器
 * 提供完整的搜索功能增强
 */
export class EnhancedSearchAggregator {
  private db: Database;
  private cache: Map<string, CacheEntry> = new Map();
  private cacheMaxSize = 100;
  private pipeline: DataPipeline;
  private stopWords: Set<string>;

  constructor(dbPath?: string) {
    this.db = new Database(dbPath || "./data/search-cache.db");
    this.initDatabase();
    this.pipeline = new DataPipeline();
    this.stopWords = new Set([
      "the", "a", "an", "is", "are", "was", "were", "be", "been", "being",
      "have", "has", "had", "do", "does", "did", "will", "would", "could",
      "should", "may", "might", "can", "shall", "of", "in", "for", "on",
      "with", "at", "by", "from", "as", "to", "and", "or", "but", "not",
      "的", "了", "在", "是", "有", "和", "与", "或", "但", "从", "对",
      "为", "以", "就", "都", "而", "及", "等", "或", "一个", "这个",
    ]);
  }

  private initDatabase() {
    // 搜索缓存表
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
    `);

    // 搜索历史表
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS search_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        query TEXT NOT NULL,
        engines TEXT,
        result_count INTEGER,
        latency_ms INTEGER,
        user_id TEXT,
        session_id TEXT,
        created_at INTEGER DEFAULT (unixepoch())
      );
      CREATE INDEX IF NOT EXISTS idx_hist_query ON search_history(query);
      CREATE INDEX IF NOT EXISTS idx_hist_user ON search_history(user_id);
      CREATE INDEX IF NOT EXISTS idx_hist_session ON search_history(session_id);
      CREATE INDEX IF NOT EXISTS idx_hist_time ON search_history(created_at);
    `);

    // 搜索统计表（按日聚合）
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS search_stats (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        date TEXT NOT NULL,
        query TEXT NOT NULL,
        engine TEXT,
        count INTEGER DEFAULT 1,
        avg_results REAL,
        avg_latency REAL,
        UNIQUE(date, query, engine)
      );
      CREATE INDEX IF NOT EXISTS idx_stats_date ON search_stats(date);
    `);
  }

  /**
   * 执行增强搜索
   * 完整的搜索流程：查询优化 → 缓存检查 → 多引擎搜索 → 内容增强 → 相关性评分 → 去重 → 缓存存储
   */
  async search(opts: EnhancedSearchOptions): Promise<EnhancedSearchResult[]> {
    const startTime = performance.now();
    const {
      query: rawQuery,
      engines = ["duckduckgo", "searxng"],
      useCache = true,
      cacheTtl = 30,
      enhanceContent = false,
      enhanceMaxLength = 500,
      optimizeQuery = true,
      rerank = true,
      relevanceThreshold = 0.3,
      dedup = true,
      recordHistory = true,
      userId,
      sessionId,
      ...baseOpts
    } = opts;

    // 1. 查询优化
    const query = optimizeQuery ? this.optimizeQuery(rawQuery) : rawQuery;

    // 2. 检查缓存
    const cacheKey = this.buildCacheKey(query, engines, baseOpts);
    if (useCache) {
      const cached = this.getFromCache(cacheKey, cacheTtl);
      if (cached) {
        console.log(`[EnhancedSearch] Cache hit for: "${query}"`);
        return cached;
      }
    }

    // 3. 执行多引擎搜索
    console.log(`[EnhancedSearch] Searching: "${query}" via [${engines.join(", ")}]`);
    const rawResults = await baseAggregator.searchMulti(
      { query, ...baseOpts },
      engines
    );

    if (rawResults.length === 0) {
      console.log("[EnhancedSearch] No results found");
      return [];
    }

    // 4. 去重
    let results = dedup ? this.deduplicate(rawResults) : rawResults;

    // 5. 转换为增强结果
    let enhanced = results.map((r, i) => this.toEnhancedResult(r, query, i + 1));

    // 6. 内容增强（可选）
    if (enhanceContent) {
      enhanced = await this.enhanceResults(enhanced, enhanceMaxLength);
    }

    // 7. 相关性评分
    if (rerank) {
      enhanced = this.scoreAndRerank(enhanced, query);
      // 过滤低相关性结果
      enhanced = enhanced.filter((r) => r.relevanceScore >= relevanceThreshold);
    }

    // 8. 更新位置
    enhanced = enhanced.map((r, i) => ({ ...r, position: i + 1 }));

    // 9. 缓存结果
    if (useCache) {
      this.putToCache(cacheKey, enhanced);
      this.saveToDbCache(query, engines, enhanced);
    }

    // 10. 记录历史
    if (recordHistory) {
      const latency = Math.round(performance.now() - startTime);
      this.recordHistory(query, engines, enhanced.length, latency, userId, sessionId);
    }

    console.log(`[EnhancedSearch] Found ${enhanced.length} results in ${Math.round(performance.now() - startTime)}ms`);
    return enhanced;
  }

  /**
   * 快速搜索（简化版）
   */
  async quickSearch(query: string, num = 10): Promise<EnhancedSearchResult[]> {
    return this.search({
      query,
      num,
      useCache: true,
      enhanceContent: false,
      rerank: true,
      recordHistory: true,
    });
  }

  /**
   * 深度搜索（完整版）
   */
  async deepSearch(query: string, num = 20): Promise<EnhancedSearchResult[]> {
    return this.search({
      query,
      num,
      engines: ["duckduckgo", "searxng", "bing"],
      useCache: true,
      enhanceContent: true,
      enhanceMaxLength: 800,
      optimizeQuery: true,
      rerank: true,
      relevanceThreshold: 0.2,
      dedup: true,
      recordHistory: true,
    });
  }

  /**
   * 学术搜索
   */
  async academicSearch(query: string, num = 15): Promise<EnhancedSearchResult[]> {
    const academicQuery = `${query} site:arxiv.org OR site:scholar.google.com OR site:pubmed.ncbi.nlm.nih.gov OR filetype:pdf`;
    return this.search({
      query: academicQuery,
      num,
      engines: ["duckduckgo", "searxng"],
      useCache: true,
      enhanceContent: true,
      rerank: true,
      relevanceThreshold: 0.25,
      recordHistory: true,
    });
  }

  /**
   * 新闻搜索
   */
  async newsSearch(query: string, num = 15): Promise<EnhancedSearchResult[]> {
    return this.search({
      query,
      num,
      engines: ["duckduckgo", "searxng"],
      timeRange: "w",
      useCache: true,
      enhanceContent: true,
      rerank: true,
      relevanceThreshold: 0.2,
      recordHistory: true,
    });
  }

  /**
   * 代码搜索
   */
  async codeSearch(query: string, num = 15): Promise<EnhancedSearchResult[]> {
    const codeQuery = `${query} site:github.com OR site:stackoverflow.com OR site:docs.python.org OR site:developer.mozilla.org`;
    return this.search({
      query: codeQuery,
      num,
      engines: ["duckduckgo", "searxng"],
      useCache: true,
      enhanceContent: false,
      rerank: true,
      relevanceThreshold: 0.3,
      recordHistory: true,
    });
  }

  // ========== 查询优化 ==========

  /**
   * 优化搜索查询
   */
  private optimizeQuery(query: string): string {
    let optimized = query.trim();

    // 移除多余空格
    optimized = optimized.replace(/\s+/g, " ");

    // 自动补全引号
    const openQuotes = (optimized.match(/"/g) || []).length;
    if (openQuotes % 2 === 1) {
      optimized += '"';
    }

    // 如果查询过短，添加上下文
    if (optimized.length < 10 && !optimized.includes(" ")) {
      // 保持原样，单字查询可能是特定术语
    }

    return optimized;
  }

  /**
   * 获取搜索建议（基于历史记录）
   */
  getSuggestions(partial: string, limit = 5): string[] {
    const stmt = this.db.prepare(`
      SELECT DISTINCT query, COUNT(*) as freq
      FROM search_history
      WHERE query LIKE ?
      GROUP BY query
      ORDER BY freq DESC, created_at DESC
      LIMIT ?
    `);
    const rows = stmt.all(`%${partial}%`, limit) as Array<{ query: string; freq: number }>;
    return rows.map((r) => r.query);
  }

  /**
   * 获取相关搜索（基于共现）
   */
  getRelatedQueries(query: string, limit = 5): string[] {
    const stmt = this.db.prepare(`
      SELECT DISTINCT h2.query, COUNT(*) as freq
      FROM search_history h1
      JOIN search_history h2 ON h1.session_id = h2.session_id
      WHERE h1.query = ? AND h2.query != ?
      GROUP BY h2.query
      ORDER BY freq DESC
      LIMIT ?
    `);
    const rows = stmt.all(query, query, limit) as Array<{ query: string; freq: number }>;
    return rows.map((r) => r.query);
  }

  // ========== 缓存管理 ==========

  private buildCacheKey(query: string, engines: string[], opts: any): string {
    const key = JSON.stringify({ query, engines, opts });
    // 简单的哈希
    let hash = 0;
    for (let i = 0; i < key.length; i++) {
      const char = key.charCodeAt(i);
      hash = ((hash << 5) - hash + char) | 0;
    }
    return `cache_${hash}`;
  }

  private getFromCache(key: string, ttlMinutes: number): EnhancedSearchResult[] | null {
    // 内存缓存
    const entry = this.cache.get(key);
    if (entry) {
      const age = (Date.now() - entry.timestamp) / 1000 / 60;
      if (age < ttlMinutes) {
        return entry.results;
      }
      this.cache.delete(key);
    }

    // 数据库缓存
    const ttlSeconds = ttlMinutes * 60;
    const stmt = this.db.prepare(`
      SELECT results FROM search_cache
      WHERE query = ? AND (unixepoch() - created_at) < ?
      ORDER BY created_at DESC LIMIT 1
    `);
    const row = stmt.get(key, ttlSeconds) as { results: string } | undefined;
    if (row) {
      try {
        return JSON.parse(row.results);
      } catch {
        return null;
      }
    }

    return null;
  }

  private putToCache(key: string, results: EnhancedSearchResult[]) {
    // LRU 淘汰
    if (this.cache.size >= this.cacheMaxSize) {
      const firstKey = this.cache.keys().next().value as string | undefined;
      if (firstKey) this.cache.delete(firstKey);
    }
    this.cache.set(key, {
      results,
      timestamp: Date.now(),
      query: results[0]?.query || "",
      engines: results[0]?.engines || [],
    });
  }

  private saveToDbCache(query: string, engines: string[], results: EnhancedSearchResult[]) {
    try {
      const stmt = this.db.prepare(`
        INSERT INTO search_cache (query, engines, results, created_at)
        VALUES (?, ?, ?, unixepoch())
      `);
      stmt.run(query, engines.join(","), JSON.stringify(results));

      // 清理旧缓存（保留最近1000条）
      this.db.exec(`
        DELETE FROM search_cache WHERE id NOT IN (
          SELECT id FROM search_cache ORDER BY created_at DESC LIMIT 1000
        )
      `);
    } catch (e) {
      console.error("[EnhancedSearch] Cache save failed:", e);
    }
  }

  // ========== 结果处理 ==========

  private toEnhancedResult(
    r: SearchEngineResult,
    query: string,
    position: number
  ): EnhancedSearchResult {
    return {
      ...r,
      query,
      position,
      relevanceScore: 0,
      engines: [r.engine],
      searchedAt: new Date().toISOString(),
    };
  }

  private deduplicate(results: SearchEngineResult[]): SearchEngineResult[] {
    const seen = new Map<string, SearchEngineResult>();

    for (const r of results) {
      // 规范化 URL
      let key: string;
      try {
        const u = new URL(r.link);
        u.hash = "";
        ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "fbclid", "gclid"].forEach(
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
        // 合并引擎信息
        if (!existing.engine.includes(r.engine)) {
          existing.engine += `+${r.engine}`;
        }
        // 保留更长的摘要
        if (r.snippet.length > existing.snippet.length) {
          existing.snippet = r.snippet;
        }
        // 保留日期
        if (r.date && !existing.date) {
          existing.date = r.date;
        }
      }
    }

    return Array.from(seen.values());
  }

  /**
   * 内容增强：获取页面内容并生成更好的摘要
   */
  private async enhanceResults(
    results: EnhancedSearchResult[],
    maxLength: number
  ): Promise<EnhancedSearchResult[]> {
    const enhanced = [...results];

    // 只增强前 5 个结果（避免过多请求）
    const toEnhance = enhanced.slice(0, 5);

    await Promise.all(
      toEnhance.map(async (r) => {
        try {
          const crawlResult = await this.pipeline.crawlStructured(r.link, 0);
          if (crawlResult && crawlResult.markdown) {
            const content = crawlResult.markdown.slice(0, maxLength * 2);
            r.enhancedSnippet = this.generateSummary(content, maxLength);
            r.contentQuality = this.assessContentQuality(content);
          }
        } catch (e) {
          // 增强失败不影响主结果
          console.warn(`[EnhancedSearch] Enhance failed for ${r.link}:`, (e as Error).message);
        }
      })
    );

    return enhanced;
  }

  private generateSummary(content: string, maxLength: number): string {
    // 移除 markdown 标记
    const clean = content
      .replace(/#{1,6}\s/g, "")
      .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
      .replace(/[*_`]/g, "")
      .replace(/\n+/g, " ")
      .trim();

    if (clean.length <= maxLength) return clean;

    // 在句子边界截断
    const truncated = clean.slice(0, maxLength);
    const lastPeriod = truncated.lastIndexOf(".");
    const lastChinese = truncated.lastIndexOf("。");
    const cutAt = Math.max(lastPeriod, lastChinese);

    if (cutAt > maxLength * 0.7) {
      return truncated.slice(0, cutAt + 1);
    }

    return truncated + "...";
  }

  private assessContentQuality(content: string): number {
    let score = 0.5;

    // 长度评分
    if (content.length > 1000) score += 0.15;
    else if (content.length > 500) score += 0.1;
    else if (content.length > 200) score += 0.05;

    // 结构化内容评分
    if (content.includes("# ")) score += 0.1;
    if (content.includes("```")) score += 0.1;
    if (/\d+\.\s+\w+/.test(content)) score += 0.05;

    // 链接丰富度
    const linkCount = (content.match(/\[.*?\]\(.*?\)/g) || []).length;
    if (linkCount > 3) score += 0.1;

    return Math.min(score, 1);
  }

  // ========== 相关性评分 ==========

  private scoreAndRerank(results: EnhancedSearchResult[], query: string): EnhancedSearchResult[] {
    const queryWords = this.extractKeywords(query);

    const scored = results.map((r) => {
      const score = this.calculateRelevance(r, queryWords, query);
      return { ...r, relevanceScore: score };
    });

    // 按相关性降序排列
    scored.sort((a, b) => b.relevanceScore - a.relevanceScore);

    return scored;
  }

  private extractKeywords(text: string): string[] {
    return text
      .toLowerCase()
      .replace(/[^\w\s\u4e00-\u9fff]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 1 && !this.stopWords.has(w));
  }

  private calculateRelevance(
    result: EnhancedSearchResult,
    queryWords: string[],
    query: string
  ): number {
    let score = 0;
    const text = `${result.title} ${result.snippet} ${result.enhancedSnippet || ""}`.toLowerCase();
    const words = this.extractKeywords(text);

    // 1. 关键词匹配度 (0-0.4)
    let matchedWords = 0;
    for (const qw of queryWords) {
      if (words.some((w) => w.includes(qw) || qw.includes(w))) {
        matchedWords++;
      }
    }
    score += (matchedWords / Math.max(queryWords.length, 1)) * 0.4;

    // 2. 标题匹配 (0-0.25)
    const titleLower = result.title.toLowerCase();
    if (titleLower.includes(query.toLowerCase())) {
      score += 0.25;
    } else {
      const titleMatches = queryWords.filter((w) => titleLower.includes(w)).length;
      score += (titleMatches / queryWords.length) * 0.2;
    }

    // 3. 来源权威性 (0-0.2)
    if (result.isAuthoritative || this.isAuthoritativeDomain(result.source)) {
      score += 0.2;
    }

    // 4. 内容新鲜度 (0-0.1)
    if (result.date) {
      const date = new Date(result.date);
      const daysAgo = (Date.now() - date.getTime()) / (1000 * 60 * 60 * 24);
      if (daysAgo < 7) score += 0.1;
      else if (daysAgo < 30) score += 0.07;
      else if (daysAgo < 90) score += 0.05;
      else if (daysAgo < 365) score += 0.02;
    }

    // 5. 内容质量 (0-0.05)
    if (result.contentQuality) {
      score += result.contentQuality * 0.05;
    }

    return Math.min(score, 1);
  }

  private isAuthoritativeDomain(source: string): boolean {
    const authoritativeDomains = [
      "wikipedia.org",
      "github.com",
      "stackoverflow.com",
      "arxiv.org",
      "pubmed.ncbi.nlm.nih.gov",
      "scholar.google.com",
      "docs.python.org",
      "developer.mozilla.org",
      "apache.org",
      "npmjs.com",
      "mvnrepository.com",
      "cran.r-project.org",
      "kotlinlang.org",
      "go.dev",
      "rust-lang.org",
      "docs.microsoft.com",
      "cloud.google.com",
      "aws.amazon.com",
      "azure.microsoft.com",
    ];
    return authoritativeDomains.some((d) => source.includes(d));
  }

  // ========== 历史记录 ==========

  private recordHistory(
    query: string,
    engines: string[],
    resultCount: number,
    latencyMs: number,
    userId?: string,
    sessionId?: string
  ) {
    try {
      const stmt = this.db.prepare(`
        INSERT INTO search_history (query, engines, result_count, latency_ms, user_id, session_id)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
      stmt.run(query, engines.join(","), resultCount, latencyMs, userId || null, sessionId || null);

      // 更新统计
      this.updateStats(query, engines, resultCount, latencyMs);
    } catch (e) {
      console.error("[EnhancedSearch] History record failed:", e);
    }
  }

  private updateStats(
    query: string,
    engines: string[],
    resultCount: number,
    latencyMs: number
  ) {
    const today = new Date().toISOString().split("T")[0];

    for (const engine of engines) {
      const stmt = this.db.prepare(`
        INSERT INTO search_stats (date, query, engine, count, avg_results, avg_latency)
        VALUES (?, ?, ?, 1, ?, ?)
        ON CONFLICT(date, query, engine) DO UPDATE SET
          count = count + 1,
          avg_results = (avg_results * count + ?) / (count + 1),
          avg_latency = (avg_latency * count + ?) / (count + 1)
      `);
      stmt.run(today, query, engine, resultCount, latencyMs, resultCount, latencyMs);
    }
  }

  // ========== 统计查询 ==========

  /**
   * 获取搜索统计
   */
  getStats(days = 7): SearchStats {
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().split("T")[0];

    const totalStmt = this.db.prepare(`
      SELECT COUNT(*) as c, AVG(result_count) as avg_r, AVG(latency_ms) as avg_l
      FROM search_history
      WHERE datetime(created_at, 'unixepoch') >= ?
    `);
    const total = totalStmt.get(since) as { c: number; avg_r: number; avg_l: number };

    const uniqueStmt = this.db.prepare(`
      SELECT COUNT(DISTINCT query) as c
      FROM search_history
      WHERE datetime(created_at, 'unixepoch') >= ?
    `);
    const unique = uniqueStmt.get(since) as { c: number };

    const topQueriesStmt = this.db.prepare(`
      SELECT query, COUNT(*) as count
      FROM search_history
      WHERE datetime(created_at, 'unixepoch') >= ?
      GROUP BY query
      ORDER BY count DESC
      LIMIT 10
    `);
    const topQueries = topQueriesStmt.all(since) as Array<{ query: string; count: number }>;

    const topEnginesStmt = this.db.prepare(`
      SELECT engines as engine, COUNT(*) as count
      FROM search_history
      WHERE datetime(created_at, 'unixepoch') >= ?
      GROUP BY engines
      ORDER BY count DESC
      LIMIT 5
    `);
    const topEngines = topEnginesStmt.all(since) as Array<{ engine: string; count: number }>;

    const hourlyStmt = this.db.prepare(`
      SELECT strftime('%H', datetime(created_at, 'unixepoch')) as hour, COUNT(*) as count
      FROM search_history
      WHERE datetime(created_at, 'unixepoch') >= ?
      GROUP BY hour
      ORDER BY hour
    `);
    const hourly = hourlyStmt.all(since) as Array<{ hour: string; count: number }>;
    const hourlyDistribution: Record<number, number> = {};
    for (const h of hourly) {
      hourlyDistribution[parseInt(h.hour)] = h.count;
    }

    return {
      totalSearches: total.c || 0,
      uniqueQueries: unique.c || 0,
      avgResults: Math.round(total.avg_r || 0),
      avgLatency: Math.round(total.avg_l || 0),
      topQueries,
      topEngines,
      hourlyDistribution,
    };
  }

  /**
   * 获取搜索历史
   */
  getHistory(limit = 50, offset = 0): SearchHistory[] {
    const stmt = this.db.prepare(`
      SELECT * FROM search_history
      ORDER BY created_at DESC
      LIMIT ? OFFSET ?
    `);
    return stmt.all(limit, offset) as SearchHistory[];
  }

  /**
   * 清除缓存
   */
  clearCache() {
    this.cache.clear();
    this.db.exec("DELETE FROM search_cache");
  }

  /**
   * 清除历史
   */
  clearHistory() {
    this.db.exec("DELETE FROM search_history");
    this.db.exec("DELETE FROM search_stats");
  }

  close() {
    this.db.close();
  }
}

/** 全局增强搜索聚合器实例 */
export const enhancedSearch = new EnhancedSearchAggregator();
