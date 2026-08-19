/**
 * 单一知识库迁移：把历史独立知识库（code-index / dre / knowledge）并入主库 agent.db。
 *
 * 背景：知识层统一到 DATABASE_PATH（默认 ./data/agent.db）后，旧库中的存量数据
 * 需要一次性搬入主库。本脚本可重复执行（INSERT OR IGNORE + 幂等 DDL），
 * 执行完成后旧库文件可归档（archive/）。
 *
 * 用法：
 *   bun run scripts/merge-knowledge-dbs.ts                 # 默认迁移 data/ 下三个旧库
 *   DATABASE_PATH=/path/agent.db bun run scripts/merge-knowledge-dbs.ts
 */
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { readString } from "../src/utils/env.js";

const TARGET = readString("DATABASE_PATH", "./data/agent.db");
const SOURCES = process.argv.slice(2);
if (SOURCES.length === 0) {
  SOURCES.push("./data/code-index.db", "./data/dre.db", "./data/knowledge.db");
}

/** 收集 fts 虚拟表名，用于跳过其影子表（_data/_idx/_docsize/_config）。 */
function ftsNames(db: Database): Set<string> {
  const rows = db.query(
    `SELECT name FROM sqlite_master WHERE type='table' AND sql LIKE 'CREATE VIRTUAL TABLE%'`
  ).all() as Array<{ name: string }>;
  return new Set(rows.map((r) => r.name));
}

function migrate(sourcePath: string): void {
  if (!existsSync(sourcePath)) {
    console.log(`[merge] skip (missing): ${sourcePath}`);
    return;
  }
  const src = new Database(sourcePath, { readonly: true });
  const dst = new Database(TARGET);
  dst.exec("PRAGMA journal_mode=WAL");
  dst.exec("PRAGMA synchronous=NORMAL");
  dst.run(`ATTACH DATABASE ? AS src`, [sourcePath]);

  const fts = ftsNames(src);
  const isShadow = (name: string): boolean =>
    [...fts].some((f) => name.startsWith(`${f}_`));

  const tables = src.query(
    `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`
  ).all() as Array<{ name: string }>;

  // 1) 基础表（先建后拷，触发 FTS 触发器自动同步索引）
  for (const { name } of tables) {
    if (fts.has(name) || isShadow(name)) continue;
    const has = dst.query(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`).get(name);
    if (!has) {
      const ddl = src.query(`SELECT sql FROM sqlite_master WHERE type='table' AND name=?`).get(name) as { sql: string } | null;
      if (ddl?.sql) dst.exec(ddl.sql);
    }
    const before = (dst.query(`SELECT COUNT(*) c FROM "${name}"`).get() as { c: number }).c;
    dst.run(`INSERT OR IGNORE INTO "${name}" SELECT * FROM src."${name}"`);
    const after = (dst.query(`SELECT COUNT(*) c FROM "${name}"`).get() as { c: number }).c;
    const srcCount = (src.query(`SELECT COUNT(*) c FROM "${name}"`).get() as { c: number }).c;
    console.log(`[merge] ${name}: +${after - before} (src=${srcCount}, total=${after})`);
  }

  // 2) FTS 虚拟表（依赖基础表已存在）
  for (const name of fts) {
    const has = dst.query(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`).get(name);
    if (!has) {
      const ddl = src.query(`SELECT sql FROM sqlite_master WHERE type='table' AND name=?`).get(name) as { sql: string } | null;
      if (ddl?.sql) dst.exec(ddl.sql);
    }
  }

  // 3) 触发器 + 索引（幂等）
  for (const type of ["trigger", "index"] as const) {
    const objs = src.query(
      `SELECT name, sql FROM sqlite_master WHERE type=? AND sql IS NOT NULL`, [type]
    ).all() as Array<{ name: string; sql: string }>;
    for (const o of objs) {
      const has = dst.query(`SELECT 1 FROM sqlite_master WHERE type=? AND name=?`, [type, o.name]).get();
      if (has) continue;
      const sql = type === "trigger"
        ? o.sql.replace(/^CREATE TRIGGER\s/, "CREATE TRIGGER IF NOT EXISTS ")
        : o.sql.replace(/^CREATE INDEX\s/, "CREATE INDEX IF NOT EXISTS ");
      dst.exec(sql);
    }
  }

  // 4) FTS 完整性校验 + 重建（若触发器同步数量不一致）
  for (const name of fts) {
    try {
      const base = name.replace(/_fts$/, "");
      const baseCount = (dst.query(`SELECT COUNT(*) c FROM "${base}"`).get() as { c: number }).c;
      const ftsCount = (dst.query(`SELECT COUNT(*) c FROM "${name}"`).get() as { c: number }).c;
      if (baseCount !== ftsCount) {
        console.log(`[merge] ${name}: rebuild (base=${baseCount}, fts=${ftsCount})`);
        dst.run(`INSERT INTO "${name}"("${name}") VALUES ('rebuild')`);
      } else {
        console.log(`[merge] ${name}: ok (${ftsCount})`);
      }
    } catch (e) {
      console.warn(`[merge] ${name}: skip fts check (${(e as Error).message})`);
    }
  }

  src.close();
  dst.close();
  console.log(`[merge] done: ${sourcePath} -> ${TARGET}`);
}

for (const p of SOURCES) migrate(p);
console.log(`[merge] all sources merged into ${TARGET}`);
