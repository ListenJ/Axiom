/**
 * 缓存优先路由 — 语义缓存 + 本地知识补齐
 * 模型调用前先查缓存，减少 model token 消耗
 */
import { normalizeQuery, recordCacheHit, recordCacheMiss, getCacheStats } from "../tools/types.js";
import { logger } from "../utils/logger.js";

export interface RouterConfig {
  semanticTtlMs: number;
  enableKG: boolean;
}

const DEFAULT_CONFIG: RouterConfig = {
  semanticTtlMs: 5 * 60 * 1000,
  enableKG: false, // KG 需 PostgreSQL，默认关闭
};

export async function cacheFirstRoute(
  query: string,
  intent: string,
  config: Partial<RouterConfig> = {},
): Promise<{ answer: string; source: string; fromCache: boolean } | null> {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const normalized = normalizeQuery(query);

  // 1. 语义缓存 (基于 Cache 层，非 model token)
  const { searchCache } = await import("../utils/cache.js");
  const cacheKey = `semantic:${normalized}:${intent}`;
  const cached = searchCache.getSync(cacheKey);
  if (cached !== undefined) {
    recordCacheHit();
    logger.debug(`[CacheFirst] Hit: ${cacheKey}`);
    return { answer: String(cached), source: "cache", fromCache: true };
  }
  recordCacheMiss();

  return null; // 未命中 → 需调用 LLM
}

/** 将 LLM 结果写入缓存 (用于后续相同语义查询直接命中) */
export function writeCache(query: string, intent: string, answer: string): void {
  try {
    const { searchCache } = require("../utils/cache.js");
    const normalized = normalizeQuery(query);
    const cacheKey = `semantic:${normalized}:${intent}`;
    searchCache.set(cacheKey, answer, 5 * 60 * 1000);
  } catch { /* non-fatal */ }
}

export { getCacheStats };
