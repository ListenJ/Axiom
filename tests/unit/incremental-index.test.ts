/**
 * A7 后半：**增量**索引（新入库文档 → 向量）
 *
 * 关键覆盖：
 *  1. 门控**先于读库**：未授权 / 无路由时**连数据库都不碰** —— 用**已关闭的 Database 句柄**做可证伪探针
 *     （真去读会抛错 ⇒ 被 catch 进 `error`；断言 `error` 为空即证明没碰库）；
 *  2. 只索引**还没向量**的节点（已索引的不重复调模型）；
 *  3. 幂等：第二次跑 ⇒ `skipped="nothing-to-index"` 且零调用；
 *  4. 失败不抛（embedder 返回空/维度不符 ⇒ `failed` 计数）；
 *  5. 语料不完整（表缺失 / 触顶）⇒ `corpusIssues` 显式上报；
 *  6. `selectUnindexedNodes` 是保序纯函数。
 */
import { describe, test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import {
  loadIndexedNodeIds,
  runIncrementalIndex,
  selectUnindexedNodes,
  type IncrementalIndexDeps,
} from "../../src/knowledge/incremental-index.js";
import { indexNodeEmbeddings } from "../../src/knowledge/semantic-index.js";
import { KGWriter } from "../../src/crawl/processor/kg-writer.js";

const MODEL = "probe/embed-model";

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

function seedNotes(db: Database, n: number) {
  for (let i = 1; i <= n; i++) {
    db.run(`INSERT INTO memory_notes (id, path, title, content) VALUES (?, ?, ?, ?)`, [
      i,
      `n${i}.md`,
      `title${i}`,
      `body${i}`,
    ]);
  }
}

/** 计数版假 embedder（确定性、无网络） */
function countingEmbedder(counter: { calls: number }, dims = 3) {
  return async (texts: string[]): Promise<number[][]> => {
    counter.calls += 1;
    return texts.map(() => new Array<number>(dims).fill(0).map((_, i) => (i + 1) / dims));
  };
}

function deps(over: Partial<IncrementalIndexDeps> = {}): IncrementalIndexDeps {
  const counter = { calls: 0 };
  return {
    embeddings: countingEmbedder(counter),
    resolveModelTag: () => MODEL,
    consent: () => "yes",
    now: 1,
    ...over,
  };
}

describe("增量索引（A7 后半）", () => {
  test("1) 未授权 ⇒ 不读库、不调模型（用已关闭句柄做可证伪探针）", async () => {
    const closed = new Database(":memory:");
    closed.close(); // 任何真实读库都会抛错
    const counter = { calls: 0 };
    const report = await runIncrementalIndex(closed, {
      embeddings: countingEmbedder(counter),
      resolveModelTag: () => MODEL,
      consent: () => "ask",
      now: 1,
    });
    expect(report.skipped).toBe("not-authorized");
    expect(report.error).toBeUndefined(); // 没碰库 ⇒ 没有 "database is closed" 之类的错误
    expect(report.corpusSize).toBe(0);
    expect(counter.calls).toBe(0);
  });

  test("2) 无 embedding 路由 ⇒ 同样不读库、不调模型", async () => {
    const closed = new Database(":memory:");
    closed.close();
    const counter = { calls: 0 };
    const report = await runIncrementalIndex(closed, {
      embeddings: countingEmbedder(counter),
      resolveModelTag: () => null,
      consent: () => "yes",
      now: 1,
    });
    expect(report.skipped).toBe("no-route");
    expect(report.model).toBeNull();
    expect(report.error).toBeUndefined();
    expect(counter.calls).toBe(0);
  });

  test("3) 已授权 ⇒ 只索引没有向量的节点；再跑一次幂等", async () => {
    const db = makeDb();
    seedNotes(db, 3);
    const counter = { calls: 0 };
    const first = await runIncrementalIndex(db, deps({ embeddings: countingEmbedder(counter) }));
    expect(first.corpusSize).toBe(3);
    expect(first.attempted).toBe(3);
    expect(first.indexed).toBe(3);
    expect(first.failed).toBe(0);
    expect(first.dim).toBe(3);
    expect(first.skipped).toBeUndefined();
    expect(counter.calls).toBe(1); // 一次批量调用

    // 第二次：全部已有向量 ⇒ 不调模型
    const counter2 = { calls: 0 };
    const second = await runIncrementalIndex(db, deps({ embeddings: countingEmbedder(counter2) }));
    expect(second.skipped).toBe("nothing-to-index");
    expect(second.alreadyIndexed).toBe(3);
    expect(second.attempted).toBe(0);
    expect(counter2.calls).toBe(0);
    db.close();
  });

  test("4) 部分已索引 ⇒ 只补缺口（attempted 等于缺口数）", async () => {
    const db = makeDb();
    seedNotes(db, 3);
    // 只给第 1 条预先建向量
    const vec = countingEmbedder({ calls: 0 });
    await indexNodeEmbeddings(
      { db, embedder: vec, model: MODEL, now: 1 },
      [{ nodeId: (await import("../../src/kal/node-id.js")).createNodeId("vault", "note", "n1.md"), content: "title1 body1" }],
    );
    expect(loadIndexedNodeIds(db, MODEL).size).toBe(1);

    const report = await runIncrementalIndex(db, deps());
    expect(report.corpusSize).toBe(3);
    expect(report.alreadyIndexed).toBe(1);
    expect(report.attempted).toBe(2);
    expect(report.indexed).toBe(2);
    db.close();
  });

  test("5) embedder 返回空 ⇒ failed 计数、不抛错", async () => {
    const db = makeDb();
    seedNotes(db, 2);
    const report = await runIncrementalIndex(
      db,
      deps({ embeddings: async () => [] }),
    );
    expect(report.indexed).toBe(0);
    expect(report.failed).toBe(2);
    expect(report.error).toBeUndefined();
    db.close();
  });

  test("6) 语料不完整：表缺失与触顶都进 corpusIssues（不静默）", async () => {
    // (a) 只有 kg 表 ⇒ vault/dre 记 error
    const bare = new Database(":memory:");
    bare.exec(`CREATE TABLE kg_nodes (id TEXT PRIMARY KEY, type TEXT, name TEXT, description TEXT, semantic TEXT, importance REAL, created_at INTEGER, updated_at INTEGER);`);
    bare.run(
      `INSERT INTO kg_nodes (id, type, name, description, semantic, importance, created_at, updated_at)
       VALUES ('kg:concept:a', 'concept', 'A', 'body a', NULL, 0.5, 0, 0)`,
    );
    const r1 = await runIncrementalIndex(bare, deps());
    expect(r1.corpusIssues.some((i) => i.startsWith("vault:error:"))).toBe(true);
    expect(r1.corpusIssues.some((i) => i.startsWith("dre:error:"))).toBe(true);
    expect(r1.indexed).toBe(1);
    bare.close();

    // (b) 触顶 ⇒ vault:truncated
    const db = makeDb();
    seedNotes(db, 3);
    const r2 = await runIncrementalIndex(db, deps({ limitPerStore: 1 }));
    expect(r2.corpusIssues).toContain("vault:truncated");
    expect(r2.corpusSize).toBe(1);
    db.close();
  });

  test("7) selectUnindexedNodes 是保序纯函数", () => {
    const nodes = [
      { nodeId: "c", content: "C" },
      { nodeId: "a", content: "A" },
      { nodeId: "b", content: "B" },
    ];
    const out = selectUnindexedNodes(nodes, new Set(["a"]));
    expect(out.map((n) => n.nodeId)).toEqual(["c", "b"]); // 保输入序，不排序
    expect(nodes.length).toBe(3); // 不修改入参
  });

  test("8) 读已索引集合：表不存在 ⇒ 空集合（不抛）", () => {
    const db = new Database(":memory:");
    expect(loadIndexedNodeIds(db, MODEL).size).toBe(0);
    db.close();
  });
});
