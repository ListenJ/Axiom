/**
 * W5（docs/knowledge/w5-w8-landing-form-audit-2026-08-30.md §2.3）：
 * ensureKgFts 幂等建表 + 存量回填。先建 kg_nodes（KG_SCHEMA_DDL）并手工插入
 * 3 行存量（不经 KGWriter，故无触发器同步、FTS 表也尚不存在），再调 ensureKgFts
 * 应建 kg_nodes_fts + 回填 3 行；二次调用幂等（行数不变、无报错）。
 *
 * 覆盖 D1 缺陷②③（落地形态审核 §审计红线）：FTS 表必建（不成死路径）+
 * 存量行不漏查（回填而非仅增量）。
 */
import { describe, test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { KG_SCHEMA_DDL, ensureKgFts } from "../src/kg/schema.js";

function seedNode(
  db: Database,
  id: string,
  name: string,
  description: string,
  importance: number,
) {
  db.run(
    `INSERT INTO kg_nodes (id, type, name, description, semantic, importance, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, "concept", name, description, null, importance, Date.now(), Date.now()],
  );
}

describe("W5 ensureKgFts 幂等建表 + 存量回填", () => {
  test("存量 3 行经 ensureKgFts 回填进 kg_nodes_fts", () => {
    const db = new Database(":memory:");
    // 仅建 kg_nodes（KG_SCHEMA_DDL 不含 FTS），手工插入 3 行存量
    db.exec(KG_SCHEMA_DDL);
    seedNode(db, "kg:concept:a", "Alpha", "semanticentity alpha body", 0.9);
    seedNode(db, "kg:concept:b", "Beta", "semanticentity beta body", 0.7);
    seedNode(db, "kg:concept:c", "Gamma", "semanticentity gamma body", 0.5);

    // 回填前 kg_nodes_fts 不存在
    const beforeExists = (db
      .query("SELECT name FROM sqlite_master WHERE type='table' AND name='kg_nodes_fts'")
      .get() as { name: string } | null);
    expect(beforeExists).toBeNull();

    ensureKgFts(db);

    const ftsCount = (db.query("SELECT COUNT(*) AS c FROM kg_nodes_fts").get() as { c: number }).c;
    expect(ftsCount).toBe(3);
  });

  test("二次调用 ensureKgFts 幂等（行数不变、不报错）", () => {
    const db = new Database(":memory:");
    db.exec(KG_SCHEMA_DDL);
    seedNode(db, "kg:concept:a", "Alpha", "semanticentity alpha body", 0.9);
    seedNode(db, "kg:concept:b", "Beta", "semanticentity beta body", 0.7);

    ensureKgFts(db);
    const count1 = (db.query("SELECT COUNT(*) AS c FROM kg_nodes_fts").get() as { c: number }).c;

    // 二次调用不应抛、行数不应翻倍
    expect(() => ensureKgFts(db)).not.toThrow();
    const count2 = (db.query("SELECT COUNT(*) AS c FROM kg_nodes_fts").get() as { c: number }).c;

    expect(count1).toBe(2);
    expect(count2).toBe(2);
  });

  test("FTS 部分丢失时 ensureKgFts 恢复缺失行（INSERT OR IGNORE 跳过已存在）", () => {
    const db = new Database(":memory:");
    db.exec(KG_SCHEMA_DDL);
    seedNode(db, "kg:concept:a", "Alpha", "semanticentity alpha body", 0.9);
    seedNode(db, "kg:concept:b", "Beta", "semanticentity beta body", 0.7);
    seedNode(db, "kg:concept:c", "Gamma", "semanticentity gamma body", 0.5);
    ensureKgFts(db);
    expect((db.query("SELECT COUNT(*) AS c FROM kg_nodes_fts").get() as { c: number }).c).toBe(3);

    // 模拟部分丢失（触发器漏同步 / 崩溃残留）：删一行的 FTS 索引，kg_nodes 源行仍在
    const rowid = (db.query("SELECT rowid FROM kg_nodes WHERE id = ?").get("kg:concept:b") as { rowid: number }).rowid;
    db.run("DELETE FROM kg_nodes_fts WHERE rowid = ?", [rowid]);
    expect((db.query("SELECT COUNT(*) AS c FROM kg_nodes_fts").get() as { c: number }).c).toBe(2);

    // 二次 ensureKgFts：ftsCount(2) < srcCount(3) → 回填应跳过已存在 2 行、补回缺失 1 行
    expect(() => ensureKgFts(db)).not.toThrow();
    expect((db.query("SELECT COUNT(*) AS c FROM kg_nodes_fts").get() as { c: number }).c).toBe(3);
  });
});
