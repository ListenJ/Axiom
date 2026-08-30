/**
 * KG 表 DDL 单源（L3，2026-08-29 审计 S2）
 *
 * 此前 kg_nodes/kg_edges 建表语句在 src/kg/enhanced.ts 与
 * src/crawl/processor/kg-writer.ts 各存一份，存在漂移风险。
 * 现抽为本模块常量供两处 import（依赖方向：enhanced.ts / kg-writer.ts → 本模块，
 * 本模块零依赖，无环）。SQL 文本逐字符迁移自 enhanced.ts（含全部索引，为两份
 * 原文中的超集）；CREATE TABLE/INDEX 均为 IF NOT EXISTS，对既有库幂等无差异。
 */

import type { Database } from "bun:sqlite";
import { logger } from "../utils/logger.js";

export const KG_SCHEMA_DDL = `
      CREATE TABLE IF NOT EXISTS kg_nodes (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        name TEXT NOT NULL,
        description TEXT,
        file_path TEXT,
        line_number INTEGER,
        signature TEXT,
        semantic TEXT,
        tags TEXT DEFAULT '[]',
        metadata TEXT DEFAULT '{}',
        community INTEGER,
        importance REAL DEFAULT 0.5,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS kg_edges (
        id TEXT PRIMARY KEY,
        source TEXT NOT NULL,
        target TEXT NOT NULL,
        type TEXT NOT NULL,
        weight REAL DEFAULT 1.0,
        description TEXT,
        evidence TEXT DEFAULT '[]',
        created_at INTEGER NOT NULL,
        FOREIGN KEY (source) REFERENCES kg_nodes(id),
        FOREIGN KEY (target) REFERENCES kg_nodes(id)
      );

      CREATE INDEX IF NOT EXISTS idx_kg_edges_source ON kg_edges(source);
      CREATE INDEX IF NOT EXISTS idx_kg_edges_target ON kg_edges(target);
      CREATE INDEX IF NOT EXISTS idx_kg_edges_type ON kg_edges(type);
      CREATE INDEX IF NOT EXISTS idx_kg_nodes_type ON kg_nodes(type);
      CREATE INDEX IF NOT EXISTS idx_kg_nodes_community ON kg_nodes(community);
    `;

/**
 * KG 节点 FTS5 trigram 虚拟表 DDL（W5，落地形态审核 §2）。
 * 独立（非 external-content）fts5 表：kg_nodes.id 为 TEXT PK 无 INTEGER rowid 别名，
 * INSERT OR REPLACE 会重分配隐式 rowid，external-content 关联会失联——故用独立表 +
 * rowid 同步触发器（bench-kal-retrieval.ts KG_FTS_DDL 已验证等价性）。
 * 触发器用 IF NOT EXISTS：enhanced.ts / kg-writer.ts 可对同一 db 重复 exec，幂等。
 */
export const KG_FTS_DDL = `
      CREATE VIRTUAL TABLE IF NOT EXISTS kg_nodes_fts USING fts5(
        name, description, semantic,
        tokenize='trigram'
      );
      CREATE TRIGGER IF NOT EXISTS kg_nodes_fts_ai AFTER INSERT ON kg_nodes BEGIN
        INSERT INTO kg_nodes_fts(rowid, name, description, semantic)
        VALUES (new.rowid, new.name, new.description, new.semantic);
      END;
      CREATE TRIGGER IF NOT EXISTS kg_nodes_fts_ad AFTER DELETE ON kg_nodes BEGIN
        INSERT INTO kg_nodes_fts(kg_nodes_fts, rowid, name, description, semantic)
        VALUES('delete', old.rowid, old.name, old.description, old.semantic);
      END;
      CREATE TRIGGER IF NOT EXISTS kg_nodes_fts_au AFTER UPDATE ON kg_nodes BEGIN
        INSERT INTO kg_nodes_fts(kg_nodes_fts, rowid, name, description, semantic)
        VALUES('delete', old.rowid, old.name, old.description, old.semantic);
        INSERT INTO kg_nodes_fts(rowid, name, description, semantic)
        VALUES (new.rowid, new.name, new.description, new.semantic);
      END;
    `;

/**
 * 幂等确保 kg_nodes_fts 就绪并回填存量（W5 §2.3）。
 * 建表失败不阻断主表；回填仅在 FTS 行数 < kg 行数时执行。
 */
export function ensureKgFts(db: Database): void {
  try {
    db.exec(KG_FTS_DDL);
    const ftsCount = (db.query("SELECT COUNT(*) AS c FROM kg_nodes_fts").get() as { c: number }).c;
    const srcCount = (db.query("SELECT COUNT(*) AS c FROM kg_nodes").get() as { c: number }).c;
    if (ftsCount < srcCount) {
      // OR IGNORE：部分丢失场景下跳过已存在行、仅补回缺失行（避免与残留 FTS 行 rowid 冲突致整语句回滚、缺口永久不愈）
      db.exec(`INSERT OR IGNORE INTO kg_nodes_fts(rowid, name, description, semantic)
               SELECT rowid, name, description, semantic FROM kg_nodes`);
    }
  } catch (err) {
    // FTS 建表/回填失败：queryKG 探测 kg_nodes_fts 缺失则回退纯 LIKE，不中断启动
    logger.warn("[kg] ensureKgFts failed; kg_nodes_fts search degrades to LIKE", {
      error: (err as Error).message,
    });
  }
}
