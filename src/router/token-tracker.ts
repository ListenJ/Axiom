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
        fallback_used INTEGER DEFAULT 0
      )
    `);

    // 索引加速查询
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_tu_timestamp ON token_usage(timestamp)`);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_tu_model ON token_usage(model)`);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_tu_role ON token_usage(role)`);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_tu_task_type ON token_usage(task_type)`);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_tu_date ON token_usage(date(timestamp, 'unixepoch'))`);
  }

  private startFlushTimer() {
    this.flushTimer = setInterval(() => {
      this.flush().catch((e) => logger.warn("[TokenTracker] Auto-flush failed", e));
    }, this.flushIntervalMs);
  }

  /** 记录一次 token 使用 */
  record(record: TokenUsageRecord) {
    this.buffer.push(record);
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
         total_tokens, latency_ms, content_length, success, fallback_used)
      VALUES
        ($timestamp, $model, $provider, $role, $taskType, $promptTokens, $completionTokens,
         $totalTokens, $latencyMs, $contentLength, $success, $fallbackUsed)
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
        COALESCE(SUM(CASE WHEN fallback_used = 1 THEN 1 ELSE 0 END) * 100.0 / COUNT(*), 0) as fallback_rate
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
    };
  }

  /** 按模型分组统计 */
  getStatsByModel(opts?: { since?: number; limit?: number }): ModelStats[] {
    const params: Record<string, number | string> = {};
    let where = "";
    if (opts?.since) { where = "WHERE timestamp >= $since"; params.$since = opts.since; }
    const limit = opts?.limit ?? 20;

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
        COALESCE(SUM(CASE WHEN fallback_used = 1 THEN 1 ELSE 0 END) * 100.0 / COUNT(*), 0) as fallback_rate
      FROM token_usage
      ${where}
      GROUP BY model, provider
      ORDER BY total_tokens DESC
      LIMIT ${limit}
    `).all(params) as ModelStatsRow[];

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
        COALESCE(SUM(CASE WHEN fallback_used = 1 THEN 1 ELSE 0 END) * 100.0 / COUNT(*), 0) as fallback_rate
      FROM token_usage
      ${where}
      GROUP BY role
      ORDER BY total_tokens DESC
      LIMIT ${limit}
    `).all(params) as RoleStatsRow[];

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
    }));
  }

  /** 按天统计 */
  getDailyStats(days = 30): DailyStats[] {
    const rows = this.db.query(`
      SELECT
        date(timestamp, 'unixepoch', 'localtime') as date,
        COUNT(*) as total_calls,
        COALESCE(SUM(total_tokens), 0) as total_tokens,
        COALESCE(SUM(prompt_tokens), 0) as prompt_tokens,
        COALESCE(SUM(completion_tokens), 0) as completion_tokens
      FROM token_usage
      WHERE timestamp >= strftime('%s', 'now', '-${days} days')
      GROUP BY date
      ORDER BY date DESC
    `).all() as DailyStatsRow[];

    return rows.map((r) => ({
      date: r.date,
      totalCalls: r.total_calls,
      totalTokens: r.total_tokens,
      promptTokens: r.prompt_tokens,
      completionTokens: r.completion_tokens,
    }));
  }

  /** 最近使用记录 */
  getRecentUsage(limit = 20): TokenUsageRecord[] {
    const rows = this.db.query(`
      SELECT
        timestamp, model, provider, role, task_type,
        prompt_tokens, completion_tokens, total_tokens,
        latency_ms, content_length, success, fallback_used
      FROM token_usage
      ORDER BY timestamp DESC
      LIMIT ${limit}
    `).all() as UsageRecordRow[];

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

export function resetTokenTracker(): void {
  if (_tracker) {
    _tracker.close().catch(() => {});
    _tracker = null;
  }
}
