/**
 * P1-S2 层2：memory_notes_fts trigram 迁移 + 查询侧短词兜底
 *
 * 审计判定：unicode61 把连续中文当单 token，子串查询（"机器学习" ⊂ "反讽机器学习"）即漏召回。
 * 实测 bun:sqlite SQLite 版本 3.53.0 ≥ 3.34，支持 fts5 trigram tokenizer。
 *
 * 行为规格（经公共接口验证）：
 * 1. 建 unicode61 表 → 跑迁移 → 建表 SQL 含 trigram 且数据行数一致；
 * 2. 幂等：已是 trigram 时再次运行不重复迁移；
 * 3. 失败回退：模拟 rebuild 抛错 → 旧 unicode61 表与触发器原样保留，数据不丢；
 * 4. 迁移后：≥3 字中文子串经 FTS 召回（unicode61 漏召回场景）；<3 字短词经 LIKE 兜底腿召回；
 * 5. SQLiteMemory 构造即自动迁移（存量库升级路径）。
 */
import { describe, test, expect, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import fs from "fs";
import os from "os";
import path from "path";
import { migrateMemoryFtsToTrigram } from "../../src/memory/sqlite-memory.js";
import { SQLiteMemory } from "../../src/memory/sqlite-memory.js";
import { KnowledgeAccessLayer } from "../../src/kal/knowledge-access-layer.js";

/** 旧版（unicode61）schema 夹具 —— 与迁移前 sqlite-memory.ts initSchema 逐字段一致 */
const OLD_SCHEMA_SQL = `
  CREATE TABLE memory_notes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    path TEXT UNIQUE NOT NULL,
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    excerpt TEXT NOT NULL DEFAULT '',
    tags TEXT NOT NULL DEFAULT '[]',
    para_category TEXT NOT NULL DEFAULT 'resources',
    type TEXT NOT NULL DEFAULT 'note',
    source TEXT,
    confidence REAL NOT NULL DEFAULT 0.7,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE VIRTUAL TABLE memory_notes_fts USING fts5(
    title, content, tags,
    content=memory_notes,
    content_rowid=id,
    tokenize='unicode61'
  );
  CREATE TRIGGER memory_notes_ai AFTER INSERT ON memory_notes BEGIN
    INSERT INTO memory_notes_fts(rowid, title, content, tags)
    VALUES (new.id, new.title, new.content, new.tags);
  END;
  CREATE TRIGGER memory_notes_ad AFTER DELETE ON memory_notes BEGIN
    INSERT INTO memory_notes_fts(memory_notes_fts, rowid, title, content, tags)
    VALUES('delete', old.id, old.title, old.content, old.tags);
  END;
  CREATE TRIGGER memory_notes_au AFTER UPDATE ON memory_notes BEGIN
    INSERT INTO memory_notes_fts(memory_notes_fts, rowid, title, content, tags)
    VALUES('delete', old.id, old.title, old.content, old.tags);
    INSERT INTO memory_notes_fts(rowid, title, content, tags)
    VALUES (new.id, new.title, new.content, new.tags);
  END;
`;

function makeOldSchemaDb(): Database {
  const db = new Database(":memory:");
  db.exec(OLD_SCHEMA_SQL);
  seedNotes(db);
  return db;
}

function seedNotes(db: Database): void {
  const now = Date.now();
  const ins = db.query(
    `INSERT INTO memory_notes (path, title, content, excerpt, tags, para_category, type, confidence, created_at, updated_at)
     VALUES (?, ?, ?, ?, '[]', 'resources', 'note', 0.7, ?, ?)`,
  );
  ins.run("a.md", "反讽笔记", "反讽机器学习的实践与反思", "x", now, now);
  ins.run("b.md", "English", "distributed systems notes", "x", now, now);
}

function ftsSql(db: Database): string {
  const row = db
    .query("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'memory_notes_fts'")
    .get() as { sql: string } | undefined;
  return row?.sql ?? "";
}

function triggerCount(db: Database): number {
  return (
    db.query("SELECT COUNT(*) AS c FROM sqlite_master WHERE type = 'trigger'").get() as { c: number }
  ).c;
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fts-trigram-mig-"));

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("memory_notes_fts trigram 迁移（P1-S2 层2）", () => {
  test("unicode61 → 迁移 → 表 SQL 含 trigram 且数据行数一致、子串可召回", () => {
    const db = makeOldSchemaDb();

    // 迁移前：unicode61 子串漏召回（审计判定复现）
    const before = db.query("SELECT rowid FROM memory_notes_fts WHERE memory_notes_fts MATCH ?").all('"机器学习"');
    expect(before.length).toBe(0);

    const result = migrateMemoryFtsToTrigram(db);
    expect(result.migrated).toBe(true);

    expect(ftsSql(db)).toContain("trigram");
    const src = (db.query("SELECT COUNT(*) AS c FROM memory_notes").get() as { c: number }).c;
    const fts = (db.query("SELECT COUNT(*) AS c FROM memory_notes_fts").get() as { c: number }).c;
    expect(fts).toBe(src);
    expect(src).toBe(2);

    // 迁移后：≥3 字中文子串可召回（trigram 能力）且可 JOIN 回源表
    const after = db
      .query(
        `SELECT mn.path FROM memory_notes_fts fts JOIN memory_notes mn ON mn.id = fts.rowid
         WHERE memory_notes_fts MATCH ?`,
      )
      .all('"机器学习"') as Array<{ path: string }>;
    expect(after.map((r) => r.path)).toContain("a.md");
  });

  test("幂等：已是 trigram 时再次运行不重复迁移", () => {
    const db = makeOldSchemaDb();
    expect(migrateMemoryFtsToTrigram(db).migrated).toBe(true);
    const again = migrateMemoryFtsToTrigram(db);
    expect(again.migrated).toBe(false);
    expect(ftsSql(db)).toContain("trigram");
    expect((db.query("SELECT COUNT(*) AS c FROM memory_notes").get() as { c: number }).c).toBe(2);
  });

  test("失败回退：模拟 rebuild 抛错 → 旧表与触发器原样保留，数据不丢", () => {
    const real = makeOldSchemaDb();
    const bomb = new Proxy(real, {
      get(target, prop) {
        if (prop === "exec") {
          return (sql: string) => {
            if (/rebuild/i.test(sql)) throw new Error("simulated rebuild failure");
            return target.exec(sql);
          };
        }
        const v = Reflect.get(target, prop);
        return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      },
    });

    const result = migrateMemoryFtsToTrigram(bomb as unknown as Database);
    expect(result.migrated).toBe(false);
    expect(result.reason).toContain("回退");

    // 旧 unicode61 表与触发器原样保留
    expect(ftsSql(real)).toContain("unicode61");
    expect(ftsSql(real)).not.toContain("trigram");
    expect(triggerCount(real)).toBe(3);
    expect((real.query("SELECT COUNT(*) AS c FROM memory_notes").get() as { c: number }).c).toBe(2);
    // 旧索引仍可查（检索降级不中断）
    const rows = real.query("SELECT rowid FROM memory_notes_fts WHERE memory_notes_fts MATCH ?").all('"distributed"');
    expect(rows.length).toBe(1);
  });

  test("SQLiteMemory 构造即自动迁移存量 unicode61 库，短词经 LIKE 兜底可召回", () => {
    const dbPath = path.join(tmpDir, "legacy.db");
    {
      const db = new Database(dbPath);
      db.exec(OLD_SCHEMA_SQL);
      seedNotes(db);
      db.close();
    }
    const mem = new SQLiteMemory(dbPath);
    try {
      // 建表 SQL 已是 trigram（构造时迁移）
      const raw = new Database(dbPath);
      const sql = (raw.query("SELECT sql FROM sqlite_master WHERE type='table' AND name='memory_notes_fts'").get() as { sql: string }).sql;
      raw.close();
      expect(sql).toContain("trigram");

      // ≥3 字中文子串：unicode61 漏召回、trigram 召回
      const long = mem.search("机器学习");
      expect(long.some((r) => r.record.path === "a.md")).toBe(true);

      // <3 字短词（常见中文双字词）：MATCH 恒空，LIKE 兜底腿召回
      const short = mem.search("学习");
      expect(short.some((r) => r.record.path === "a.md")).toBe(true);

      // 英文路径不回归
      const en = mem.search("distributed");
      expect(en.some((r) => r.record.path === "b.md")).toBe(true);
    } finally {
      mem.close();
    }
  });
});

describe("KAL queryVault trigram 适配（P1-S2 层2）", () => {
  function makeTrigramVaultDb(): Database {
    const db = new Database(":memory:");
    db.exec(`
      CREATE TABLE memory_notes (
        id INTEGER PRIMARY KEY,
        path TEXT,
        title TEXT,
        content TEXT,
        tags TEXT DEFAULT '[]'
      );
      CREATE VIRTUAL TABLE memory_notes_fts USING fts5(
        title, content, tags,
        content=memory_notes,
        content_rowid=id,
        tokenize='trigram'
      );
      CREATE TRIGGER memory_notes_ai AFTER INSERT ON memory_notes BEGIN
        INSERT INTO memory_notes_fts(rowid, title, content, tags)
        VALUES (new.id, new.title, new.content, new.tags);
      END;
    `);
    db.run(`INSERT INTO memory_notes (id, path, title, content, tags) VALUES (1, 'a.md', '机器学习笔记', '反讽机器学习的实践', '[]')`);
    return db;
  }

  test("≥3 字中文子串直接 MATCH 召回（unicode61 漏召回场景）", async () => {
    const kal = new KnowledgeAccessLayer(makeTrigramVaultDb());
    const res = await kal.query({ query: "机器学习", targetStore: "vault" });
    expect(res.results.map((r) => r.metadata.path)).toContain("a.md");
  });

  test("<3 字短词 MATCH 恒空 → LIKE 兜底腿召回", async () => {
    const kal = new KnowledgeAccessLayer(makeTrigramVaultDb());
    const res = await kal.query({ query: "学习", targetStore: "vault" });
    expect(res.results.map((r) => r.metadata.path)).toContain("a.md");
  });

  test("纯短词查询不命中无关库（LIKE 兜底不虚报）", async () => {
    const kal = new KnowledgeAccessLayer(makeTrigramVaultDb());
    const res = await kal.query({ query: "神经", targetStore: "vault" });
    expect(res.results.length).toBe(0);
  });
});
