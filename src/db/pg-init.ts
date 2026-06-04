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
  console.log("OpenClaw PostgreSQL Initialization");
  console.log("====================================\n");

  // Step 1: 检查连接
  console.log("[1/4] Checking PostgreSQL connection...");
  const available = await isPgAvailable();
  if (!available) {
    console.error("ERROR: PostgreSQL is not available.");
    console.error("Make sure PostgreSQL is running and DATABASE_URL is set correctly.");
    console.error("\nFor Docker: docker-compose up postgres -d");
    console.error("For local:  Set DATABASE_URL=postgresql://user:pass@localhost:5432/openclaw");
    process.exit(1);
  }
  console.log("  ✓ PostgreSQL connected\n");

  // Step 2: 检查 pgvector 扩展
  console.log("[2/4] Checking pgvector extension...");
  const pg = getPG();
  try {
    const [ext] = await pg`SELECT * FROM pg_extension WHERE extname = 'vector'`;
    if (!ext) {
      console.log("  → Installing pgvector extension...");
      await pg`CREATE EXTENSION IF NOT EXISTS vector`;
      console.log("  ✓ pgvector installed");
    } else {
      console.log("  ✓ pgvector already installed");
    }
  } catch (err) {
    console.error("  ✗ Failed to install pgvector:", (err as Error).message);
    console.error("  Make sure pgvector is installed: apt install postgresql-16-pgvector");
    process.exit(1);
  }

  // Step 3: 执行 schema
  console.log("\n[3/4] Initializing schema...");
  try {
    await initPgSchema();
    console.log("  ✓ Schema initialized\n");
  } catch (err) {
    console.error("  ✗ Schema initialization failed:", (err as Error).message);
    process.exit(1);
  }

  // Step 4: 验证表结构
  console.log("[4/4] Verifying tables...");
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
      console.log(`  ✓ ${table}`);
    } else {
      console.log(`  ✗ ${table} (MISSING)`);
      allOk = false;
    }
  }

  // 检查函数
  const functions = await pg`
    SELECT routine_name FROM information_schema.routines
    WHERE routine_schema = 'public' AND routine_type = 'FUNCTION'
  `;
  const existingFunctions = new Set(functions.map((f: any) => f.routine_name));

  console.log("\nFunctions:");
  for (const fn of ["search_code_nodes", "search_kg_entities", "hybrid_search_memory", "kg_traverse"]) {
    if (existingFunctions.has(fn)) {
      console.log(`  ✓ ${fn}()`);
    } else {
      console.log(`  ✗ ${fn}() (MISSING)`);
      allOk = false;
    }
  }

  console.log("\n====================================");
  if (allOk) {
    console.log("All checks passed! Database is ready.");
  } else {
    console.log("Some checks failed. Review the output above.");
  }

  await closePg();
  process.exit(allOk ? 0 : 1);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
