/**
 * A5 后半（2026-09-21）：KAL query() 合并**语义候选**
 *
 * 覆盖（每条都对应一个可证伪的声明）：
 *  1. **未注入端口 ⇒ 与"注入空端口"逐字节一致**（改动对既有路径零影响）；
 *  2. 语义候选把**词法召不到**的条目补进结果，并标记 metadata.source === "semantic"；
 *  3. 已在词法结果中的条目 ⇒ 取 max(词法分, 余弦)，**不重复插入**；
 *  4. 候选顺序**不被信任**：同一批候选乱序注入 ⇒ 输出完全一致；
 *  5. 确定性：同输入 5 次结果逐字节一致；
 *  6. 端口抛错 ⇒ 降级纯词法、不抛、不阻断查询；
 *  7. 物化不到的 id **缺席但不崩**（不伪造、不静默当成召回成功）；
 *  8. **跨存储物化**：vault（归一化不可逆）与 dre（domain+node_id）的 nodeId 都能还原；
 *  9. 端口契约：KAL 把 limit 作为 topK 传下去、查询串原样透传（不做改写）。
 *
 * 全程离线：注入的是**假端口**，不涉及 embedding/网络/向量表。
 */
import { describe, test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { KnowledgeAccessLayer, type SemanticRecallPort } from "../src/kal/knowledge-access-layer.js";
import { createNodeId } from "../src/kal/node-id.js";
import { KGWriter } from "../src/crawl/processor/kg-writer.js";

function makeDb(): Database {
  const db = new Database(":memory:");
  new KGWriter(db); // kg_nodes + kg_nodes_fts
  db.exec(`
    CREATE TABLE memory_notes (
      id INTEGER PRIMARY KEY,
      path TEXT NOT NULL,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      tags TEXT NOT NULL DEFAULT '[]'
    );
  `);
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
  return db;
}

function seedKg(db: Database, id: string, name: string, description: string, importance = 0.5) {
  db.run(
    `INSERT INTO kg_nodes (id, type, name, description, semantic, importance, created_at, updated_at)
     VALUES (?, 'concept', ?, ?, NULL, ?, 0, 0)`,
    [id, name, description, importance],
  );
}

/** 假端口：按给定候选返回；可注入抛错 */
function port(
  candidates: Array<{ id: string; score: number }> | ((q: string, topK: number) => Array<{ id: string; score: number }>),
  opts?: { throws?: string },
): SemanticRecallPort {
  return {
    recall: async (q: string, o: { topK: number }) => {
      if (opts?.throws) throw new Error(opts.throws);
      return typeof candidates === "function" ? candidates(q, o.topK) : candidates;
    },
  };
}

describe("KAL 语义候选合并（A5 后半）", () => {
  test("1) 未注入端口 ⇒ 与注入空端口的结果逐字节一致", async () => {
    const db = makeDb();
    seedKg(db, "kg:concept:a", "Alpha", "lexical probe body", 0.9);
    seedKg(db, "kg:concept:b", "Beta", "lexical probe body", 0.4);

    const plain = new KnowledgeAccessLayer(db);
    const empty = new KnowledgeAccessLayer(db, undefined, port([]));

    const r1 = await plain.query({ query: "lexical probe", limit: 10 });
    const r2 = await empty.query({ query: "lexical probe", limit: 10 });
    expect(JSON.stringify(r2.results)).toBe(JSON.stringify(r1.results));
    expect(r1.results.length).toBe(2);
    // 词法结果**不得**被误标为语义来源
    expect(r1.results.every((r) => r.metadata.source === undefined)).toBe(true);
  });

  test("2) 词法召不到的条目由语义候选补入，且标记 source=semantic", async () => {
    const db = makeDb();
    seedKg(db, "kg:concept:a", "Alpha", "lexical probe body", 0.9);
    // 与查询串**零 token 重叠**，词法必然召不到
    seedKg(db, "kg:concept:mem", "内存只增不减", "进程常驻占用持续上升", 0.3);

    const kal = new KnowledgeAccessLayer(db, undefined, port([{ id: "kg:concept:mem", score: 0.72 }]));
    const res = await kal.query({ query: "lexical probe", limit: 10 });

    const ids = res.results.map((r) => r.nodeId);
    expect(ids).toContain("kg:concept:a");
    expect(ids).toContain("kg:concept:mem");
    const mem = res.results.find((r) => r.nodeId === "kg:concept:mem")!;
    expect(mem.metadata.source).toBe("semantic");
    expect(mem.relevance).toBeCloseTo(0.72, 5);
    expect(mem.title).toBe("内存只增不减");
  });

  test("3) 已在词法结果中的条目 ⇒ 取 max、不重复插入", async () => {
    const db = makeDb();
    seedKg(db, "kg:concept:a", "Alpha", "lexical probe body", 0.9);
    // 也命中词法，但 importance 更低 ⇒ 归一化后 relevance = 0.45/0.9 = 0.5
    seedKg(db, "kg:concept:hi", "High", "lexical probe body", 0.45);
    const target = "kg:concept:hi";

    // 余弦（0.4）低于词法分（0.5）⇒ 保持词法分；且**不重复插入**
    const low = await new KnowledgeAccessLayer(db, undefined, port([{ id: target, score: 0.4 }]))
      .query({ query: "lexical probe", limit: 10 });
    expect(low.results.length).toBe(2);
    expect(low.results.find((r) => r.nodeId === target)!.relevance).toBeCloseTo(0.5, 5);

    // 余弦（0.97）高于词法分（0.5）⇒ 取余弦
    const high = await new KnowledgeAccessLayer(db, undefined, port([{ id: target, score: 0.97 }]))
      .query({ query: "lexical probe", limit: 10 });
    expect(high.results.length).toBe(2);
    expect(high.results.find((r) => r.nodeId === target)!.relevance).toBeCloseTo(0.97, 5);
  });

  test("4) 候选顺序不被信任：乱序注入 ⇒ 结果完全一致", async () => {
    const db = makeDb();
    seedKg(db, "kg:concept:a", "Alpha", "lexical probe body", 0.9);
    seedKg(db, "kg:concept:x", "Xray", "unrelated text one", 0.2);
    seedKg(db, "kg:concept:y", "Yankee", "unrelated text two", 0.2);
    seedKg(db, "kg:concept:z", "Zulu", "unrelated text three", 0.2);

    const ordered = [
      { id: "kg:concept:z", score: 0.9 },
      { id: "kg:concept:y", score: 0.9 }, // 与 z 同分 ⇒ 必须靠 node_id 升序
      { id: "kg:concept:x", score: 0.8 },
    ];
    const shuffled = [ordered[1]!, ordered[2]!, ordered[0]!];

    const a = await new KnowledgeAccessLayer(db, undefined, port(ordered)).query({ query: "lexical probe", limit: 10 });
    const b = await new KnowledgeAccessLayer(db, undefined, port(shuffled)).query({ query: "lexical probe", limit: 10 });
    expect(b.results.map((r) => r.nodeId)).toEqual(a.results.map((r) => r.nodeId));
    expect(JSON.stringify(b.results)).toBe(JSON.stringify(a.results));
    // 同分（0.9）的两条按 node_id 升序：y 在 z 前
    const semanticIds = a.results.filter((r) => r.metadata.source === "semantic").map((r) => r.nodeId);
    expect(semanticIds).toEqual(["kg:concept:y", "kg:concept:z", "kg:concept:x"]);
  });

  test("5) 确定性：同输入 5 次结果逐字节一致", async () => {
    const db = makeDb();
    seedKg(db, "kg:concept:a", "Alpha", "lexical probe body", 0.9);
    seedKg(db, "kg:concept:x", "Xray", "unrelated text one", 0.2);
    const kal = new KnowledgeAccessLayer(db, undefined, port([{ id: "kg:concept:x", score: 0.66 }]));

    const runs: string[] = [];
    for (let i = 0; i < 5; i++) {
      runs.push(JSON.stringify((await kal.query({ query: "lexical probe", limit: 10 })).results));
    }
    for (const r of runs) expect(r).toEqual(runs[0]);
  });

  test("6) 端口抛错 ⇒ 降级纯词法，不抛错，查询仍可用", async () => {
    const db = makeDb();
    seedKg(db, "kg:concept:a", "Alpha", "lexical probe body", 0.9);
    const kal = new KnowledgeAccessLayer(db, undefined, port([], { throws: "embedding unavailable" }));
    const res = await kal.query({ query: "lexical probe", limit: 10 });
    expect(res.results.map((r) => r.nodeId)).toEqual(["kg:concept:a"]);
  });

  test("7) 物化不到的 id 缺席但不崩（不伪造节点、不静默当作召回成功）", async () => {
    const db = makeDb();
    seedKg(db, "kg:concept:a", "Alpha", "lexical probe body", 0.9);
    seedKg(db, "kg:concept:real", "Real", "unrelated one", 0.2);

    const kal = new KnowledgeAccessLayer(
      db,
      undefined,
      port([
        { id: "kg:concept:ghost", score: 0.95 }, // 库里不存在
        { id: "kg:concept:real", score: 0.7 },
      ]),
    );
    const res = await kal.query({ query: "lexical probe", limit: 10 });
    const ids = res.results.map((r) => r.nodeId);
    expect(ids).toContain("kg:concept:real");
    expect(ids).not.toContain("kg:concept:ghost");
  });

  test("8) 跨存储物化：vault 与 dre 的 nodeId 都能还原", async () => {
    const db = makeDb();
    seedKg(db, "kg:concept:a", "Alpha", "lexical probe body", 0.9);

    const vPath = "notes/内存泄漏.md";
    db.run(`INSERT INTO memory_notes (id, path, title, content, tags) VALUES (1, ?, ?, ?, ?)`, [
      vPath,
      "内存泄漏排查",
      "常驻内存持续上升，需排查引用链",
      JSON.stringify(["memory"]),
    ]);
    db.run(
      `INSERT INTO knowledge_node (node_id, title, content, domain, paradigm, confidence) VALUES (?, ?, ?, ?, ?, ?)`,
      ["kn-1", "预写日志", "先落盘再改数据以保证崩溃可恢复", "storage", "fact", 0.8],
    );

    const vaultId = createNodeId("vault", "note", vPath);
    const dreId = createNodeId("dre", "storage", "kn-1");

    const kal = new KnowledgeAccessLayer(
      db,
      undefined,
      port([
        { id: vaultId, score: 0.83 },
        { id: dreId, score: 0.71 },
      ]),
    );
    const res = await kal.query({ query: "lexical probe", limit: 10 });

    const v = res.results.find((r) => r.nodeId === vaultId);
    expect(v, "vault 候选应被物化").toBeDefined();
    expect(v!.store).toBe("vault");
    expect(v!.title).toBe("内存泄漏排查");
    expect(v!.tags).toEqual(["memory"]);
    expect(v!.relevance).toBeCloseTo(0.83, 5);

    const d = res.results.find((r) => r.nodeId === dreId);
    expect(d, "dre 候选应被物化").toBeDefined();
    expect(d!.store).toBe("dre");
    expect(d!.title).toBe("预写日志");
    expect(d!.type).toBe("fact");
    expect(d!.relevance).toBeCloseTo(0.71, 5);
  });

  test("9) 端口契约：limit 作为 topK 传下去，查询串原样透传", async () => {
    const db = makeDb();
    seedKg(db, "kg:concept:a", "Alpha", "lexical probe body", 0.9);
    const seen: Array<{ q: string; topK: number }> = [];
    const kal = new KnowledgeAccessLayer(
      db,
      undefined,
      port((q, topK) => {
        seen.push({ q, topK });
        return [];
      }),
    );
    await kal.query({ query: "lexical probe", limit: 7 });
    expect(seen).toEqual([{ q: "lexical probe", topK: 7 }]);
  });
});
