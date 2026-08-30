/**
 * W5（docs/knowledge/w5-w8-landing-form-audit-2026-08-30.md §2）：
 * queryKG 走 kg_nodes_fts（fts5 trigram 独立表 + rowid 触发器）FTS5 MATCH 主腿 +
 * <3 字 CJK LIKE 兜底腿，排序恒为 importance DESC, id ASC（保 M1/M3 红线）。
 *
 * 覆盖：
 * 1. FTS 主腿：>=3 字词命中，返回全部匹配行且按 importance DESC, id ASC 排序。
 * 2. LIKE 兜底腿：<3 字 CJK 短词（trigram MATCH 恒空）经 LIKE 命中。
 */
import { describe, test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { KnowledgeAccessLayer } from "../src/kal/knowledge-access-layer.js";
import { KGWriter } from "../src/crawl/processor/kg-writer.js";

function makeDb(): Database {
  const db = new Database(":memory:");
  new KGWriter(db); // 建 kg_nodes + kg_nodes_fts（ensureKgFts 回填）
  return db;
}

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

describe("W5 queryKG FTS5 trigram 主腿 + LIKE 兜底腿", () => {
  test("FTS 主腿：>=3 字词命中全部匹配行，且按 importance DESC, id ASC 排序", async () => {
    const db = makeDb();
    // 非字典序 + 非 importance 序插入：zeta(0.9) → alpha(0.9) → mid(0.7)
    seedNode(db, "kg:concept:zeta", "Zeta", "semanticentity zeta body", 0.9);
    seedNode(db, "kg:concept:alpha", "Alpha", "semanticentity alpha body", 0.9);
    seedNode(db, "kg:concept:mid", "Mid", "semanticentity mid body", 0.7);

    const kal = new KnowledgeAccessLayer(db);
    const res = await kal.query({ query: "semanticentity", targetStore: "kg", limit: 10 });

    expect(res.results.length).toBe(3);
    // importance 0.9 两行按 id ASC：alpha 在 zeta 前；0.7 的 mid 最后
    expect(res.results.map((r) => r.metadata.id as string)).toEqual([
      "kg:concept:alpha",
      "kg:concept:zeta",
      "kg:concept:mid",
    ]);
  });

  test("LIKE 兜底腿：<3 字 CJK 短词经 LIKE 命中（trigram MATCH 恒空）", async () => {
    const db = makeDb();
    seedNode(db, "kg:concept:graphtheory", "图谱理论", "含 图谱 二字的节点", 0.8);
    seedNode(db, "kg:concept:other", "其他", "不含目标词", 0.8);

    const kal = new KnowledgeAccessLayer(db);
    const res = await kal.query({ query: "图谱", targetStore: "kg", limit: 10 });

    expect(res.results.length).toBe(1);
    expect(res.results[0].metadata.id).toBe("kg:concept:graphtheory");
  });
});
