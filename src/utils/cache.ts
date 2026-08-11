/**
 * 多层缓存系统 v2.0 — 支持 L1 内存 / L2 Redis / L3 SQLite 分层缓存
 *
 * 读取顺序: L1 内存 → L2 Redis → L3 SQLite
 * 写入顺序: 同步写入 L1 + L3，异步写入 L2 (不阻塞)
 * 无 Redis 时自动回退到 L1 + L3
 */
import { Database } from "bun:sqlite";
import { createHash } from "crypto";
import { getRedisClient, type RedisClient } from "./redis-client.js";
import { logger } from "./logger.js";

interface CacheEntry<V> {
  value: V;
  expiresAt: number;
  accessCount: number;
  lastAccessed: number;
}

interface CacheOptions {
  maxSize?: number;        // 最大条目数 (L1)
  defaultTtlMs?: number;   // 默认 TTL (ms)
  persistent?: boolean;    // 是否持久化到 SQLite (L3)
  dbPath?: string;         // 持久化数据库路径
  namespace?: string;      // 命名空间隔离
  redis?: boolean;         // 是否启用 Redis (L2)
  redisTtlMs?: number;     // Redis TTL (默认与 defaultTtlMs 相同)
}

export class Cache<V = unknown> {
  private store = new Map<string, CacheEntry<V>>();
  private opts: Required<CacheOptions>;
  private db?: Database;
  private redis: RedisClient | null = null;
  private redisReady = false;
  private hitCount = 0;
  private missCount = 0;
  private redisHitCount = 0;
  private redisMissCount = 0;
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;
  // In-flight factory promises per key, used to dedupe concurrent getOrSet calls
  // (thundering-herd protection).
  private inFlight = new Map<string, Promise<V>>();

  constructor(opts: CacheOptions = {}) {
    this.opts = {
      maxSize: opts.maxSize ?? 1000,
      defaultTtlMs: opts.defaultTtlMs ?? 5 * 60 * 1000,
      persistent: opts.persistent ?? false,
      dbPath: opts.dbPath ?? "./data/agent.db",
      namespace: opts.namespace ?? "default",
      redis: opts.redis ?? true, // 默认尝试启用 Redis
      redisTtlMs: opts.redisTtlMs ?? opts.defaultTtlMs ?? 5 * 60 * 1000,
    };

    // 初始化 Redis (异步，不阻塞构造)
    if (this.opts.redis) {
      this.initRedis();
    }

    if (this.opts.persistent) {
      this.db = new Database(this.opts.dbPath);
      this.db.run(`
        CREATE TABLE IF NOT EXISTS cache_store (
          namespace TEXT NOT NULL,
          key TEXT NOT NULL,
          value TEXT NOT NULL,
          expires_at INTEGER NOT NULL,
          created_at INTEGER DEFAULT (unixepoch()),
          PRIMARY KEY (namespace, key)
        )
      `);
      this.db.run(`CREATE INDEX IF NOT EXISTS idx_cache_expires ON cache_store(expires_at)`);
      this.scheduleCleanup();
    }
  }

  private async initRedis(): Promise<void> {
    try {
      this.redis = await getRedisClient();
      this.redisReady = this.redis !== null;
      if (this.redisReady) {
        logger.info("[Cache] Redis L2 cache enabled", { namespace: this.opts.namespace });
      }
    } catch {
      this.redisReady = false;
    }
  }

  private touch(fullKey: string): void {
    const entry = this.store.get(fullKey);
    if (entry) {
      entry.lastAccessed = Date.now();
      // Re-insert to move to end of Map (updating LRU order)
      this.store.delete(fullKey);
      this.store.set(fullKey, entry);
    }
  }

  /** 获取缓存值 — L1 → L2 → L3 */
  async get(key: string): Promise<V | undefined> {
    const fullKey = this.key(key);

    // L1: 内存缓存
    const entry = this.store.get(fullKey);
    if (entry) {
      if (Date.now() > entry.expiresAt) {
        this.store.delete(fullKey);
        this.missCount++;
        return undefined;
      }
      entry.accessCount++;
      this.touch(fullKey);
      this.hitCount++;
      return entry.value;
    }

    // L2: Redis 缓存
    if (this.redisReady && this.redis) {
      try {
        const redisKey = `${this.opts.namespace}:${key}`;
        const raw = await this.redis.get(redisKey);
        if (raw) {
          const value = JSON.parse(raw) as V;
          // 回填 L1
          this.store.set(fullKey, {
            value,
            expiresAt: Date.now() + this.opts.defaultTtlMs,
            accessCount: 1,
            lastAccessed: Date.now(),
          });
          this.redisHitCount++;
          this.hitCount++;
          return value;
        }
        this.redisMissCount++;
      } catch (err) {
        logger.debug("[Cache] Redis read failed", { error: (err as Error).message });
      }
    }

    // L3: SQLite 持久化缓存
    if (this.db) {
      const row = this.db
        .query("SELECT value, expires_at FROM cache_store WHERE namespace = ? AND key = ?")
        .get(this.opts.namespace, key) as { value: string; expires_at: number } | undefined;

      if (row) {
        if (Date.now() > row.expires_at * 1000) {
          this.db.run("DELETE FROM cache_store WHERE namespace = ? AND key = ?", [this.opts.namespace, key]);
          this.missCount++;
          return undefined;
        }
        try {
          const value = JSON.parse(row.value) as V;
          this.store.set(fullKey, {
            value,
            expiresAt: row.expires_at * 1000,
            accessCount: 1,
            lastAccessed: Date.now(),
          });
          this.hitCount++;
          return value;
        } catch {
          this.missCount++;
          return undefined;
        }
      }
    }

    this.missCount++;
    return undefined;
  }

  /** 同步获取 (仅 L1，用于兼容旧代码路径) */
  getSync(key: string): V | undefined {
    const fullKey = this.key(key);
    const entry = this.store.get(fullKey);
    if (entry && Date.now() <= entry.expiresAt) {
      entry.accessCount++;
      this.touch(fullKey);
      this.hitCount++;
      return entry.value;
    }
    return undefined;
  }

  /** 设置缓存值 — L1 + L2 + L3 */
  set(key: string, value: V, ttlMs?: number): void {
    const fullKey = this.key(key);
    const effectiveTtl = (typeof ttlMs === "number" && !Number.isNaN(ttlMs) && ttlMs >= 0) ? ttlMs : this.opts.defaultTtlMs;
    const expiresAt = Date.now() + effectiveTtl;

    // L1: 内存
    if (this.store.size >= this.opts.maxSize && !this.store.has(fullKey)) {
      this.evictLRU();
    }
    // Update order for existing keys (delete+re-insert to move to end)
    if (this.store.has(fullKey)) {
      this.store.delete(fullKey);
    }
    this.store.set(fullKey, {
      value,
      expiresAt,
      accessCount: 1,
      lastAccessed: Date.now(),
    });

    // L2: Redis (异步，不阻塞)
    if (this.redisReady && this.redis) {
      const redisKey = `${this.opts.namespace}:${key}`;
      const redisTtl = Math.floor((this.opts.redisTtlMs ?? effectiveTtl) / 1000);
      this.redis.set(redisKey, JSON.stringify(value), redisTtl).catch((err) => {
        logger.debug("[Cache] Redis write failed", { error: (err as Error).message });
      });
    }

    // L3: SQLite
    if (this.db) {
      this.db.run(
        `INSERT OR REPLACE INTO cache_store (namespace, key, value, expires_at)
         VALUES (?, ?, ?, ?)`,
        [this.opts.namespace, key, JSON.stringify(value), Math.floor(expiresAt / 1000)]
      );
    }
  }

  /** 原子获取或计算 */
  async getOrSet(key: string, factory: () => Promise<V>, ttlMs?: number): Promise<V> {
    const cached = await this.get(key);
    if (cached !== undefined) return cached;

    // Dedupe concurrent misses for the same key so we don't run the (possibly
    // expensive) factory multiple times at once.
    const fullKey = this.key(key);
    const existing = this.inFlight.get(fullKey);
    if (existing) return existing;

    const promise = (async () => {
      try {
        const value = await factory();
        this.set(key, value, ttlMs);
        return value;
      } finally {
        this.inFlight.delete(fullKey);
      }
    })();
    this.inFlight.set(fullKey, promise);
    return promise;
  }

  /** 删除缓存 */
  delete(key: string): void {
    const fullKey = this.key(key);
    this.store.delete(fullKey);

    if (this.redisReady && this.redis) {
      const redisKey = `${this.opts.namespace}:${key}`;
      this.redis.del(redisKey).catch(() => {});
    }

    this.db?.run("DELETE FROM cache_store WHERE namespace = ? AND key = ?", [this.opts.namespace, key]);
  }

  /** 清空缓存 */
  clear(): void {
    this.store.clear();

    if (this.redisReady && this.redis) {
      this.redis.flushdb().catch(() => {});
    }

    this.db?.run("DELETE FROM cache_store WHERE namespace = ?", [this.opts.namespace]);
  }

  /** 停止清理定时器 */
  destroy(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    this.clear();
    this.db?.close();
  }

  /** 缓存统计 */
  stats(): {
    size: number;
    hits: number;
    misses: number;
    hitRate: number;
    redisHits: number;
    redisMisses: number;
    redisHitRate: number;
    redisConnected: boolean;
  } {
    const total = this.hitCount + this.missCount;
    const redisTotal = this.redisHitCount + this.redisMissCount;
    return {
      size: this.store.size,
      hits: this.hitCount,
      misses: this.missCount,
      hitRate: total > 0 ? Math.round((this.hitCount / total) * 1000) / 1000 : 0,
      redisHits: this.redisHitCount,
      redisMisses: this.redisMissCount,
      redisHitRate: redisTotal > 0 ? Math.round((this.redisHitCount / redisTotal) * 1000) / 1000 : 0,
      redisConnected: this.redisReady,
    };
  }

  private key(k: string): string {
    return `${this.opts.namespace}::${k}`;
  }

  private evictLRU() {
    // O(1): Map insertion order tracks LRU. First key is least recently used.
    const first = this.store.keys().next().value;
    if (first !== undefined) {
      this.store.delete(first);
    }
  }

  private scheduleCleanup() {
    // 每 5 分钟清理过期条目
    // unref：后台清理定时器不阻止进程自然退出（测试/脚本不会挂起）
    this.cleanupTimer = setInterval(() => {
      const now = Date.now();
      for (const [key, entry] of this.store) {
        if (now > entry.expiresAt) this.store.delete(key);
      }
      this.db?.run("DELETE FROM cache_store WHERE expires_at < unixepoch()");
    }, 5 * 60 * 1000);
    this.cleanupTimer.unref?.();
  }
}

/** 全局缓存实例 */
export const searchCache = new Cache<unknown[]>({
  namespace: "search",
  maxSize: 500,
  defaultTtlMs: 10 * 60 * 1000, // 10min
  persistent: true,
});

export const crawlCache = new Cache<Record<string, unknown>>({
  namespace: "crawl",
  maxSize: 200,
  defaultTtlMs: 30 * 60 * 1000, // 30min
  persistent: true,
});

/**
 * LLM 响应缓存 — 跨 DeepSeek / 本地模型 / GLM 统一服务
 *
 * 设计要点：
 *   - L1 内存 + L3 SQLite 持久化：进程重启后缓存仍有效，hit rate 最大化
 *   - 确定性调用（temperature=0）缓存 1 小时，非确定性调用不缓存
 *   - 缓存 key = sha256(provider + model + messages + temperature)
 *   - 仅缓存成功响应（错误不缓存）
 *   - getOrSet 自带 thundering-herd 保护，并发同 key 只触发一次 API 调用
 *
 * 使用方式：
 *   const cached = await llmCache.getOrSet(key, () => callLLM(), ttlMs);
 */
export interface CachedLLMResponse {
  content: string | null;
  model: string;
  provider: string;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
  finishReason?: string;
}

export const llmCache = new Cache<CachedLLMResponse>({
  namespace: "llm",
  maxSize: 2000,
  defaultTtlMs: 60 * 60 * 1000, // 1 hour for deterministic calls
  persistent: true,
  dbPath: "./data/llm-cache.db",
});

/**
 * 计算 LLM 缓存 key。
 *
 * Key 包含：provider + model + messages + temperature + system
 * 不包含：timeout / retry / api key（这些不影响输出内容）
 *
 * 对于 temperature=0 的确定性调用，相同输入必定产生相同输出，
 * 缓存命中率高、语义安全。对于 temperature>0 的调用，调用方可
 * 选择不缓存（通过 ttlMs=0 或不调用 getOrSet）。
 *
 * 使用 SHA-256 生成定长 hex 摘要——32-bit hash 在 2000 条目下
 * 生日碰撞概率约 0.05%，对"返回错误 LLM 响应"零容忍，故用 256-bit。
 */
export function llmCacheKey(opts: {
  provider: string;
  model: string;
  messages: Array<{ role?: string; content?: string }>;
  temperature?: number;
  system?: string;
}): string {
  const parts = [
    opts.provider,
    opts.model,
    opts.system ?? "",
    ...opts.messages.map((m) => `${m.role ?? ""}:${m.content ?? ""}`),
    `temp:${opts.temperature ?? 0}`,
  ];
  const raw = parts.join("\n");
  const digest = createHash("sha256").update(raw).digest("hex");
  return `${opts.provider}:${opts.model}:${digest}`;
}
