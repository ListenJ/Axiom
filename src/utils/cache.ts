/**
 * 多层缓存系统
 * 支持 TTL、LRU 淘汰、内存 + SQLite 持久化缓存
 */
import { Database } from "bun:sqlite";

interface CacheEntry<V> {
  value: V;
  expiresAt: number;
  accessCount: number;
  lastAccessed: number;
}

interface CacheOptions {
  maxSize?: number;        // 最大条目数
  defaultTtlMs?: number;   // 默认 TTL (ms)
  persistent?: boolean;    // 是否持久化到 SQLite
  dbPath?: string;         // 持久化数据库路径
  namespace?: string;      // 命名空间隔离
}

export class Cache<V = unknown> {
  private store = new Map<string, CacheEntry<V>>();
  private opts: Required<CacheOptions>;
  private db?: Database;
  private hitCount = 0;
  private missCount = 0;
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor(opts: CacheOptions = {}) {
    this.opts = {
      maxSize: opts.maxSize ?? 1000,
      defaultTtlMs: opts.defaultTtlMs ?? 5 * 60 * 1000, // 5min
      persistent: opts.persistent ?? false,
      dbPath: opts.dbPath ?? "./data/agent.db",
      namespace: opts.namespace ?? "default",
    };

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

  /** 获取缓存值 */
  get(key: string): V | undefined {
    const fullKey = this.key(key);
    const entry = this.store.get(fullKey);

    if (entry) {
      if (Date.now() > entry.expiresAt) {
        this.store.delete(fullKey);
        this.missCount++;
        return undefined;
      }
      entry.accessCount++;
      entry.lastAccessed = Date.now();
      this.hitCount++;
      return entry.value;
    }

    // 尝试从持久化缓存读取
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

  /** 设置缓存值 */
  set(key: string, value: V, ttlMs?: number): void {
    const fullKey = this.key(key);
    const expiresAt = Date.now() + (ttlMs ?? this.opts.defaultTtlMs);

    // LRU: 如果超出容量，淘汰最少访问的
    if (this.store.size >= this.opts.maxSize && !this.store.has(fullKey)) {
      this.evictLRU();
    }

    this.store.set(fullKey, {
      value,
      expiresAt,
      accessCount: 1,
      lastAccessed: Date.now(),
    });

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
    const cached = this.get(key);
    if (cached !== undefined) return cached;
    const value = await factory();
    this.set(key, value, ttlMs);
    return value;
  }

  /** 删除缓存 */
  delete(key: string): void {
    const fullKey = this.key(key);
    this.store.delete(fullKey);
    this.db?.run("DELETE FROM cache_store WHERE namespace = ? AND key = ?", [this.opts.namespace, key]);
  }

  /** 清空缓存 */
  clear(): void {
    this.store.clear();
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
  stats(): { size: number; hits: number; misses: number; hitRate: number } {
    const total = this.hitCount + this.missCount;
    return {
      size: this.store.size,
      hits: this.hitCount,
      misses: this.missCount,
      hitRate: total > 0 ? Math.round((this.hitCount / total) * 1000) / 1000 : 0,
    };
  }

  private key(k: string): string {
    return `${this.opts.namespace}::${k}`;
  }

  private evictLRU() {
    let oldest: { key: string; lastAccessed: number } | null = null;
    for (const [key, entry] of this.store) {
      if (!oldest || entry.lastAccessed < oldest.lastAccessed) {
        oldest = { key, lastAccessed: entry.lastAccessed };
      }
    }
    if (oldest) {
      this.store.delete(oldest.key);
    }
  }

  private scheduleCleanup() {
    // 每 5 分钟清理过期条目
    this.cleanupTimer = setInterval(() => {
      const now = Date.now();
      for (const [key, entry] of this.store) {
        if (now > entry.expiresAt) this.store.delete(key);
      }
      this.db?.run("DELETE FROM cache_store WHERE expires_at < unixepoch()");
    }, 5 * 60 * 1000);
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
