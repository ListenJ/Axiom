/**
 * A7：知识库索引语料采集（`collectKnowledgeCorpus`）
 *
 * 覆盖：
 *  1. 三表口径 — vault/dre 用 `createNodeId`，**kg 用原样 id**（审计 M14，不能二次加前缀）；
 *  2. 空文本**跳过并计数**（不产生空向量，也不静默）；
 *  3. `limitPerStore` 触顶 ⇒ `truncated=true` 且只取前 N 条（确定性取序）；
 *  4. 表缺失 ⇒ 记 `error` 且**不影响其它存储**（不抛）；
 *  5. 确定性：同库两次采集结果完全一致。
 */
import { describe, test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { collectKnowledgeCorpus } from "../../src/knowledge/kb-corpus.js";
import { createNodeId } from "../../src/kal/node-id.js";
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

describe("知识库索引语料采集（A7）", () => {
  test("1) 三表 nodeId 口径：vault/dre 用 createNodeId，kg 原样", () => {
    const db = makeDb();
    db.run(`INSERT INTO memory_notes (id, path, title, content) VALUES (1, ?, ?, ?)`, [
      "notes/pool.md",
      "连接池耗尽",
      "请求超时的根因是连接池耗尽",
    ]);
    db.run(
      `INSERT INTO kg_nodes (id, type, name, description, semantic, importance, created_at, updated_at)
       VALUES ('kg:concept:alpha', 'concept', 'Alpha', 'cascading failure body', NULL, 0.9, 0, 0)`,
    );
    db.run(`INSERT INTO knowledge_node (node_id, title, content, domain) VALUES (?, ?, ?, ?)`, [
      "kn-1",
      "预写日志",
      "先落盘再改数据",
      "storage",
    ]);

    const { nodes, perStore } = collectKnowledgeCorpus(db);
    const ids = nodes.map((n) => n.nodeId).sort();
    expect(ids).toContain(createNodeId("vault", "note", "notes/pool.md"));
    expect(ids).toContain("kg:concept:alpha"); // **不加前缀**
    expect(ids).toContain(createNodeId("dre", "storage", "kn-1"));
    expect(perStore.vault.collected).toBe(1);
    expect(perStore.kg.collected).toBe(1);
    expect(perStore.dre.collected).toBe(1);
    for (const s of ["vault", "kg", "dre"] as const) {
      expect(perStore[s].truncated).toBe(false);
      expect(perStore[s].error).toBeUndefined();
    }
    // 文本里应含标题与正文（供 embedding 使用）
    const vaultNode = nodes.find((n) => n.nodeId === createNodeId("vault", "note", "notes/pool.md"))!;
    expect(vaultNode.content).toContain("连接池耗尽");
    expect(vaultNode.content).toContain("请求超时");
    db.close();
  });

  test("2) 空文本跳过并计数（不产生空向量）", () => {
    const db = makeDb();
    db.run(`INSERT INTO memory_notes (id, path, title, content) VALUES (1, ?, '', '')`, ["blank.md"]);
    const { nodes, perStore } = collectKnowledgeCorpus(db);
    expect(nodes.length).toBe(0);
    expect(perStore.vault.skipped).toBe(1);
    expect(perStore.vault.collected).toBe(0);
    db.close();
  });

  test("3) limitPerStore 触顶 ⇒ truncated=true 且只取前 N 条", () => {
    const db = makeDb();
    for (let i = 1; i <= 5; i++) {
      db.run(`INSERT INTO memory_notes (id, path, title, content) VALUES (?, ?, ?, ?)`, [
        i,
        `n${i}.md`,
        `title${i}`,
        `body${i}`,
      ]);
    }
    const { nodes, perStore, limitPerStore } = collectKnowledgeCorpus(db, { limitPerStore: 3 });
    expect(limitPerStore).toBe(3);
    expect(perStore.vault.collected).toBe(3);
    expect(perStore.vault.truncated).toBe(true);
    // 确定性取序（ORDER BY id ASC）⇒ 取到前 3 条
    expect(nodes.map((n) => n.content.includes("body1") || n.content.includes("body2") || n.content.includes("body3"))).toEqual([
      true,
      true,
      true,
    ]);
    db.close();
  });

  test("4) 表缺失 ⇒ 记 error 且不影响其它存储（不抛）", () => {
    const db = new Database(":memory:"); // 完全没有表
    db.exec(`CREATE TABLE kg_nodes (id TEXT PRIMARY KEY, type TEXT, name TEXT, description TEXT, semantic TEXT, importance REAL, created_at INTEGER, updated_at INTEGER);`);
    db.run(
      `INSERT INTO kg_nodes (id, type, name, description, semantic, importance, created_at, updated_at)
       VALUES ('kg:concept:only', 'concept', 'Only', 'still collected', NULL, 0.5, 0, 0)`,
    );
    const { nodes, perStore } = collectKnowledgeCorpus(db);
    expect(perStore.vault.error).toBeTruthy();
    expect(perStore.dre.error).toBeTruthy();
    expect(perStore.kg.error).toBeUndefined();
    expect(nodes.map((n) => n.nodeId)).toEqual(["kg:concept:only"]);
    db.close();
  });

  test("5) 确定性：同库两次采集结果完全一致", () => {
    const db = makeDb();
    for (let i = 1; i <= 3; i++) {
      db.run(`INSERT INTO memory_notes (id, path, title, content) VALUES (?, ?, ?, ?)`, [
        i,
        `n${i}.md`,
        `t${i}`,
        `b${i}`,
      ]);
    }
    const a = JSON.stringify(collectKnowledgeCorpus(db).nodes);
    const b = JSON.stringify(collectKnowledgeCorpus(db).nodes);
    expect(b).toBe(a);
    db.close();
  });
});
