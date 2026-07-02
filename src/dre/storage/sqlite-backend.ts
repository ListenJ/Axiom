/**
 * SQLite 存储后端
 *
 * 特性:
 * - WAL 模式提高并发性能
 * - 自动版本快照 (kv_history 表)
 * - 内容哈希 (sha256) 保证确定性
 * - 支持知识库范式 (knowledge_node)
 */

import { Database } from "bun:sqlite";
import { createHash } from "crypto";
import type { IBackend, Inode } from "../vfs.js";
import { NodeType } from "../vfs.js";
import { logger } from "../../utils/logger.js";

export class SqliteBackend implements IBackend {
  private db: Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.initialize();
  }

  private initialize(): void {
    this.db.exec("PRAGMA journal_mode=WAL;");
    this.db.exec("PRAGMA synchronous=NORMAL;");

    // 主 KV 表
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS kv (
        path TEXT PRIMARY KEY,
        content BLOB,
        hash TEXT NOT NULL,
        size INTEGER NOT NULL,
        mtime INTEGER NOT NULL,
        revision INTEGER DEFAULT 1,
        node_type TEXT DEFAULT 'file',
        node_id TEXT
      );
    `);

    // 版本历史表
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS kv_history (
        path TEXT NOT NULL,
        revision INTEGER NOT NULL,
        content BLOB,
        reason TEXT,
        mtime INTEGER NOT NULL,
        PRIMARY KEY (path, revision)
      );
    `);

    // 知识条目表
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS knowledge_node (
        node_id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        schema_version INTEGER NOT NULL DEFAULT 1,
        domain TEXT NOT NULL,
        paradigm TEXT NOT NULL DEFAULT 'fact',
        confidence REAL NOT NULL DEFAULT 0.5,
        source_type TEXT NOT NULL,
        source_uri TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        revision INTEGER NOT NULL DEFAULT 1,
        is_verified INTEGER NOT NULL DEFAULT 0,
        behavior TEXT,
        prediction TEXT,
        hypothesis TEXT,
        CHECK (confidence BETWEEN 0.0 AND 1.0)
      );
    `);

    // v2.9.0 迁移: 为已有表添加新列 (ALTER TABLE ADD COLUMN 是幂等的)
    this.safeAddColumn("knowledge_node", "behavior", "TEXT");
    this.safeAddColumn("knowledge_node", "prediction", "TEXT");
    this.safeAddColumn("knowledge_node", "hypothesis", "TEXT");

    // 知识版本快照表
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS knowledge_revision (
        node_id TEXT NOT NULL,
        revision INTEGER NOT NULL,
        content TEXT NOT NULL,
        diff TEXT,
        reason TEXT,
        verified_by TEXT,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (node_id, revision)
      );
    `);

    // FTS5 全文索引 (用于 knowledge_node 快速搜索)
    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_node_fts USING fts5(
        node_id, title, content, domain,
        content=knowledge_node,
        content_rowid=rowid
      );
      -- 同步触发器: 自动维护 FTS 索引
      CREATE TRIGGER IF NOT EXISTS knowledge_node_ai AFTER INSERT ON knowledge_node BEGIN
        INSERT INTO knowledge_node_fts(rowid, node_id, title, content, domain)
        VALUES (new.rowid, new.node_id, new.title, new.content, new.domain);
      END;
      CREATE TRIGGER IF NOT EXISTS knowledge_node_ad AFTER DELETE ON knowledge_node BEGIN
        INSERT INTO knowledge_node_fts(knowledge_node_fts, rowid, node_id, title, content, domain)
        VALUES ('delete', old.rowid, old.node_id, old.title, old.content, old.domain);
      END;
      CREATE TRIGGER IF NOT EXISTS knowledge_node_au AFTER UPDATE ON knowledge_node BEGIN
        INSERT INTO knowledge_node_fts(knowledge_node_fts, rowid, node_id, title, content, domain)
        VALUES ('delete', old.rowid, old.node_id, old.title, old.content, old.domain);
        INSERT INTO knowledge_node_fts(rowid, node_id, title, content, domain)
        VALUES (new.rowid, new.node_id, new.title, new.content, new.domain);
      END;
    `);

    // 知识图谱边表
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS kg_edge (
        src_node TEXT NOT NULL,
        dst_node TEXT NOT NULL,
        relation TEXT NOT NULL,
        weight REAL DEFAULT 1.0,
        evidence TEXT,
        PRIMARY KEY (src_node, dst_node, relation)
      );
      CREATE INDEX IF NOT EXISTS idx_kg_src ON kg_edge(src_node);
      CREATE INDEX IF NOT EXISTS idx_kg_rel ON kg_edge(relation);
    `);

    // 推理日志表 (确定性回放)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS reasoning_trace (
        trace_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        step_seq INTEGER NOT NULL,
        step_type TEXT NOT NULL,
        input_hash TEXT,
        output_hash TEXT,
        model_name TEXT,
        prompt_hash TEXT,
        seed INTEGER,
        temperature REAL,
        payload TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_trace_session ON reasoning_trace(session_id);
      CREATE INDEX IF NOT EXISTS idx_trace_seq ON reasoning_trace(step_seq);
    `);
  }

  async read(path: string): Promise<string | null> {
    const stmt = this.db.prepare("SELECT content FROM kv WHERE path = ?");
    const row = stmt.get(path) as { content: Buffer } | undefined;
    return row ? new TextDecoder().decode(row.content as Uint8Array) : null;
  }

  async write(path: string, data: string, reason: string = "manual"): Promise<boolean> {
    const now = Date.now();
    const hash = createHash("sha256").update(data).digest("hex");

    const txn = this.db.transaction(() => {
      // 保存旧版本到历史
      this.db.prepare(`
        INSERT INTO kv_history (path, revision, content, reason, mtime)
        SELECT path, revision, content, ?, ? FROM kv WHERE path = ?
      `).run(reason, now, path);

      // 插入或更新
      this.db.prepare(`
        INSERT INTO kv (path, content, hash, size, mtime, revision)
        VALUES (?, ?, ?, ?, ?, 1)
        ON CONFLICT(path) DO UPDATE SET
          content = excluded.content,
          hash = excluded.hash,
          size = excluded.size,
          mtime = excluded.mtime,
          revision = kv.revision + 1
      `).run(path, Buffer.from(data), hash, data.length, now);
    });

    txn();
    return true;
  }

  async stat(path: string): Promise<Inode | null> {
    const stmt = this.db.prepare(`
      SELECT path, hash, size, mtime, revision, node_type, node_id
      FROM kv WHERE path = ?
    `);
    const row = stmt.get(path) as {
      path: string;
      hash: string;
      size: number;
      mtime: number;
      revision: number;
      node_type: string;
      node_id: string | null;
    } | undefined;

    if (!row) return null;

    return {
      path: row.path,
      type: row.node_type as NodeType,
      nodeId: row.node_id || undefined,
      contentHash: row.hash,
      size: row.size,
      mtime: row.mtime,
      revision: row.revision,
    };
  }

  async list(dir: string): Promise<Inode[]> {
    const prefix = dir.endsWith("/") ? dir : dir + "/";
    const stmt = this.db.prepare(`
      SELECT path, hash, size, mtime, revision, node_type, node_id
      FROM kv WHERE path LIKE ? OR path = ?
    `);
    const rows = stmt.all(prefix + "%", dir) as Array<{
      path: string;
      hash: string;
      size: number;
      mtime: number;
      revision: number;
      node_type: string;
      node_id: string | null;
    }>;

    return rows.map((row) => ({
      path: row.path,
      type: row.node_type as NodeType,
      nodeId: row.node_id || undefined,
      contentHash: row.hash,
      size: row.size,
      mtime: row.mtime,
      revision: row.revision,
    }));
  }

  async delete(path: string): Promise<boolean> {
    const result = this.db.prepare("DELETE FROM kv WHERE path = ?").run(path);
    return result.changes > 0;
  }

  /**
   * 获取文件版本历史
   */
  getHistory(path: string): Array<{
    revision: number;
    reason: string;
    mtime: number;
  }> {
    const stmt = this.db.prepare(`
      SELECT revision, reason, mtime FROM kv_history
      WHERE path = ? ORDER BY revision DESC
    `);
    return stmt.all(path) as Array<{
      revision: number;
      reason: string;
      mtime: number;
    }>;
  }

  /**
   * 回滚到指定版本
   */
  rollback(path: string, revision: number): boolean {
    const txn = this.db.transaction(() => {
      // 获取历史版本
      const row = this.db.prepare(`
        SELECT content FROM kv_history WHERE path = ? AND revision = ?
      `).get(path, revision) as { content: Buffer } | undefined;

      if (!row) return false;

      // 保存当前版本到历史
      this.db.prepare(`
        INSERT INTO kv_history (path, revision, content, reason, mtime)
        SELECT path, revision, content, 'rollback', ? FROM kv WHERE path = ?
      `).run(Date.now(), path);

      // 恢复历史版本
      const hash = createHash("sha256").update(row.content).digest("hex");
      this.db.prepare(`
        UPDATE kv SET content = ?, hash = ?, size = ?, mtime = ?, revision = revision + 1
        WHERE path = ?
      `).run(row.content, hash, row.content.length, Date.now(), path);

      return true;
    });

    return txn();
  }

  /**
   * 安全添加列 (如果列不存在则添加，已存在则跳过)
   */
  private safeAddColumn(table: string, column: string, type: string): void {
    try {
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
    } catch (err) {
      logger.debug("[SQLite] Column already exists or alter failed", { table, column, error: (err as Error).message });
    }
  }

  /**
   * 关闭数据库
   */
  close(): void {
    this.db.close();
  }
}
