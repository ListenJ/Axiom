/**
 * **漂移守卫**：索引语料的 nodeId ↔ KAL 的 nodeId 必须能往返
 *
 * 为什么必须有这条：写入腿（`collectKnowledgeCorpus`）与读取腿（`KnowledgeAccessLayer`
 * 的查询 / 物化）**各自**计算 nodeId。两边口径一旦不一致，症状是**最恶心的一种**：
 * 表里明明有向量、`recallBySimilarity` 也返回了候选，但 KAL 物化不出来 ⇒ **召回恒空且不报错**。
 *
 * 断言方式：把语料采集出的 id 原样当作"语义候选"喂给 KAL，
 * 断言**每一个都能被物化**（否则说明 id 口径漂移）。
 */
import { describe, test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { collectKnowledgeCorpus } from "../../src/knowledge/kb-corpus.js";
import { KnowledgeAccessLayer, type SemanticRecallPort } from "../../src/kal/knowledge-access-layer.js";
import { KGWriter } from "../../src/crawl/processor/kg-writer.js";

function makeDb(): Database {
  const db = new Database(":memory:");
  new KGWriter(db);
  db.exec(`
    CREATE TABLE memory_notes (
      id INTEGER PRIMARY KEY, path TEXT NOT NULL, title TEXT NOT NULL,
      content TEXT NOT NULL, tags TEXT NOT NULL DEFAULT '[]'
    );
    CREATE TABLE knowledge_node (
      node_id TEXT PRIMARY KEY, title TEXT NOT NULL, content TEXT NOT NULL,
      content_hash TEXT NOT NULL DEFAULT '', domain TEXT NOT NULL DEFAULT 'test',
      paradigm TEXT NOT NULL DEFAULT 'fact', confidence REAL NOT NULL DEFAULT 0.5,
      source_type TEXT NOT NULL DEFAULT 'test', created_at INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL DEFAULT 0
    );
  `);
  return db;
}

describe("语料 id ↔ KAL id 往返守卫", () => {
  test("三个存储采集出的每个 id 都能被 KAL 物化", async () => {
    const db = makeDb();
    // 故意用含 CJK / 空格 / 斜杠的路径（归一化最易出分歧的输入）
    db.run(`INSERT INTO memory_notes (id, path, title, content, tags) VALUES (1, ?, ?, ?, ?)`, [
      "notes/内存 泄漏 排查.md",
      "内存泄漏排查",
      "常驻内存持续上升",
      JSON.stringify(["memory"]),
    ]);
    db.run(
      `INSERT INTO kg_nodes (id, type, name, description, semantic, importance, created_at, updated_at)
       VALUES ('kg:concept:中文节点', 'concept', '中文节点', '正文', NULL, 0.6, 0, 0)`,
    );
    db.run(`INSERT INTO knowledge_node (node_id, title, content, domain) VALUES (?, ?, ?, ?)`, [
      "kn-中文-1",
      "预写日志",
      "先落盘再改数据",
      "存储 域",
    ]);

    const corpus = collectKnowledgeCorpus(db);
    expect(corpus.nodes.length).toBe(3);

    // 把语料 id 全部当候选喂给 KAL（查询串与内容无关，保证它们**不是**词法召回的）
    const allIds = corpus.nodes.map((n) => n.nodeId);
    const port: SemanticRecallPort = {
      recall: async () => allIds.map((id, i) => ({ id, score: 0.8 - i * 0.01 })),
    };
    const kal = new KnowledgeAccessLayer(db, undefined, port);
    const res = await kal.query({ query: "zzz-nothing-matches-zzz", targetStore: "kg", limit: 20 });

    const got = new Set(res.results.map((r) => r.nodeId));
    const missing = allIds.filter((id) => !got.has(id));
    if (missing.length > 0) console.error("无法物化的语料 id：", missing);
    expect(missing).toEqual([]);
    // 三个存储都应出现（证明跨存储物化不是只对 kg 生效）
    expect(new Set(res.results.map((r) => r.store))).toEqual(new Set(["vault", "kg", "dre"]));
    db.close();
  });
});
