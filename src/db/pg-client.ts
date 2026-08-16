/**
 * PostgreSQL 连接管理器 — 自适应连接策略
 *
 * 连接策略:
 *   1. 优先使用 DATABASE_URL 环境变量
 *   2. 回退到独立参数: PG_HOST, PG_PORT, PG_USER, PG_PASSWORD, PG_DATABASE
 *   3. 开发模式: 如果 PG 不可用，静默回退到 SQLite (零中断)
 *
 * 用法:
 *   import { pg, isPgAvailable } from "./pg-client.js";
 *   if (isPgAvailable()) {
 *     const results = await pg`SELECT * FROM kg_entities WHERE type = ${type}`;
 *   }
 */
import postgres from "postgres";
import { logger } from "../utils/logger.js";
import { readString, readInt } from "../utils/env.js";
import { validateTableName, validateColumnName, quoteIdentifier } from "../utils/db-guard.js";

// ========== 连接配置 ==========

function getConnectionConfig() {
  const url = readString("DATABASE_URL");
  // 只有 postgresql:// 或 postgres:// 格式的 URL 才用于 PG 连接
  if (url && (url.startsWith("postgresql://") || url.startsWith("postgres://"))) {
    return { url };
  }

  const host = readString("PG_HOST", "localhost");
  const port = readInt("PG_PORT", 5432);
  const user = readString("PG_USER", "axiom");
  const password = readString("PG_PASSWORD", "axiom");
  const database = readString("PG_DATABASE", "axiom");

  return {
    url: `postgresql://${user}:${password}@${host}:${port}/${database}`,
  };
}

// ========== 连接实例 ==========

let _pg: postgres.Sql | null = null;
let _pgAvailable: boolean | undefined = undefined;

/**
 * 获取 PostgreSQL 连接实例 (单例)
 */
// 返回 any：与现有调用方契约一致（查询结果为非类型化 Row），避免 postgres 3.x 类型化 API 与旧调用方冲突
export function getPG(): any {
  if (_pg) return _pg;

  const { url } = getConnectionConfig();
  _pg = postgres(url, {
    max: 10,                    // 连接池大小
    idle_timeout: 30,           // 空闲超时 (秒)
    connect_timeout: 10,        // 连接超时 (秒)
    onnotice: (notice: any) => {
      if (notice.severity === "ERROR" || notice.severity === "FATAL") {
        logger.error(`[PG] ${notice.severity}: ${notice.message}`);
      }
    },
    onparameter: (key: string, value: string) => {
      if (key === "server_version") {
        logger.info(`[PG] Connected to PostgreSQL ${value}`);
      }
    },
  });

  return _pg;
}

/**
 * 检查 PostgreSQL 是否可用 (带缓存)
 */
export async function isPgAvailable(): Promise<boolean> {
  if (_pgAvailable !== undefined) return _pgAvailable;

  try {
    const pg = getPG();
    await pg`SELECT 1`;
    _pgAvailable = true;
    logger.info("[PG] PostgreSQL connection established");
  } catch (err) {
    _pgAvailable = false;
    logger.warn("[PG] PostgreSQL unavailable, falling back to SQLite", {
      reason: (err as Error).message,
    });
  }

  return _pgAvailable;
}

/**
 * 重新检测 PostgreSQL 可用性 (清除缓存)
 */
export async function recheckPgAvailability(): Promise<boolean> {
  _pgAvailable = undefined;
  if (_pg) {
    try {
      await _pg.end({ timeout: 3 });
    } catch { /* ignore */ }
    _pg = null;
  }
  return isPgAvailable();
}

/**
 * 初始化 PostgreSQL schema (执行 pg-schema.sql)
 */
export async function initPgSchema(): Promise<void> {
  const pg = getPG();
  const { readFileSync } = await import("fs");
  const { resolve } = await import("path");

  const schemaPath = resolve(import.meta.dir, "pg-schema.sql");
  const schemaSql = readFileSync(schemaPath, "utf-8");

  logger.info("[PG] Initializing schema...");
  await pg.unsafe(schemaSql);
  logger.info("[PG] Schema initialized successfully");
}

/**
 * 关闭 PostgreSQL 连接
 */
export async function closePg(): Promise<void> {
  if (_pg) {
    await _pg.end({ timeout: 5 });
    _pg = null;
    _pgAvailable = undefined;
    logger.info("[PG] Connection closed");
  }
}

// ========== 便捷查询函数 ==========

/**
 * 带类型的查询包装 (使用 unsafe 以支持任意 SQL)
 *
 * WARNING: Callers MUST use parameterized queries ($1, $2, ...) for all
 * user-supplied values. NEVER interpolate user input into the sql string.
 * For table/column names, use validateTableName/validateColumnName from db-guard.
 */
export async function pgQuery(sql: string, params: any[] = []): Promise<any[]> {
  const pg = getPG();
  const result = await pg.unsafe(sql, params);
  return result as any[];
}

/**
 * 批量插入 (分批处理，每批 1000 行)
 * SECURITY: table and column names are validated against allowlists
 */
export async function pgBulkInsert(
  table: string,
  columns: string[],
  rows: any[][],
): Promise<number> {
  const pg = getPG();

  if (rows.length === 0) return 0;

  // Validate table and column names against allowlists
  const safeTable = validateTableName(table);
  const safeColumns = columns.map(c => validateColumnName(c));

  const batchSize = 1000;
  let totalInserted = 0;

  for (let i = 0; i < rows.length; i += batchSize) {
    const batch = rows.slice(i, i + batchSize);
    const valuesList = batch.map((row, idx) => {
      const placeholders = row.map((_, colIdx) => `$${idx * safeColumns.length + colIdx + 1}`).join(", ");
      return `(${placeholders})`;
    }).join(", ");

    const colList = safeColumns.map(c => `"${c}"`).join(", ");
    const flatValues = batch.flat();

    await pg.unsafe(
      `INSERT INTO ${safeTable} (${colList}) VALUES ${valuesList}
       ON CONFLICT DO NOTHING`,
      flatValues as any,
    );
    totalInserted += batch.length;
  }

  return totalInserted;
}

/**
 * 向量相似度搜索的便捷封装
 * SECURITY: table/embeddingColumn/selectColumns are validated against allowlists
 */
export async function pgVectorSearch(
  table: string,
  embeddingColumn: string,
  queryEmbedding: number[],
  options: {
    limit?: number;
    threshold?: number;
    where?: string;
    selectColumns?: string[];
  } = {},
): Promise<any[]> {
  const pg = getPG();
  const { limit = 10, threshold = 0.5, where, selectColumns } = options;

  // Validate table and column names against allowlists
  const safeTable = validateTableName(table);
  const safeColumn = validateColumnName(embeddingColumn);
  const safeCols = selectColumns?.map(c => validateColumnName(c)).join(", ") || "*";
  const quotedCol = quoteIdentifier(safeColumn);

  const embeddingStr = `[${queryEmbedding.join(",")}]`;
  // SECURITY: `where` is a raw SQL fragment — only pass trusted, pre-validated conditions
  // Never pass user input directly. Use parameterized values ($1, $2, ...) where possible.
  const whereClause = where ? `AND (${where})` : "";

  const results = await pg.unsafe(`
    SELECT ${safeCols},
           (1 - (${quotedCol} <=> $1::vector)) AS similarity
    FROM ${safeTable}
    WHERE ${quotedCol} IS NOT NULL
      AND (1 - (${quotedCol} <=> $1::vector)) > $2
      ${whereClause}
    ORDER BY ${quotedCol} <=> $1::vector
    LIMIT $3
  `, [embeddingStr, threshold, limit]);

  return results;
}
