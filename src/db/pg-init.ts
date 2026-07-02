/**
 * PostgreSQL 数据库初始化脚本
 *
 * 功能:
 *   1. 检查 PostgreSQL 连接
 *   2. 创建 pgvector 扩展 (如果需要)
 *   3. 执行 schema 初始化
 *   4. 验证表结构完整性
 *
 * 用法:
 *   bun run db:init
 *
 * 环境变量:
 *   DATABASE_URL=postgresql://user:pass@host:port/db
 *   或 PG_HOST, PG_PORT, PG_USER, PG_PASSWORD, PG_DATABASE
 */
import { initPgSchema, isPgAvailable, getPG, closePg } from "./pg-client.js";
import { logger } from "../utils/logger.js";

async function main() {
  logger.info("Axiom PostgreSQL Initialization");
  logger.info("====================================\n");

  // Step 1: 检查连接
  logger.info("[1/4] Checking PostgreSQL connection...");
  const available = await isPgAvailable();
  if (!available) {
    logger.error("ERROR: PostgreSQL is not available.");
    logger.error("Make sure PostgreSQL is running and DATABASE_URL is set correctly.");
    logger.error("\nFor Docker: docker-compose up postgres -d");
    logger.error("For local:  Set DATABASE_URL=postgresql://user:pass@localhost:5432/axiom");
    process.exit(1);
  }
  logger.info("  ✓ PostgreSQL connected\n");

  // Step 2: 检查 pgvector 扩展
  logger.info("[2/4] Checking pgvector extension...");
  const pg = getPG();
  try {
    const [ext] = await pg`SELECT * FROM pg_extension WHERE extname = 'vector'`;
    if (!ext) {
      logger.info("  → Installing pgvector extension...");
      await pg`CREATE EXTENSION IF NOT EXISTS vector`;
      logger.info("  ✓ pgvector installed");
    } else {
      logger.info("  ✓ pgvector already installed");
    }
  } catch (err) {
    logger.error("  ✗ Failed to install pgvector:", (err as Error).message);
    logger.error("  Make sure pgvector is installed: apt install postgresql-16-pgvector");
    process.exit(1);
  }

  // Step 3: 执行 schema
  logger.info("\n[3/4] Initializing schema...");
  try {
    await initPgSchema();
    logger.info("  ✓ Schema initialized\n");
  } catch (err) {
    logger.error("  ✗ Schema initialization failed:", (err as Error).message);
    process.exit(1);
  }

  // Step 4: 验证表结构
  logger.info("[4/4] Verifying tables...");
  const expectedTables = [
    "code_projects", "code_files", "code_nodes", "code_edges",
    "kg_entities", "kg_relationships",
    "memory_notes",
    "conversations", "tasks", "model_usage", "model_evaluations",
  ];

  const tables = await pg`
    SELECT tablename FROM pg_tables WHERE schemaname = 'public'
  `;
  const existingTables = new Set(tables.map((t: any) => t.tablename));

  let allOk = true;
  for (const table of expectedTables) {
    if (existingTables.has(table)) {
      logger.info(`  ✓ ${table}`);
    } else {
      logger.info(`  ✗ ${table} (MISSING)`);
      allOk = false;
    }
  }

  // 检查函数
  const functions = await pg`
    SELECT routine_name FROM information_schema.routines
    WHERE routine_schema = 'public' AND routine_type = 'FUNCTION'
  `;
  const existingFunctions = new Set(functions.map((f: any) => f.routine_name));

  logger.info("\nFunctions:");
  for (const fn of ["search_code_nodes", "search_kg_entities", "hybrid_search_memory", "kg_traverse"]) {
    if (existingFunctions.has(fn)) {
      logger.info(`  ✓ ${fn}()`);
    } else {
      logger.info(`  ✗ ${fn}() (MISSING)`);
      allOk = false;
    }
  }

  logger.info("\n====================================");
  if (allOk) {
    logger.info("All checks passed! Database is ready.");
  } else {
    logger.info("Some checks failed. Review the output above.");
  }

  await closePg();
  process.exit(allOk ? 0 : 1);
}

main().catch((err) => {
  logger.error("Fatal error:", err);
  process.exit(1);
});
