/**
 * P0-3 例行化：SQLite 空闲页阈值告警（health-checker.checkSqliteFreelist）
 *
 * 判定依据是页计数（PRAGMA page_count / freelist_count），不是消息措辞：
 * 用例自己复算占比并要求它真的超过阈值，避免"告警消息对了但库其实不脏"的假绿。
 * 全部在临时库上做，不触碰 data/agent.db（DATABASE_PATH 不参与本用例）。
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { checkSqliteFreelist, DB_FREELIST_WARN_RATIO } from "../../src/core/health-checker.js";

let dir: string;
let dbPath: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "db-freelist-"));
  dbPath = path.join(dir, "probe.db");
});

afterEach(() => {
  try { rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
});

describe("SQLite 空闲页检查（P0-3 VACUUM 例行化）", () => {
  test("空闲页占比超阈值 ⇒ warning 且给出 VACUUM 修复建议（占比由用例复算）", async () => {
    const db = new Database(dbPath);
    db.run("CREATE TABLE t (id INTEGER PRIMARY KEY, blob BLOB)");
    const ins = db.prepare("INSERT INTO t (blob) VALUES (?)");
    for (let i = 0; i < 300; i++) ins.run(Buffer.alloc(8192, i % 251));
    db.run("DELETE FROM t");
    db.close();

    const r = await checkSqliteFreelist(dbPath);
    expect(r).not.toBeNull();
    expect(r!.component).toBe("SQLite 空闲页");
    expect(r!.status).toBe("warning");
    expect(r!.fix).toContain("VACUUM");

    // 独立复算：占比确实 > 阈值（否则本用例是假绿）
    const db2 = new Database(dbPath);
    const pageCount = Number((db2.query("PRAGMA page_count").get() as { page_count: number }).page_count);
    const freelistCount = Number((db2.query("PRAGMA freelist_count").get() as { freelist_count: number }).freelist_count);
    db2.close();
    expect(pageCount).toBeGreaterThan(0);
    expect(freelistCount / pageCount).toBeGreaterThan(DB_FREELIST_WARN_RATIO);
  });

  test("空闲页占比低 ⇒ ok", async () => {
    const db = new Database(dbPath);
    db.run("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");
    db.run("INSERT INTO t (v) VALUES ('a'), ('b')");
    db.close();

    const r = await checkSqliteFreelist(dbPath);
    expect(r).not.toBeNull();
    expect(r!.status).toBe("ok");
    expect(r!.message).toContain("空闲页占比");
  });

  test("库文件不存在 ⇒ null（不抛；由 checkDatabase 既有分支兜底）", async () => {
    const r = await checkSqliteFreelist(path.join(dir, "missing.db"));
    expect(r).toBeNull();
  });
});
