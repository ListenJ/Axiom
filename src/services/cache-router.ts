/**
 * 缓存优先路由 — 语义缓存 + 本地知识补齐
 * 模型调用前先查缓存，减少 model token 消耗
 */
import { normalizeQuery, recordCacheHit, recordCacheMiss, getCacheStats } from "../tools/types.js";
import { logger } from "../utils/logger.js";
import { readBool } from "../utils/env.js";
import { semanticAnswerCache } from "../utils/cache.js";

export interface RouterConfig {
  semanticTtlMs: number;
  enableKG: boolean;
}

const DEFAULT_CONFIG: RouterConfig = {
  semanticTtlMs: 5 * 60 * 1000,
  enableKG: false, // KG 需 PostgreSQL，默认关闭
};

/** 语义答案缓存总开关：SEMANTIC_CACHE_ENABLED=0/false 关闭（默认开启） */
export function isSemanticCacheEnabled(): boolean {
  return readBool("SEMANTIC_CACHE_ENABLED", true);
}

/** 归一化语义缓存 key（导出便于测试与调用方预判） */
export function semanticCacheKey(query: string, intent: string): string {
  return `semantic:${normalizeQuery(query)}:${intent}`;
}

export async function cacheFirstRoute(
  query: string,
  intent: string,
  config: Partial<RouterConfig> = {},
): Promise<{ answer: string; source: string; fromCache: boolean } | null> {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  if (!isSemanticCacheEnabled()) return null;

  const cacheKey = semanticCacheKey(query, intent);
  const cached = semanticAnswerCache.getSync(cacheKey);
  if (cached !== undefined) {
    recordCacheHit();
    logger.debug(`[CacheFirst] Hit: ${cacheKey}`);
    return { answer: cached, source: "cache", fromCache: true };
  }
  recordCacheMiss();

  return null; // 未命中 → 需调用 LLM
}

/** 将 LLM 结果写入缓存 (用于后续相同语义查询直接命中) */
export function writeCache(query: string, intent: string, answer: string, config: Partial<RouterConfig> = {}): void {
  try {
    if (!isSemanticCacheEnabled()) return;
    const cfg = { ...DEFAULT_CONFIG, ...config };
    const cacheKey = semanticCacheKey(query, intent);
    semanticAnswerCache.set(cacheKey, answer, cfg.semanticTtlMs);
  } catch { /* non-fatal */ }
}

export { getCacheStats };

