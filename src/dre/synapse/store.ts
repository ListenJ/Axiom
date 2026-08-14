/**
 * SynapseStore — 神经突触的持久化 + 可验证路径
 *
 * 设计（规则 8 深模块）：
 *   - 小接口：upsert/get/findByPair/listBySource/updateActivation/appendTrace/tracesFor/
 *     verify/stats/remove/close。
 *   - SQLite（WAL + busy_timeout）持久化，多进程并行读写安全。
 *   - verifyHash：每条突触的规范字段哈希；verify() 重算比对 → 篡改即暴露。
 *   - 验证链：每条 trace 携带 prevHash + 自身 hash（链式），verify() 可全链校验。
 */

import { Database } from "bun:sqlite";
import { createHash } from "crypto";
import { logger } from "../../utils/logger.js";
import type { Synapse, SynapseTrace, SynapseStats, SynapseNodeType } from "./types.js";

/** 规范序列化 → sha256（确定性哈希） */
export function synapseHash(canonical: string): string {
  return createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}

/** 突触 id：sha256(sourceId|targetId) */
export function synapseId(sourceId: string, targetId: string): string {
  return synapseHash(`${sourceId}|${targetId}`);
}

/** 突触校验哈希：覆盖全部规范字段 */
export function computeSynapseVerifyHash(s: Omit<Synapse, "verifyHash">): string {
  return synapseHash(
    `${s.id}|${s.sourceId}|${s.targetId}|${s.sourceType}|${s.targetType}|${s.weight}|${s.activationCount}|${s.lastActivatedAt}`,
  );
}

/** 验证链记录哈希 */
export function computeTraceHash(t: Omit<SynapseTrace, "id" | "hash">): string {
  return synapseHash(
    `${t.synapseId}|${t.seq}|${t.operation}|${t.activation}|${t.sourceEvent}|${t.timestamp}|${t.prevHash}`,
  );
}

/** genesis 哈希（首条 trace 的 prevHash） */
export const GENESIS_HASH = synapseHash("axiom-synapse-genesis-v1");

export class SynapseStore {
  private db: Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.db.exec("PRAGMA journal_mode = WAL");
    this.ensureTables();
  }

  private ensureTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS synapses (
        id TEXT PRIMARY KEY,
        source_id TEXT NOT NULL,
        target_id TEXT NOT NULL,
        source_type TEXT NOT NULL,
        target_type TEXT NOT NULL,
        weight REAL NOT NULL,
        activation_count INTEGER NOT NULL DEFAULT 0,
        last_activated_at INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        verify_hash TEXT NOT NULL
      )
    `);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS synapse_traces (
        id TEXT PRIMARY KEY,
        synapse_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        operation TEXT NOT NULL,
        activation REAL NOT NULL,
        source_event TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        prev_hash TEXT NOT NULL,
        hash TEXT NOT NULL
      )
    `);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_synapses_source ON synapses(source_id)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_synapses_target ON synapses(target_id)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_traces_synapse ON synapse_traces(synapse_id, seq)`);
  }

  private rowToSynapse(row: Record<string, unknown>): Synapse {
    return {
      id: String(row.id),
      sourceId: String(row.source_id),
      targetId: String(row.target_id),
      sourceType: String(row.source_type) as SynapseNodeType,
      targetType: String(row.target_type) as SynapseNodeType,
      weight: Number(row.weight),
      activationCount: Number(row.activation_count),
      lastActivatedAt: Number(row.last_activated_at),
      createdAt: Number(row.created_at),
      verifyHash: String(row.verify_hash),
    };
  }

  upsert(s: Synapse): void {
    this.db.run(
      `INSERT OR REPLACE INTO synapses
       (id, source_id, target_id, source_type, target_type, weight, activation_count, last_activated_at, created_at, verify_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [s.id, s.sourceId, s.targetId, s.sourceType, s.targetType, s.weight, s.activationCount, s.lastActivatedAt, s.createdAt, s.verifyHash],
    );
  }

  get(id: string): Synapse | null {
    const row = this.db.query("SELECT * FROM synapses WHERE id = ?").get(id) as Record<string, unknown> | null;
    return row ? this.rowToSynapse(row) : null;
  }

  findByPair(sourceId: string, targetId: string): Synapse | null {
    const row = this.db.query("SELECT * FROM synapses WHERE source_id = ? AND target_id = ?").get(sourceId, targetId) as Record<string, unknown> | null;
    return row ? this.rowToSynapse(row) : null;
  }

  listBySource(sourceId: string): Synapse[] {
    const rows = this.db.query("SELECT * FROM synapses WHERE source_id = ?").all(sourceId) as Array<Record<string, unknown>>;
    return rows.map((r) => this.rowToSynapse(r));
  }

  listAll(): Synapse[] {
    const rows = this.db.query("SELECT * FROM synapses").all() as Array<Record<string, unknown>>;
    return rows.map((r) => this.rowToSynapse(r));
  }

  /** 更新激活相关字段并重算校验哈希 */
  updateActivation(id: string, patch: { weight: number; activationCount: number; lastActivatedAt: number }): Synapse | null {
    const current = this.get(id);
    if (!current) return null;
    const next: Synapse = { ...current, ...patch };
    next.verifyHash = computeSynapseVerifyHash(next);
    this.db.run(
      `UPDATE synapses SET weight = ?, activation_count = ?, last_activated_at = ?, verify_hash = ? WHERE id = ?`,
      [next.weight, next.activationCount, next.lastActivatedAt, next.verifyHash, id],
    );
    return next;
  }

  appendTrace(t: SynapseTrace): void {
    this.db.run(
      `INSERT INTO synapse_traces (id, synapse_id, seq, operation, activation, source_event, timestamp, prev_hash, hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [t.id, t.synapseId, t.seq, t.operation, t.activation, t.sourceEvent, t.timestamp, t.prevHash, t.hash],
    );
  }

  /** 某条突触的最后一条 trace 的 hash（没有则 genesis） */
  lastTraceHash(synapseId: string): string {
    const row = this.db.query("SELECT hash FROM synapse_traces WHERE synapse_id = ? ORDER BY seq DESC LIMIT 1").get(synapseId) as { hash?: string } | null;
    return row?.hash ?? GENESIS_HASH;
  }

  tracesFor(synapseId: string): SynapseTrace[] {
    const rows = this.db.query("SELECT * FROM synapse_traces WHERE synapse_id = ? ORDER BY seq ASC").all(synapseId) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: String(r.id),
      synapseId: String(r.synapse_id),
      seq: Number(r.seq),
      operation: String(r.operation) as SynapseTrace["operation"],
      activation: Number(r.activation),
      sourceEvent: String(r.source_event),
      timestamp: Number(r.timestamp),
      prevHash: String(r.prev_hash),
      hash: String(r.hash),
    }));
  }

  stats(): SynapseStats {
    const total = Number((this.db.query("SELECT COUNT(*) AS c FROM synapses").get() as { c: number }).c);
    const traceCount = Number((this.db.query("SELECT COUNT(*) AS c FROM synapse_traces").get() as { c: number }).c);
    const byTypeRows = this.db.query("SELECT target_type AS t, COUNT(*) AS c FROM synapses GROUP BY target_type").all() as Array<{ t: string; c: number }>;
    const byType: Record<string, number> = {};
    for (const r of byTypeRows) byType[r.t] = r.c;
    const act = this.db.query("SELECT COALESCE(SUM(weight), 0) AS s FROM synapses").get() as { s: number };
    return { total, byType, traceCount, totalActivation: Number(act.s) };
  }

  /**
   * 可校验路径：重算校验哈希并与存储比对。
   * 返回 { valid, reason }；任何字段被篡改 → invalid。
   */
  verify(id: string): { valid: boolean; reason: string } {
    const s = this.get(id);
    if (!s) return { valid: false, reason: `synapse ${id} not found` };
    const recomputed = computeSynapseVerifyHash(s);
    if (recomputed !== s.verifyHash) {
      return { valid: false, reason: `verify hash mismatch: stored=${s.verifyHash} recomputed=${recomputed}` };
    }
    // 全链校验
    const traces = this.tracesFor(id);
    let prev = GENESIS_HASH;
    for (const t of traces) {
      if (t.prevHash !== prev) {
        return { valid: false, reason: `trace chain broken at seq=${t.seq}: expected prev=${prev} got=${t.prevHash}` };
      }
      const expected = computeTraceHash({
        synapseId: t.synapseId,
        seq: t.seq,
        operation: t.operation,
        activation: t.activation,
        sourceEvent: t.sourceEvent,
        timestamp: t.timestamp,
        prevHash: t.prevHash,
      });
      if (t.hash !== expected) {
        return { valid: false, reason: `trace hash mismatch at seq=${t.seq}` };
      }
      prev = t.hash;
    }
    return { valid: true, reason: `synapse ${id} verified (${traces.length} trace records, chain intact)` };
  }

  remove(sourceId: string, targetId: string): boolean {
    const id = synapseId(sourceId, targetId);
    this.db.run("DELETE FROM synapses WHERE id = ?", [id]);
    return this.get(id) === null;
  }

  close(): void {
    try {
      this.db.close();
    } catch {
      /* already closed */
    }
  }
}

/** 便捷工厂：创建（或复用）一个突触对象 */
export function makeSynapse(
  sourceId: string,
  targetId: string,
  sourceType: SynapseNodeType,
  targetType: SynapseNodeType,
  weight: number,
  now = Date.now(),
): Synapse {
  const id = synapseId(sourceId, targetId);
  const base = { id, sourceId, targetId, sourceType, targetType, weight, activationCount: 0, lastActivatedAt: 0, createdAt: now };
  return { ...base, verifyHash: computeSynapseVerifyHash(base) };
}

/** 供测试/工具使用：打日志辅助 */
export function logSynapse(s: Synapse): void {
  logger.debug("[Synapse] " + s.id, { source: s.sourceId, target: s.targetId, weight: s.weight });
}
