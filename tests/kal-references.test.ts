/**
 * kal_references 跨存储引用（KG 出入边 UNION）
 *
 * 验证 KAL.getReferences 通过 kg_edges 的 source/target 双向查找，
 * 并对返回的 node_id 做正确归一化（不重复前缀）。
 *
 * 注：计划 Task 3.3 提及的 wiki_links 表在本仓库 SQLite 中并不存在
 * （Vault wiki-link 图由 DeterministicSearchEngine 在内存中从 .md 文件构建），
 * 故本测试只覆盖可在 this.db 中可靠验证的 KG 出入边 UNION 部分。
 */
import { describe, test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { KnowledgeAccessLayer } from "../src/kal/knowledge-access-layer.js";
import { KGWriter } from "../src/crawl/processor/kg-writer.js";

function makeDb(): Database {
  const db = new Database(":memory:");
  new KGWriter(db); // 确保 kg_nodes / kg_edges 表存在
  return db;
}

function seedNode(db: Database, id: string, type: string, name: string, description = "") {
  db.run(
    `INSERT INTO kg_nodes (id, type, name, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
    [id, type, name, description, Date.now(), Date.now()],
  );
}

function seedEdge(db: Database, id: string, source: string, target: string, type = "references") {
  db.run(
    `INSERT INTO kg_edges (id, source, target, type, weight, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
    [id, source, target, type, 1.0, Date.now()],
  );
}

describe("KnowledgeAccessLayer.getReferences", () => {
  test("RED: 出边 —— 查找节点的下游引用", async () => {
    const db = makeDb();
    seedNode(db, "kg:function:A", "function", "A");
    seedNode(db, "kg:function:B", "function", "B");
    seedEdge(db, "e1", "kg:function:A", "kg:function:B", "calls");

    const kal = new KnowledgeAccessLayer(db);
    const refs = await kal.getReferences("kg:function:A");

    expect(refs.length).toBe(1);
    expect(refs[0].nodeId).toBe("kg:function:B"); // 不重复前缀
    expect(refs[0].title).toBe("B");
    expect(refs[0].metadata.edgeType).toBe("calls");
  });

  test("RED: 入边 —— 查找节点的上游引用", async () => {
    const db = makeDb();
    seedNode(db, "kg:function:A", "function", "A");
    seedNode(db, "kg:function:B", "function", "B");
    seedEdge(db, "e1", "kg:function:A", "kg:function:B", "calls");

    const kal = new KnowledgeAccessLayer(db);
    const refs = await kal.getReferences("kg:function:B");

    expect(refs.length).toBe(1);
    expect(refs[0].nodeId).toBe("kg:function:A");
  });

  test("RED: 出入边 UNION —— 中间节点双向聚合", async () => {
    const db = makeDb();
    seedNode(db, "kg:function:A", "function", "A");
    seedNode(db, "kg:function:M", "function", "M");
    seedNode(db, "kg:function:B", "function", "B");
    seedEdge(db, "e1", "kg:function:A", "kg:function:M", "calls");
    seedEdge(db, "e2", "kg:function:M", "kg:function:B", "calls");

    const kal = new KnowledgeAccessLayer(db);
    const refs = await kal.getReferences("kg:function:M");

    const ids = refs.map((r) => r.nodeId).sort();
    expect(ids).toEqual(["kg:function:A", "kg:function:B"]);
  });

  test("RED: 非法 node_id 返回空（复用 node-id.ts parseNodeId）", async () => {
    const db = makeDb();
    const kal = new KnowledgeAccessLayer(db);
    expect(await kal.getReferences("not-a-node-id")).toEqual([]);
    expect(await kal.getReferences("")).toEqual([]);
  });
});
