/**
 * TokenTracker — Token 使用追踪与统计系统
 *
 * 核心功能：
 * - 记录每次模型调用的 token 消耗（prompt/completion/total）
 * - 记录延迟、角色、任务类型、是否 fallback
 * - 提供多维度聚合统计（按模型、角色、时间范围）
 * - 内存缓冲 + 批量写入，减少 I/O 开销
 *
 * 存储：SQLite（独立数据库 ./data/token-usage.db）
 * 设计原则：
 * - 非阻塞写入（异步批量）
 * - 查询优先读内存缓存（最近记录）
 * - 持久化存储用于历史分析和报表
 */

import { Database } from "bun:sqlite";
import fs from "fs";
import path from "path";
import { logger } from "../utils/logger.js";
import { TIMEOUTS } from "../constants/timeouts.js";
import { estimateModelCostUsd } from "./rate-tier.js";

export interface TokenUsageRecord {
  timestamp: number;
  model: string;
  provider: string;
  role?: string;
  taskType?: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  latencyMs: number;
  contentLength: number;
  success: boolean;
  fallbackUsed: boolean;
  /** 成本（USD），DeepSeek V4 按调用时刻峰谷计价，其余模型 0 */
  costUsd?: number;
}

export interface TokenStats {
  totalCalls: number;
  totalPromptTokens: number;
  totalCompletionTokens: number;
  totalTokens: number;
  avgLatencyMs: number;
  avgTokensPerCall: number;
  successRate: number;
  fallbackRate: number;
  costUsd: number;
}

export interface ModelStats extends TokenStats {
  model: string;
  provider: string;
}

export interface RoleStats extends TokenStats {
  role: string;
}

export interface DailyStats {
  date: string;
  totalCalls: number;
  totalTokens: number;
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
  /**
   * LLM prompt-cache 命中次数（按日聚合）。
   * 当前 token_usage 表未持久化 cache_hit 列，故 getDailyStats 恒返回 0；
   * 字段保留以匹配前端契约并消除 stats 路由的 `as unknown as` 类型逃逸。
   * 将来在表与 recordUsage 中接入 cache_hit 后可直接填充。
   */
  cacheHits: number;
}

/** 内存缓冲条目 */
interface BufferEntry extends TokenUsageRecord {
  id?: number;
}

/** SQLite 查询结果行类型 */
interface StatsRow {
  total_calls: number;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  avg_latency: number;
  avg_tokens: number;
  success_rate: number;
  fallback_rate: number;
  cost_usd: number;
}

interface ModelStatsRow extends StatsRow {
  model: string;
  provider: string;
}

interface RoleStatsRow extends StatsRow {
  role: string;
}

interface DailyStatsRow {
  date: string;
  total_calls: number;
  total_tokens: number;
  prompt_tokens: number;
  completion_tokens: number;
  cost_usd: number;
}

interface UsageRecordRow {
  timestamp: number;
  model: string;
  provider: string;
  role: string | null;
  task_type: string | null;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  latency_ms: number;
  content_length: number;
  success: number;
  fallback_used: number;
  cost_usd: number;
}

export class TokenTracker {
  private db: Database;
  private buffer: BufferEntry[] = [];
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private maxBufferSize = 50;
  private flushIntervalMs = TIMEOUTS.TOKEN_TRACKER_FLUSH; // 30 秒自动刷盘
  private dbPath: string;

  constructor(dbPath = "./data/token-usage.db") {
    this.dbPath = dbPath;
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    this.db = new Database(dbPath);
    this.initTables();
    this.startFlushTimer();
  }

  private initTables() {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS token_usage (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp INTEGER NOT NULL,
        model TEXT NOT NULL,
        provider TEXT NOT NULL,
        role TEXT,
        task_type TEXT,
        prompt_tokens INTEGER DEFAULT 0,
        completion_tokens INTEGER DEFAULT 0,
        total_tokens INTEGER DEFAULT 0,
        latency_ms INTEGER DEFAULT 0,
        content_length INTEGER DEFAULT 0,
        success INTEGER DEFAULT 1,
        fallback_used INTEGER DEFAULT 0,
        cost_usd REAL DEFAULT 0
      )
    `);

    // 索引加速查询
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_tu_timestamp ON token_usage(timestamp)`);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_tu_model ON token_usage(model)`);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_tu_role ON token_usage(role)`);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_tu_task_type ON token_usage(task_type)`);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_tu_date ON token_usage(date(timestamp, 'unixepoch'))`);

    // 迁移：老库补 cost_usd 列（SQLite ALTER 不可重复执行，重复列会抛错，吞掉即可）
    try {
      this.db.run(`ALTER TABLE token_usage ADD COLUMN cost_usd REAL DEFAULT 0`);
    } catch { /* 列已存在 */ }

    this.backfillCostUsd();
  }

  /**
   * 回算历史成本：对 cost_usd=0 的历史行按行 timestamp 计价（DeepSeek V4 峰谷；
   * GLM/Kimi/MiniMax 直连价表；未收录跳过）。幂等：回填后 cost_usd>0 不再重复处理。
   */
  private backfillCostUsd(): void {
    try {
      const rows = this.db.query(`
        SELECT id, timestamp, model, provider, prompt_tokens, completion_tokens
        FROM token_usage
        WHERE cost_usd = 0
      `).all() as Array<{
        id: number;
        timestamp: number;
        model: string;
        provider: string;
        prompt_tokens: number;
        completion_tokens: number;
      }>;
      if (rows.length === 0) return;
      const update = this.db.prepare(`UPDATE token_usage SET cost_usd = $cost WHERE id = $id`);
      let filled = 0;
      this.db.transaction(() => {
        for (const r of rows) {
          const cost = estimateModelCostUsd(
            r.provider,
            r.model,
            r.prompt_tokens,
            r.completion_tokens,
            new Date(r.timestamp),
          );
          if (cost !== undefined) {
            update.run({ $cost: cost, $id: r.id } as never);
            filled++;
          }
        }
      })();
      if (filled > 0) logger.info(`[TokenTracker] Backfilled cost_usd for ${filled} rows (rate-tier)`);
    } catch (e) {
      logger.warn("[TokenTracker] cost_usd backfill skipped", { error: e instanceof Error ? e.message : String(e) });
    }
  }

  private startFlushTimer() {
    this.flushTimer = setInterval(() => {
      this.flush().catch((e) => logger.warn("[TokenTracker] Auto-flush failed", e));
    }, this.flushIntervalMs);
  }

  /** 记录一次 token 使用 */
  record(record: TokenUsageRecord) {
    // DeepSeek V4 按峰谷计价；其余按直连价表（GLM/Kimi/MiniMax）；未收录记 0
    const costUsd =
      record.costUsd ??
      estimateModelCostUsd(
        record.provider,
        record.model,
        record.promptTokens,
        record.completionTokens,
        new Date(record.timestamp),
      ) ?? 0;
    this.buffer.push({ ...record, costUsd });
    if (this.buffer.length >= this.maxBufferSize) {
      this.flush().catch((e) => logger.warn("[TokenTracker] Flush failed", e));
    }
  }

  /** 批量写入 SQLite */
  async flush(): Promise<number> {
    if (this.buffer.length === 0) return 0;
    const batch = this.buffer.splice(0, this.buffer.length);

    const stmt = this.db.prepare(`
      INSERT INTO token_usage
        (timestamp, model, provider, role, task_type, prompt_tokens, completion_tokens,
         total_tokens, latency_ms, content_length, success, fallback_used, cost_usd)
      VALUES
        ($timestamp, $model, $provider, $role, $taskType, $promptTokens, $completionTokens,
         $totalTokens, $latencyMs, $contentLength, $success, $fallbackUsed, $costUsd)
    `);

    this.db.transaction(() => {
      for (const r of batch) {
        stmt.run({
          $timestamp: r.timestamp,
          $model: r.model,
          $provider: r.provider,
          $role: r.role ?? null,
          $taskType: r.taskType ?? null,
          $promptTokens: r.promptTokens,
          $completionTokens: r.completionTokens,
          $totalTokens: r.totalTokens,
          $latencyMs: r.latencyMs,
          $contentLength: r.contentLength,
          $success: r.success ? 1 : 0,
          $fallbackUsed: r.fallbackUsed ? 1 : 0,
          $costUsd: r.costUsd ?? 0,
        });
      }
    })();

    stmt.finalize();
    logger.debug(`[TokenTracker] Flushed ${batch.length} records`);
    return batch.length;
  }

  // ==================== 查询方法 ====================

  /** 总体统计（支持时间范围过滤） */
  getOverallStats(opts?: { since?: number; until?: number }): TokenStats {
    const conditions: string[] = [];
    const params: Record<string, number> = {};
    if (opts?.since) { conditions.push("timestamp >= $since"); params.$since = opts.since; }
    if (opts?.until) { conditions.push("timestamp <= $until"); params.$until = opts.until; }
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

    const row = this.db.query(`
      SELECT
        COUNT(*) as total_calls,
        COALESCE(SUM(prompt_tokens), 0) as prompt_tokens,
        COALESCE(SUM(completion_tokens), 0) as completion_tokens,
        COALESCE(SUM(total_tokens), 0) as total_tokens,
        COALESCE(AVG(latency_ms), 0) as avg_latency,
        COALESCE(AVG(total_tokens), 0) as avg_tokens,
        COALESCE(SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END) * 100.0 / COUNT(*), 0) as success_rate,
        COALESCE(SUM(CASE WHEN fallback_used = 1 THEN 1 ELSE 0 END) * 100.0 / COUNT(*), 0) as fallback_rate,
        COALESCE(SUM(cost_usd), 0) as cost_usd
      FROM token_usage
      ${where}
    `).get(params) as StatsRow;

    return {
      totalCalls: row.total_calls,
      totalPromptTokens: row.prompt_tokens,
      totalCompletionTokens: row.completion_tokens,
      totalTokens: row.total_tokens,
      avgLatencyMs: Math.round(row.avg_latency),
      avgTokensPerCall: Math.round(row.avg_tokens),
      successRate: Math.round(row.success_rate * 100) / 100,
      fallbackRate: Math.round(row.fallback_rate * 100) / 100,
      costUsd: row.cost_usd ?? 0,
    };
  }

  /** 按模型分组统计 */
  getStatsByModel(opts?: { since?: number; limit?: number }): ModelStats[] {
    const params: Record<string, number | string> = {};
    let where = "";
    if (opts?.since) { where = "WHERE timestamp >= $since"; params.$since = opts.since; }
    const limit = Math.max(1, Math.min(Math.floor(opts?.limit ?? 20), 1000));

    const rows = this.db.query(`
      SELECT
        model,
        provider,
        COUNT(*) as total_calls,
        COALESCE(SUM(prompt_tokens), 0) as prompt_tokens,
        COALESCE(SUM(completion_tokens), 0) as completion_tokens,
        COALESCE(SUM(total_tokens), 0) as total_tokens,
        COALESCE(AVG(latency_ms), 0) as avg_latency,
        COALESCE(AVG(total_tokens), 0) as avg_tokens,
        COALESCE(SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END) * 100.0 / COUNT(*), 0) as success_rate,
        COALESCE(SUM(CASE WHEN fallback_used = 1 THEN 1 ELSE 0 END) * 100.0 / COUNT(*), 0) as fallback_rate,
        COALESCE(SUM(cost_usd), 0) as cost_usd
      FROM token_usage
      ${where}
      GROUP BY model, provider
      ORDER BY total_tokens DESC
      LIMIT $limit
    `).all({ ...params, $limit: limit }) as ModelStatsRow[];

    return rows.map((r) => ({
      model: r.model,
      provider: r.provider,
      totalCalls: r.total_calls,
      totalPromptTokens: r.prompt_tokens,
      totalCompletionTokens: r.completion_tokens,
      totalTokens: r.total_tokens,
      avgLatencyMs: Math.round(r.avg_latency),
      avgTokensPerCall: Math.round(r.avg_tokens),
      successRate: Math.round(r.success_rate * 100) / 100,
      fallbackRate: Math.round(r.fallback_rate * 100) / 100,
      costUsd: r.cost_usd ?? 0,
    }));
  }

  /** 按角色分组统计 */
  getStatsByRole(opts?: { since?: number; limit?: number }): RoleStats[] {
    const params: Record<string, number | string> = {};
    let where = "";
    if (opts?.since) { where = "WHERE timestamp >= $since"; params.$since = opts.since; }
    const limit = opts?.limit ?? 20;

    const rows = this.db.query(`
      SELECT
        COALESCE(role, 'unknown') as role,
        COUNT(*) as total_calls,
        COALESCE(SUM(prompt_tokens), 0) as prompt_tokens,
        COALESCE(SUM(completion_tokens), 0) as completion_tokens,
        COALESCE(SUM(total_tokens), 0) as total_tokens,
        COALESCE(AVG(latency_ms), 0) as avg_latency,
        COALESCE(AVG(total_tokens), 0) as avg_tokens,
        COALESCE(SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END) * 100.0 / COUNT(*), 0) as success_rate,
        COALESCE(SUM(CASE WHEN fallback_used = 1 THEN 1 ELSE 0 END) * 100.0 / COUNT(*), 0) as fallback_rate,
        COALESCE(SUM(cost_usd), 0) as cost_usd
      FROM token_usage
      ${where}
      GROUP BY role
      ORDER BY total_tokens DESC
      LIMIT $limit
    `).all({ ...params, $limit: limit }) as RoleStatsRow[];

    return rows.map((r) => ({
      role: r.role,
      totalCalls: r.total_calls,
      totalPromptTokens: r.prompt_tokens,
      totalCompletionTokens: r.completion_tokens,
      totalTokens: r.total_tokens,
      avgLatencyMs: Math.round(r.avg_latency),
      avgTokensPerCall: Math.round(r.avg_tokens),
      successRate: Math.round(r.success_rate * 100) / 100,
      fallbackRate: Math.round(r.fallback_rate * 100) / 100,
      costUsd: r.cost_usd ?? 0,
    }));
  }

  /** 按天统计 */
  getDailyStats(days = 30): DailyStats[] {
    const safeDays = Math.max(1, Math.min(Math.floor(days), 3650));
    const daysStr = `-${safeDays} days`;
    const rows = this.db.query(`
      SELECT
        date(timestamp, 'unixepoch', 'localtime') as date,
        COUNT(*) as total_calls,
        COALESCE(SUM(total_tokens), 0) as total_tokens,
        COALESCE(SUM(prompt_tokens), 0) as prompt_tokens,
        COALESCE(SUM(completion_tokens), 0) as completion_tokens,
        COALESCE(SUM(cost_usd), 0) as cost_usd
      FROM token_usage
      WHERE timestamp >= strftime('%s', 'now', $daysStr)
      GROUP BY date
      ORDER BY date DESC
    `).all({ $daysStr: daysStr }) as DailyStatsRow[];

    return rows.map((r) => ({
      date: r.date,
      totalCalls: r.total_calls,
      totalTokens: r.total_tokens,
      promptTokens: r.prompt_tokens,
      completionTokens: r.completion_tokens,
      costUsd: r.cost_usd ?? 0,
      // token_usage 表当前未持久化 cache_hit 列，暂以 0 占位
      cacheHits: 0,
    }));
  }

  /** 最近使用记录 */
  getRecentUsage(limit = 20): TokenUsageRecord[] {
    const safeLimit = Math.max(1, Math.min(Math.floor(limit), 1000));
    const rows = this.db.query(`
      SELECT
        timestamp, model, provider, role, task_type,
        prompt_tokens, completion_tokens, total_tokens,
        latency_ms, content_length, success, fallback_used, cost_usd
      FROM token_usage
      ORDER BY timestamp DESC
      LIMIT $limit
    `).all({ $limit: safeLimit }) as UsageRecordRow[];

    return rows.map((r) => ({
      timestamp: r.timestamp,
      model: r.model,
      provider: r.provider,
      role: r.role ?? undefined,
      taskType: r.task_type ?? undefined,
      promptTokens: r.prompt_tokens,
      completionTokens: r.completion_tokens,
      totalTokens: r.total_tokens,
      latencyMs: r.latency_ms,
      contentLength: r.content_length,
      success: !!r.success,
      fallbackUsed: !!r.fallback_used,
      costUsd: r.cost_usd ?? 0,
    }));
  }

  /** 关闭并刷盘 */
  async close() {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    await this.flush();
    this.db.close();
  }
}

// ========== 全局单例 ==========
let _tracker: TokenTracker | null = null;

export function getTokenTracker(): TokenTracker {
  if (!_tracker) _tracker = new TokenTracker();
  return _tracker;
}

