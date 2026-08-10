/**
 * 数据库迁移与初始化脚本
 * 运行: bun run src/db/migrate.ts
 */
import { Database } from "bun:sqlite";
import { logger } from "../utils/logger.js";
import { readString } from "../utils/env.js";

const dbPath = readString("DATABASE_PATH", "./data/agent.db");
const db = new Database(dbPath);

logger.info("[数据库] Initializing database...");

// ========== 核心表 ==========

// 会话元数据表（会话标题持久化；与 conversations 消息表按 session_id 关联）
db.run(`
  CREATE TABLE IF NOT EXISTS chat_sessions (
    session_id TEXT PRIMARY KEY,
    title TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )
`);
logger.info("[完成] chat_sessions");

db.run(`
  CREATE TABLE IF NOT EXISTS conversations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('user','assistant','system','tool')),
    content TEXT NOT NULL,
    tool_calls TEXT,
    tool_results TEXT,
    tokens_used INTEGER,
    latency_ms INTEGER,
    created_at INTEGER NOT NULL
  )
`);
logger.info("[完成] conversations");

db.run(`
  CREATE TABLE IF NOT EXISTS tool_invocations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT,
    tool TEXT NOT NULL,
    args_hash TEXT NOT NULL,
    result_hash TEXT,
    args_preview TEXT,
    result_ref TEXT,
    status TEXT NOT NULL,
    latency_ms INTEGER,
    output_bytes INTEGER,
    created_at INTEGER NOT NULL
  )
`);
logger.info("[完成] tool_invocations");

db.run(`CREATE INDEX IF NOT EXISTS idx_tool_inv_session ON tool_invocations(session_id, created_at DESC)`);
db.run(`CREATE INDEX IF NOT EXISTS idx_tool_inv_tool ON tool_invocations(tool, created_at DESC)`);

db.run(`
  CREATE TABLE IF NOT EXISTS session_lineage (
    session_id TEXT PRIMARY KEY,
    parent_session_id TEXT,
    title TEXT NOT NULL DEFAULT '',
    summary TEXT NOT NULL DEFAULT '',
    message_count INTEGER NOT NULL DEFAULT 0,
    token_estimate INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'active',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )
`);
db.run(`CREATE VIRTUAL TABLE IF NOT EXISTS session_lineage_fts USING fts5(session_id UNINDEXED, title, summary, tokenize = 'unicode61')`);
db.run(`CREATE INDEX IF NOT EXISTS idx_session_lineage_updated ON session_lineage(updated_at DESC)`);
db.run(`CREATE INDEX IF NOT EXISTS idx_session_lineage_parent ON session_lineage(parent_session_id)`);
logger.info("[完成] session_lineage");

db.run(`
  CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_key TEXT UNIQUE NOT NULL,
    agent_id TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT,
    status TEXT CHECK(status IN ('pending','in_progress','completed','failed','cancelled')) NOT NULL DEFAULT 'pending',
    priority INTEGER NOT NULL DEFAULT 5,
    parent_task_id INTEGER,
    metadata TEXT,
    context_summary TEXT,
    result_summary TEXT,
    started_at INTEGER,
    completed_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )
`);
logger.info("[完成] tasks");

db.run(`
  CREATE TABLE IF NOT EXISTS knowledge (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tier TEXT CHECK(tier IN ('episodic','semantic','project','procedural')) NOT NULL DEFAULT 'semantic',
    source TEXT NOT NULL,
    topic_key TEXT NOT NULL,
    content TEXT NOT NULL,
    metadata TEXT,
    confidence REAL NOT NULL DEFAULT 0.7,
    access_count INTEGER NOT NULL DEFAULT 0,
    distilled INTEGER NOT NULL DEFAULT 0,
    expires_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )
`);
logger.info("[完成] knowledge");

db.run(`
  CREATE TABLE IF NOT EXISTS entities (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE NOT NULL,
    type TEXT NOT NULL,
    properties TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )
`);
logger.info("[完成] entities");

db.run(`
  CREATE TABLE IF NOT EXISTS relationships (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_entity INTEGER NOT NULL,
    target_entity INTEGER NOT NULL,
    relation_type TEXT NOT NULL,
    properties TEXT,
    created_at INTEGER NOT NULL
  )
`);
logger.info("[完成] relationships");

db.run(`
  CREATE TABLE IF NOT EXISTS model_usage (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    model_name TEXT NOT NULL,
    provider TEXT NOT NULL,
    tier INTEGER NOT NULL,
    tokens_input INTEGER DEFAULT 0,
    tokens_output INTEGER DEFAULT 0,
    tokens_total INTEGER DEFAULT 0,
    latency_ms INTEGER,
    cost_estimate REAL DEFAULT 0,
    task_type TEXT,
    success INTEGER DEFAULT 1,
    error_message TEXT,
    created_at INTEGER NOT NULL
  )
`);
logger.info("[完成] model_usage");

// ========== 爬取结果持久化 ==========

db.run(`
  CREATE TABLE IF NOT EXISTS crawl_results (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    url TEXT NOT NULL,
    url_hash TEXT NOT NULL UNIQUE,
    title TEXT,
    description TEXT,
    site_name TEXT,
    language TEXT,
    markdown TEXT,
    structured_data TEXT,
    headings TEXT,
    tables TEXT,
    code_blocks TEXT,
    images TEXT,
    links TEXT,
    chunks TEXT,
    word_count INTEGER DEFAULT 0,
    quality_score REAL DEFAULT 0,
    fetch_engine TEXT DEFAULT 'bun',
    fingerprint_id TEXT,
    proxy_used TEXT,
    status TEXT CHECK(status IN ('success','failed','timeout')) DEFAULT 'success',
    error_message TEXT,
    fetched_at INTEGER,
    created_at INTEGER NOT NULL
  )
`);
logger.info("[完成] crawl_results");

// ========== 搜索历史 ==========

db.run(`
  CREATE TABLE IF NOT EXISTS search_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    query TEXT NOT NULL,
    query_hash TEXT NOT NULL,
    engines TEXT,
    results_count INTEGER DEFAULT 0,
    top_result_url TEXT,
    latency_ms INTEGER,
    created_at INTEGER NOT NULL
  )
`);
logger.info("[完成] search_history");

// ========== FTS5 全文索引 ==========

db.run(`
  CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(
    path, title, content,
    tokenize = 'porter unicode61'
  )
`);
logger.info("[完成] notes_fts (Porter + Unicode61)");

db.run(`
  CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts_cjk USING fts5(
    path, title, content,
    tokenize = 'trigram'
  )
`);
logger.info("[完成] notes_fts_cjk (Trigram)");

// ========== 索引 ==========

db.run(`CREATE INDEX IF NOT EXISTS idx_conv_session ON conversations(session_id)`);
db.run(`CREATE INDEX IF NOT EXISTS idx_conv_created ON conversations(created_at)`);
db.run(`CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status)`);
db.run(`CREATE INDEX IF NOT EXISTS idx_tasks_agent ON tasks(agent_id)`);
db.run(`CREATE INDEX IF NOT EXISTS idx_knowledge_topic ON knowledge(topic_key)`);
db.run(`CREATE INDEX IF NOT EXISTS idx_knowledge_tier ON knowledge(tier)`);
db.run(`CREATE INDEX IF NOT EXISTS idx_entities_name ON entities(name)`);
db.run(`CREATE INDEX IF NOT EXISTS idx_entities_type ON entities(type)`);
db.run(`CREATE INDEX IF NOT EXISTS idx_rel_source ON relationships(source_entity)`);
db.run(`CREATE INDEX IF NOT EXISTS idx_rel_target ON relationships(target_entity)`);
db.run(`CREATE INDEX IF NOT EXISTS idx_model_usage_created ON model_usage(created_at)`);
db.run(`CREATE INDEX IF NOT EXISTS idx_crawl_url_hash ON crawl_results(url_hash)`);
db.run(`CREATE INDEX IF NOT EXISTS idx_crawl_site ON crawl_results(site_name)`);
db.run(`CREATE INDEX IF NOT EXISTS idx_crawl_created ON crawl_results(created_at)`);
db.run(`CREATE INDEX IF NOT EXISTS idx_search_query_hash ON search_history(query_hash)`);
db.run(`CREATE INDEX IF NOT EXISTS idx_search_created ON search_history(created_at)`);
logger.info("[完成] indexes");

// ========== 系统状态 ==========

db.run(`
  CREATE TABLE IF NOT EXISTS system_state (
    key TEXT PRIMARY KEY,
    value TEXT,
    updated_at INTEGER DEFAULT (unixepoch())
  )
`);

db.run(
  `INSERT OR REPLACE INTO system_state (key, value) VALUES ('schema_version', '1.1.0')`
);
db.run(
  `INSERT OR REPLACE INTO system_state (key, value) VALUES ('last_migrated', ?)`,
  [new Date().toISOString()]
);

logger.info("\n🎉 Database initialization complete!");
logger.info(`   Path: ${dbPath}`);
logger.info(`   Schema version: 1.1.0`);

db.close();
