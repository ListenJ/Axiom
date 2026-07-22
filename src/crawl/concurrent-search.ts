/**
 * 并发搜索模块
 *
 * 基于 Bun 的并发能力（Promise.all + 信号量限制并发数）执行多查询并行搜索。
 *
 * 设计要点：
 *   - 复用现有 `unifiedSearch`（src/crawl/unified-search.ts）与 `searchAggregator`
 *     （src/crawl/search-engines.ts），不重写搜索引擎逻辑。
 *   - 复用 `src/utils/concurrency/semaphore.ts` 的 `Semaphore` 做并发许可控制，
 *     避免一次性发出过多请求导致被限流或触发反爬。
 *   - 错误隔离：单个查询失败时返回空数组，不影响其他查询的结果聚合。
 *   - 默认 maxConcurrency=5，可配置；上限强制为 1 ≤ n ≤ 32，防止极端值。
 *
 * 使用示例：
 *   const groups = await concurrentSearch(
 *     ["Bun runtime", "TypeScript 5.3", "PostgreSQL pgvector"],
 *     { maxConcurrency: 3, engines: ["searxng", "duckduckgo"] }
 *   );
 *   // groups.length === 3，每个元素是一次查询的结果数组
 */

import { Semaphore } from "../utils/concurrency/semaphore.js";
import { logger } from "../utils/logger.js";
import {
  unifiedSearch,
  UnifiedSearch,
  type UnifiedSearchResult,
} from "./unified-search.js";

// ========== 类型定义 ==========

export interface ConcurrentSearchOptions {
  /** 最大并发数（默认 5，范围 1-32） */
  maxConcurrency?: number;
  /** 搜索引擎列表（默认沿用 UnifiedSearch.DEFAULT_ENGINES） */
  engines?: string[];
  /** 每个查询返回的结果数（透传给 UnifiedSearchOptions.num） */
  num?: number;
  /** 是否启用查询优化（透传给 UnifiedSearchOptions.optimizeQuery） */
  optimizeQuery?: boolean;
  /** 是否启用相关性重排序（透传给 UnifiedSearchOptions.rerank） */
  rerank?: boolean;
  /** 相关性评分阈值（透传给 UnifiedSearchOptions.relevanceThreshold） */
  relevanceThreshold?: number;
  /** 是否启用缓存（透传给 UnifiedSearchOptions.useCache） */
  useCache?: boolean;
  /** 缓存有效期（分钟，透传给 UnifiedSearchOptions.cacheTtl） */
  cacheTtl?: number;
  /** 是否去重（透传给 UnifiedSearchOptions.dedup） */
  dedup?: boolean;
  /** 是否记录搜索历史（透传给 UnifiedSearchOptions.recordHistory） */
  recordHistory?: boolean;
}

export interface ConcurrentSearchReport {
  /** 总查询数 */
  totalQueries: number;
  /** 成功查询数（含空结果） */
  succeeded: number;
  /** 失败查询数 */
  failed: number;
  /** 失败查询及其错误信息 */
  failures: Array<{ query: string; error: string }>;
  /** 各查询结果数 */
  resultCounts: number[];
  /** 总耗时（毫秒） */
  totalLatencyMs: number;
  /** 实际使用的并发上限 */
  maxConcurrency: number;
}

// ========== 常量 ==========

/** 并发上限下限 */
const MIN_CONCURRENCY = 1;
/** 并发上限上限（防止极端值压垮上游搜索引擎） */
const MAX_CONCURRENCY = 32;
/** 默认并发上限 */
const DEFAULT_CONCURRENCY = 5;

// ========== 核心实现 ==========

/**
 * 并发执行多个查询，复用 `unifiedSearch` 实例。
 *
 * 错误隔离策略：每个查询在 `Semaphore.withPermit` 内部 try/catch 包裹，
 * 失败时返回空数组并通过 logger 记录，不向上抛出。
 *
 * @returns 与 `queries` 顺序一一对应的结果数组；失败查询对应位置为 `[]`
 */
export async function concurrentSearch(
  queries: string[],
  options?: ConcurrentSearchOptions
): Promise<UnifiedSearchResult[][]> {
  if (!queries || queries.length === 0) return [];

  const maxConcurrency = clampConcurrency(options?.maxConcurrency);
  const engines = options?.engines ?? UnifiedSearch.DEFAULT_ENGINES;

  const semaphore = new Semaphore(maxConcurrency);

  const tasks = queries.map((query) =>
    semaphore.withPermit(async () => {
      try {
        const results = await unifiedSearch.search({
          query,
          engines,
          num: options?.num,
          optimizeQuery: options?.optimizeQuery,
          rerank: options?.rerank,
          relevanceThreshold: options?.relevanceThreshold,
          useCache: options?.useCache,
          cacheTtl: options?.cacheTtl,
          dedup: options?.dedup,
          recordHistory: options?.recordHistory,
        });
        return results;
      } catch (e) {
        // 错误隔离：单个查询失败不影响其他查询
        const msg = e instanceof Error ? e.message : String(e);
        logger.warn(`[ConcurrentSearch] query failed`, {
          query,
          error: msg,
        });
        return [] as UnifiedSearchResult[];
      }
    })
  );

  // Promise.all 保序：返回顺序与 queries 一致
  return Promise.all(tasks);
}

/**
 * 并发搜索 + 执行报告（含失败统计、各查询结果数、总耗时）。
 *
 * 适用于需要观测并发搜索健康度的场景（如批量知识采集任务的诊断日志）。
 */
export async function concurrentSearchWithReport(
  queries: string[],
  options?: ConcurrentSearchOptions
): Promise<{ results: UnifiedSearchResult[][]; report: ConcurrentSearchReport }> {
  const startTime = performance.now();
  const maxConcurrency = clampConcurrency(options?.maxConcurrency);

  // 先用空结果占位，便于失败统计
  const placeholder: UnifiedSearchResult[][] = queries.map(() => []);
  const failures: Array<{ query: string; error: string }> = [];

  // 内部带错误捕获的并发执行
  const engines = options?.engines ?? UnifiedSearch.DEFAULT_ENGINES;
  const semaphore = new Semaphore(maxConcurrency);

  const tasks = queries.map((query, idx) =>
    semaphore.withPermit(async () => {
      try {
        const results = await unifiedSearch.search({
          query,
          engines,
          num: options?.num,
          optimizeQuery: options?.optimizeQuery,
          rerank: options?.rerank,
          relevanceThreshold: options?.relevanceThreshold,
          useCache: options?.useCache,
          cacheTtl: options?.cacheTtl,
          dedup: options?.dedup,
          recordHistory: options?.recordHistory,
        });
        placeholder[idx] = results;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        failures.push({ query, error: msg });
        logger.warn(`[ConcurrentSearch] query failed (reported)`, {
          query,
          error: msg,
        });
        // placeholder[idx] 保持 []
      }
    })
  );

  await Promise.all(tasks);

  const totalLatencyMs = Math.round(performance.now() - startTime);
  const resultCounts = placeholder.map((r) => r.length);
  const failed = failures.length;
  const succeeded = queries.length - failed;

  const report: ConcurrentSearchReport = {
    totalQueries: queries.length,
    succeeded,
    failed,
    failures,
    resultCounts,
    totalLatencyMs,
    maxConcurrency,
  };

  return { results: placeholder, report };
}

// ========== 辅助函数 ==========

/** 将并发数约束到 [MIN, MAX] 区间 */
function clampConcurrency(n: number | undefined): number {
  if (n === undefined || !Number.isFinite(n)) return DEFAULT_CONCURRENCY;
  const v = Math.floor(n);
  if (v < MIN_CONCURRENCY) return MIN_CONCURRENCY;
  if (v > MAX_CONCURRENCY) return MAX_CONCURRENCY;
  return v;
}
