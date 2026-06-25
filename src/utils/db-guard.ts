/**
 * Database Guard — SQL 注入防护中间件
 *
 * 提供安全的 SQL 标识符引用、表名白名单验证、输入清洗
 */

// Allowlist of valid table names in the system
const VALID_TABLES = new Set([
  // SQLite (agent.db)
  "conversations", "tasks", "knowledge", "entities", "relationships",
  "model_usage", "free_models", "crawl_results", "search_history", "system_state",
  // SQLite FTS
  "notes_fts", "notes_fts_cjk",
  // SQLite memory
  "memory_notes",
  // PostgreSQL (pg-schema.sql)
  "code_projects", "code_files", "code_nodes", "code_edges", "code_unresolved_refs",
  "kg_entities", "kg_relationships",
  "memory_notes",
  "conversations", "tasks", "model_usage", "model_evaluations",
]);

// Allowlist of valid column names
const VALID_COLUMNS = new Set([
  "id", "name", "type", "description", "properties", "source", "embedding",
  "created_at", "updated_at", "session_id", "role", "content", "agent_id",
  "tool_calls", "tool_results", "tokens_used", "latency_ms", "model",
  "provider", "status", "priority", "parent_id", "context", "result",
  "title", "path", "category", "tags", "links", "word_count", "frontmatter",
  "query", "query_hash", "engines", "result_count", "top_url",
  "kind", "qualified_name", "file_path", "language", "start_line", "end_line",
  "signature", "weight", "relation_type", "source_id", "target_id",
  "confidence", "access_count", "expires_at", "tier",
  // View columns
  "degree", "in_degree", "out_degree",
]);

export function validateTableName(table: string): string {
  const cleaned = table.replace(/[^a-zA-Z0-9_]/g, "");
  if (!VALID_TABLES.has(cleaned)) {
    throw new Error(`Invalid table name: ${table}`);
  }
  return cleaned;
}

export function validateColumnName(column: string): string {
  const cleaned = column.replace(/[^a-zA-Z0-9_]/g, "");
  if (!VALID_COLUMNS.has(cleaned)) {
    throw new Error(`Invalid column name: ${column}`);
  }
  return cleaned;
}

export function quoteIdentifier(name: string): string {
  // Only allow safe characters in identifiers
  const cleaned = name.replace(/[^a-zA-Z0-9_]/g, "");
  if (cleaned !== name) {
    throw new Error(`Unsafe identifier: ${name}`);
  }
  return `"${cleaned}"`;
}

/** Sanitize a value for safe SQL usage (for non-parameterized contexts) */
export function sanitizeSqlValue(value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") {
    if (!isFinite(value)) throw new Error("Invalid numeric value");
    return String(value);
  }
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  // For strings, throw — should always use parameterized queries
  throw new Error("String values must use parameterized queries, not inline interpolation");
}

/** Validate that a path does not escape a base directory */
export function validatePath(basePath: string, userPath: string): string {
  const path = require("path");
  const resolved = path.resolve(basePath, userPath);
  const base = path.resolve(basePath);
  const relative = path.relative(base, resolved);
  if (relative.startsWith("..") || relative === ".." || path.isAbsolute(relative)) {
    throw new Error(`Path traversal detected: ${userPath}`);
  }
  return resolved;
}
