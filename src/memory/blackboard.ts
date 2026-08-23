/**
 * 多Agent共享黑板 (Multi-Agent Shared Blackboard)
 *
 * 核心理念:
 *   - 隔离全局事实与局部状态
 *   - 版本控制 + 置信度打分
 *   - 防止Agent间信息污染和上下文爆炸
 *   - 黑板优先读取 (Blackboard-First Reading)
 *
 * 数据结构:
 *   {
 *     key: "order:123_status",
 *     value: "PAID",
 *     confidence: 0.98,
 *     status: "verified" | "pending" | "stale",
 *     version: 3,
 *     source_id: "Agent_B",
 *     expire_time: 1715678900,
 *     tags: ["order", "payment"],
 *     fields: { status: "PAID", amount: 100 }
 *   }
 *
 * 读写规则:
 *   - 读: Agent 读取前先查黑板。高置信度 + 未过期 → 直接复用
 *   - 写: 低置信度不能覆盖高置信度; 过期脏数据定时清扫
 *   - 字段投影: 只返回请求的字段，降低 Token 消耗
 */

import { logger } from "../utils/logger.js";
import { Cache } from "../utils/cache.js";
import { RedisClient } from "../utils/redis-client.js";

// ═══════════════════════════════════════════════════════════════
// 类型定义
// ═══════════════════════════════════════════════════════════════

export type FactStatus = "verified" | "pending" | "stale" | "conflict";

export interface BlackboardEntry {
  key: string;
  value: unknown;
  confidence: number;       // 0-1
  status: FactStatus;
  version: number;
  sourceId: string;         // 写入者 agent_id
  createdAt: number;
  updatedAt: number;
  expireTime: number;       // 过期时间戳 (0 = 永不过期)
  tags: string[];
  metadata?: Record<string, unknown>;
}

export interface WriteOptions {
  confidence?: number;
  status?: FactStatus;
  expireMs?: number;        // 相对过期时间
  tags?: string[];
  metadata?: Record<string, unknown>;
}

export interface ReadOptions {
  minConfidence?: number;   // 最低置信度阈值
  acceptStale?: boolean;    // 是否接受过期数据
  fields?: string[];        // 字段投影 (列裁剪)
  agentId?: string;         // 读取者身份 (用于权限校验)
}

export interface ReadResult {
  entry?: BlackboardEntry;
  hit: boolean;             // 是否命中
  reason: string;           // 未命中原因
  projected?: unknown;      // 字段投影后的值
}

// ═══════════════════════════════════════════════════════════════
// 共享黑板实现
// ═══════════════════════════════════════════════════════════════

export class SharedBlackboard {
  private entries = new Map<string, BlackboardEntry>();
  /** 会话事件广播订阅表：topic -> 回调集合 */
  private listeners = new Map<string, Set<(payload: unknown) => void>>();
  private tagIndex = new Map<string, Set<string>>();
  private sourceIndex = new Map<string, Set<string>>();
  private cache: Cache<BlackboardEntry>;
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;
  private redisPub?: RedisClient;
  private redisSub?: RedisClient;
  private redisEnabled = false;
  private readonly channel = "axiom:blackboard";

  constructor(options?: { cleanupIntervalMs?: number; persistent?: boolean; redis?: boolean }) {
    this.cache = new Cache<BlackboardEntry>({
      namespace: "blackboard",
      maxSize: 2000,
      defaultTtlMs: 60 * 60 * 1000, // 1h
      persistent: options?.persistent ?? true,
    });

    // 定期清理过期条目
    const interval = options?.cleanupIntervalMs ?? 60 * 1000;
    this.cleanupTimer = setInterval(() => this.cleanup(), interval);

    // 可选 Redis 跨进程同步
    if (options?.redis !== false) {
      this.initRedisSync();
    }
  }

  private async initRedisSync(): Promise<void> {
    try {
      const pub = await RedisClient.connect();
      if (!pub) return;
      this.redisPub = pub;

      // Subscriber 需要独立连接
      const sub = await RedisClient.connect();
      if (sub) {
        this.redisSub = sub;
        await sub.subscribe(this.channel, (_channel, message) => {
          try {
            const payload = JSON.parse(message) as { key: string; entry: BlackboardEntry; source: string };
            if (payload.source === process.pid?.toString()) return; // 忽略自己发的
            // M1 审计修复：远程更新必须过与 write() 相同的仲裁，不再 storeEntry 直写
            this.applyRemoteUpdate(payload.key, payload.entry);
            logger.debug("[Blackboard] Received remote update via Redis", { key: payload.key, source: payload.source });
          } catch {
            // ignore invalid message
          }
        });
      }

      this.redisEnabled = true;
      logger.info("[Blackboard] Redis sync enabled", { channel: this.channel });
    } catch {
      // Redis 不可用，静默回退
    }
  }

  // ---------------------------------------------------------------------------
  // 写操作
  // ---------------------------------------------------------------------------

  /**
   * 写入黑板
   *
   * 规则:
   *   1. 同 key 已存在时，低置信度不能覆盖高置信度 (差值 > 0.2)
   *   2. 版本号自动递增
   *   3. 冲突检测: 如果 value 不同但 confidence 相近，标记为 conflict
   */
  write(
    key: string,
    value: unknown,
    sourceId: string,
    options: WriteOptions = {}
  ): BlackboardEntry {
    const now = Date.now();
    const confidence = Math.min(1, Math.max(0, options.confidence ?? 0.8));
    const expireTime = options.expireMs ? now + options.expireMs : 0;

    const existing = this.entries.get(key);

    // 冲突检测: 已有数据且置信度相近
    if (existing && existing.value !== value) {
      const confDiff = Math.abs(existing.confidence - confidence);
      if (confDiff < 0.15 && existing.status === "verified") {
        // 标记为冲突，不覆盖（M1: 与远程路径共用 markConflict）
        return this.markConflict(key, existing, value, sourceId);
      }

      // 低置信度不能覆盖高置信度 (差值 > 0.2)
      if (confidence < existing.confidence - 0.2) {
        logger.info("[Blackboard] Rejected low-confidence write", {
          key,
          existingConfidence: existing.confidence,
          incomingConfidence: confidence,
        });
        return existing;
      }
    }

    const entry: BlackboardEntry = {
      key,
      value,
      confidence,
      status: options.status ?? (confidence > 0.9 ? "verified" : "pending"),
      version: (existing?.version ?? 0) + 1,
      sourceId,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      expireTime,
      tags: options.tags ?? existing?.tags ?? [],
      metadata: { ...existing?.metadata, ...options.metadata },
    };

    this.storeEntry(key, entry);

    // 跨进程广播
    if (this.redisEnabled && this.redisPub) {
      this.redisPub.publish(this.channel, JSON.stringify({ key, entry, source: process.pid?.toString() || "unknown" })).catch(() => {
        // ignore publish errors
      });
    }

    logger.info("[Blackboard] Write", {
      key,
      version: entry.version,
      confidence,
      status: entry.status,
      sourceId,
    });

    // 会话事件广播：高置信度新事实写入时通知订阅方（如其他会话/工作空间监听者）
    this.publish(`blackboard:write:${key}`, {
      key, value, sourceId, status: entry.status,
      confidence: entry.confidence, updatedAt: entry.updatedAt,
    });
    return entry;
  }

  /**
   * 批量写入
   */
  writeBatch(
    items: Array<{ key: string; value: unknown; options?: WriteOptions }>,
    sourceId: string
  ): BlackboardEntry[] {
    return items.map((item) => this.write(item.key, item.value, sourceId, item.options));
  }

  /**
   * M1 审计修复：跨进程远程更新入口（Redis 订阅路径）。
   * 与本地 write() 同规则裁决：
   *   1. 远程 version ≤ 本地 → 忽略（陈旧/重复投递）
   *   2. 本地 verified 且远程置信度显著更低（>0.2 差） → 拒绝覆盖
   *   3. 相近置信度但值不同 → 本地转 conflict（保留本地值，记录冲突来源）
   *   4. 其余（新 key / 更高版本且置信度相当）→ 采用远程条目
   */
  applyRemoteUpdate(key: string, remote: BlackboardEntry): void {
    if (!remote || typeof remote !== "object") return;
    const existing = this.entries.get(key);

    if (!existing) {
      this.storeEntry(key, { ...remote, key });
      return;
    }

    const remoteConf = typeof remote.confidence === "number" ? remote.confidence : 0;

    // 版本仲裁：陈旧投递直接忽略
    if ((remote.version ?? 0) <= existing.version) return;

    // 置信度保护：与 write() 同阈值
    if (existing.status === "verified" && remoteConf < existing.confidence - 0.2) {
      logger.info("[Blackboard] Rejected low-confidence remote update", {
        key,
        existingConfidence: existing.confidence,
        remoteConfidence: remoteConf,
      });
      return;
    }

    // 冲突检测：相近置信度、值不同、本地已 verified —— 与 write() 对齐转 conflict
    if (
      existing.value !== remote.value &&
      existing.status === "verified" &&
      Math.abs(existing.confidence - remoteConf) < 0.15
    ) {
      this.markConflict(key, existing, remote.value, `remote:${remote.sourceId}`);
      return;
    }

    this.storeEntry(key, { ...remote, key });
  }

  // ---------------------------------------------------------------------------
  // 读操作 (黑板优先)
  // ---------------------------------------------------------------------------

  /**
   * 读取黑板 — Blackboard-First Reading
   *
   * 规则:
   *   1. 先查黑板命中
   *   2. 检查置信度阈值
   *   3. 检查过期时间
   *   4. 字段投影 (列裁剪)
   */
  read(key: string, options: ReadOptions = {}): ReadResult {
    const entry = this.entries.get(key);

    if (!entry) {
      return { hit: false, reason: "key_not_found" };
    }

    // 检查过期
    if (entry.expireTime > 0 && Date.now() > entry.expireTime) {
      if (!options.acceptStale) {
        return { hit: false, reason: "expired", entry };
      }
    }

    // 检查置信度
    const minConf = options.minConfidence ?? 0.5;
    if (entry.confidence < minConf) {
      return { hit: false, reason: "confidence_too_low", entry };
    }

    // 检查冲突状态
    if (entry.status === "conflict") {
      return { hit: false, reason: "conflict_detected", entry };
    }

    // 字段投影 (列裁剪)
    let projected: unknown = entry.value;
    if (options.fields && options.fields.length > 0 && typeof entry.value === "object" && entry.value !== null) {
      const obj = entry.value as Record<string, unknown>;
      const filtered: Record<string, unknown> = {};
      for (const field of options.fields) {
        if (field in obj) filtered[field] = obj[field];
      }
      projected = filtered;
    }

    logger.debug("[Blackboard] Read hit", { key, confidence: entry.confidence, version: entry.version });

    return {
      hit: true,
      reason: "hit",
      entry,
      projected,
    };
  }

  /**
   * 多 key 批量读取 — 自动字段投影
   */
  readBatch(keys: string[], options: ReadOptions = {}): Map<string, ReadResult> {
    const results = new Map<string, ReadResult>();
    for (const key of keys) {
      results.set(key, this.read(key, options));
    }
    return results;
  }

  /**
   * 按标签查询
   */
  queryByTag(tag: string, options: ReadOptions = {}): BlackboardEntry[] {
    const paths = this.tagIndex.get(tag);
    if (!paths) return [];

    const results: BlackboardEntry[] = [];
    for (const key of paths) {
      const res = this.read(key, options);
      if (res.hit && res.entry) results.push(res.entry);
    }
    return results;
  }

  /**
   * 按来源查询
   */
  queryBySource(sourceId: string, options: ReadOptions = {}): BlackboardEntry[] {
    const keys = this.sourceIndex.get(sourceId);
    if (!keys) return [];

    const results: BlackboardEntry[] = [];
    for (const key of keys) {
      const res = this.read(key, options);
      if (res.hit && res.entry) results.push(res.entry);
    }
    return results;
  }

  // ---------------------------------------------------------------------------
  // 缓存集成
  // ---------------------------------------------------------------------------

  /**
   * 从外部缓存层同步数据到黑板
   */
  async syncFromCache(key: string, sourceId: string, ttlMs?: number): Promise<boolean> {
    const cached = await this.cache.get(key);
    if (cached) {
      this.write(key, cached.value, sourceId, {
        confidence: cached.confidence,
        status: cached.status,
        expireMs: ttlMs,
        tags: cached.tags,
      });
      return true;
    }
    return false;
  }

  /**
   * 将黑板数据同步到外部缓存层
   */
  syncToCache(key: string, ttlMs?: number): void {
    const entry = this.entries.get(key);
    if (entry) {
      this.cache.set(key, entry, ttlMs ?? entry.expireTime - Date.now());
    }
  }

  // ---------------------------------------------------------------------------
  // 管理操作
  // ---------------------------------------------------------------------------

  /** 删除条目 */
  delete(key: string): boolean {
    const existed = this.entries.get(key);
    if (!existed) {
      this.cache.delete(key);
      return false;
    }
    // L2 审计修复：同步回收双索引，Set 不再只增不减
    this.removeFromIndexes(key, existed);
    this.entries.delete(key);
    this.cache.delete(key);
    return true;
  }

  /** 标记过期 */
  invalidate(key: string, reason?: string): void {
    const entry = this.entries.get(key);
    if (entry) {
      entry.status = "stale";
      entry.metadata = { ...entry.metadata, invalidated_reason: reason, invalidated_at: Date.now() };
    }
  }

  /** 获取统计信息 */
  stats(): {
    totalEntries: number;
    verifiedCount: number;
    pendingCount: number;
    staleCount: number;
    conflictCount: number;
    tagDistribution: Record<string, number>;
  } {
    let verified = 0, pending = 0, stale = 0, conflict = 0;
    const tagDist: Record<string, number> = {};

    for (const entry of this.entries.values()) {
      if (entry.status === "verified") verified++;
      else if (entry.status === "pending") pending++;
      else if (entry.status === "stale") stale++;
      else if (entry.status === "conflict") conflict++;

      for (const tag of entry.tags) {
        tagDist[tag] = (tagDist[tag] || 0) + 1;
      }
    }

    return {
      totalEntries: this.entries.size,
      verifiedCount: verified,
      pendingCount: pending,
      staleCount: stale,
      conflictCount: conflict,
      tagDistribution: tagDist,
    };
  }

  /** 清空所有数据 */
  clear(): void {
    this.entries.clear();
    this.tagIndex.clear();
    this.sourceIndex.clear();
    this.cache.clear();
    logger.info("[Blackboard] Cleared all entries");
  }

  /** 销毁 */
  destroy(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    this.redisPub?.disconnect();
    this.redisSub?.disconnect();
    this.clear();
  }

  // ---------------------------------------------------------------------------
  // 私有方法
  // ---------------------------------------------------------------------------

  // ---------------------------------------------------------------------------
  // 会话事件广播 (跨会话感知)
  // ---------------------------------------------------------------------------

  /** 向订阅者广播事件（同步、失败不阻断）。 */
  publish(topic: string, payload: unknown): void {
    const set = this.listeners.get(topic);
    if (!set) return;
    for (const cb of set) {
      try { cb(payload); } catch { /* 订阅者异常不阻断广播 */ }
    }
  }

  /** 订阅主题事件，返回取消订阅函数。 */
  subscribe(topic: string, cb: (payload: unknown) => void): () => void {
    const set = this.listeners.get(topic) ?? new Set();
    set.add(cb);
    this.listeners.set(topic, set);
    return () => {
      set.delete(cb);
      if (set.size === 0) this.listeners.delete(topic);
    };
  }

  private storeEntry(key: string, entry: BlackboardEntry): void {
    this.entries.set(key, entry);
    this.cache.set(key, entry);

    // 更新索引
    for (const tag of entry.tags) {
      if (!this.tagIndex.has(tag)) this.tagIndex.set(tag, new Set());
      this.tagIndex.get(tag)!.add(key);
    }

    if (!this.sourceIndex.has(entry.sourceId)) {
      this.sourceIndex.set(entry.sourceId, new Set());
    }
    this.sourceIndex.get(entry.sourceId)!.add(key);
  }

  /** 冲突标记（本地 write 与远程 applyRemoteUpdate 共用，M1） */
  private markConflict(key: string, existing: BlackboardEntry, incomingValue: unknown, sourceId: string): BlackboardEntry {
    const now = Date.now();
    const conflictEntry: BlackboardEntry = {
      ...existing,
      status: "conflict",
      updatedAt: now,
      metadata: {
        ...existing.metadata,
        conflict_with: incomingValue,
        conflict_source: sourceId,
        conflict_at: now,
      },
    };
    this.storeEntry(key, conflictEntry);
    logger.warn("[Blackboard] Conflict detected", { key, existing: existing.value, incoming: incomingValue });
    return conflictEntry;
  }

  /** L2 审计修复：从 tagIndex/sourceIndex 回收指定条目（Set 空时移除键） */
  private removeFromIndexes(key: string, entry: BlackboardEntry): void {
    for (const tag of entry.tags) {
      const set = this.tagIndex.get(tag);
      if (!set) continue;
      set.delete(key);
      if (set.size === 0) this.tagIndex.delete(tag);
    }
    const src = this.sourceIndex.get(entry.sourceId);
    if (src) {
      src.delete(key);
      if (src.size === 0) this.sourceIndex.delete(entry.sourceId);
    }
  }

  private cleanup(): void {
    const now = Date.now();
    let cleaned = 0;

    for (const [key, entry] of this.entries) {
      if (entry.expireTime > 0 && now > entry.expireTime + 5 * 60 * 1000) {
        // 过期超过 5 分钟才清理
        // L2 审计修复：清扫同步回收双索引
        this.removeFromIndexes(key, entry);
        this.entries.delete(key);
        cleaned++;
      }
    }

    if (cleaned > 0) {
      logger.debug("[Blackboard] Cleanup", { cleaned, remaining: this.entries.size });
    }
  }
}

// ═══════════════════════════════════════════════════════════════
// 全局黑板实例
// ═══════════════════════════════════════════════════════════════

let globalBlackboard: SharedBlackboard | null = null;

export function getGlobalBlackboard(): SharedBlackboard {
  if (!globalBlackboard) {
    globalBlackboard = new SharedBlackboard();
  }
  return globalBlackboard;
}

/** 快捷写入 */
export function writeFact(
  key: string,
  value: unknown,
  sourceId: string,
  options?: WriteOptions
): BlackboardEntry {
  return getGlobalBlackboard().write(key, value, sourceId, options);
}

/** 快捷读取 */
export function readFact(key: string, options?: ReadOptions): ReadResult {
  return getGlobalBlackboard().read(key, options);
}

/** 读取或计算 (缓存模式) */
export async function readOrCompute<T>(
  key: string,
  compute: () => Promise<T>,
  sourceId: string,
  options?: WriteOptions & ReadOptions
): Promise<T> {
  const bb = getGlobalBlackboard();
  const result = bb.read(key, options);

  if (result.hit && result.projected !== undefined) {
    return result.projected as T;
  }

  const value = await compute();
  bb.write(key, value, sourceId, options);
  return value;
}
