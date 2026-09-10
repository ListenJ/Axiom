// @smoke
/**
 * 审计 M1（docs/reviews/2026-08-28-independent-full-audit.md 2.2）：KAL queryKG/queryDRE
 * ORDER BY importance DESC / confidence DESC 无次级键——同分时返回顺序取决于
 * SQLite 扫描序（= 插入序），跨环境不稳定。
 *
 * 修复：追加主键次级键 `importance DESC, id ASC` / `confidence DESC, node_id ASC`。
 * 复现：按非字典序插入同分节点（zeta 先、alpha 后），修复前 zeta 先返回。
 */
import { describe, test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { KnowledgeAccessLayer } from "../src/kal/knowledge-access-layer.js";
import { KGWriter } from "../src/crawl/processor/kg-writer.js";

describe("KAL queryKG/queryDRE 同分次级键（审计 M1）", () => {
  test("queryKG：同 importance 的 kg_nodes 按 id 字典序返回（3 次重复）", async () => {
    const db = new Database(":memory:");
    new KGWriter(db); // 确保 kg_nodes 表存在（importance 无索引，旧行为随插入序）
    const seed = (id: string) =>
      db.run(
        `INSERT INTO kg_nodes (id, type, name, description, semantic, importance, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, "concept", id, "determinism probe body", null, 0.5, Date.now(), Date.now()],
      );
    // 故意非字典序插入：zeta → alpha → mid
    seed("kg:concept:zeta");
    seed("kg:concept:alpha");
    seed("kg:concept:mid");

    const kal = new KnowledgeAccessLayer(db);
    const orders: string[][] = [];
    for (let i = 0; i < 3; i++) {
      const res = await kal.query({ query: "determinism probe", targetStore: "kg", limit: 10 });
      expect(res.results.length).toBe(3);
      orders.push(res.results.map((r) => r.metadata.id as string));
    }
    // 跨查询顺序一致，且按 id 字典序（与插入序相反）
    expect(new Set(orders.map((o) => o.join("|"))).size).toBe(1);
    expect(orders[0]).toEqual(["kg:concept:alpha", "kg:concept:mid", "kg:concept:zeta"]);
  });

  test("queryDRE：同 confidence 的 knowledge_node 按 node_id 字典序返回", async () => {
    const db = new Database(":memory:");
    db.exec(`
      CREATE TABLE knowledge_node (
        node_id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        content_hash TEXT NOT NULL DEFAULT '',
        domain TEXT NOT NULL DEFAULT 'test',
        paradigm TEXT NOT NULL DEFAULT 'fact',
        confidence REAL NOT NULL DEFAULT 0.5,
        source_type TEXT NOT NULL DEFAULT 'test',
        created_at INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL DEFAULT 0
      );
    `);
    // 故意非字典序插入：z 在前、a 在后（同 confidence 时旧行为随插入序）
    db.run(`INSERT INTO knowledge_node (node_id, title, content, confidence) VALUES (?, ?, ?, ?)`, [
      "dre:test:z",
      "Z",
      "determinism probe body",
      0.7,
    ]);
    db.run(`INSERT INTO knowledge_node (node_id, title, content, confidence) VALUES (?, ?, ?, ?)`, [
      "dre:test:a",
      "A",
      "determinism probe body",
      0.7,
    ]);

    const kal = new KnowledgeAccessLayer(db);
    const res = await kal.query({ query: "determinism probe", targetStore: "dre", limit: 10 });
    expect(res.results.length).toBe(2);
    expect(res.results.map((r) => r.metadata.id)).toEqual(["dre:test:a", "dre:test:z"]);
  });
});
