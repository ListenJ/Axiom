/**
 * KG 表 DDL 单源（L3，2026-08-29 审计 S2）
 *
 * 此前 kg_nodes/kg_edges 建表语句在 src/kg/enhanced.ts 与
 * src/crawl/processor/kg-writer.ts 各存一份，存在漂移风险。
 * 现抽为本模块常量供两处 import（依赖方向：enhanced.ts / kg-writer.ts → 本模块，
 * 本模块零依赖，无环）。SQL 文本逐字符迁移自 enhanced.ts（含全部索引，为两份
 * 原文中的超集）；CREATE TABLE/INDEX 均为 IF NOT EXISTS，对既有库幂等无差异。
 */
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
