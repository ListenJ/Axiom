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

  test("P1-T2/O3-F2: vault 节点入链——query 往返建立映射后经原始路径反查", async () => {
    const db = makeVaultDb();
    const kal = new KnowledgeAccessLayer(db, {
      getWikiBacklinks: (p) => (p === "a.md" ? [{ path: "b.md", title: "B" }] : []),
    });
    // 先经 query 建立 nodeId->原始路径 映射，再做 createNodeId 往返
    const seeded = await seedVaultNote(db, "a.md", "anchor lookup text");
    const q = await kal.query({ query: "anchor", targetStore: "vault" });
    expect(q.results.map((r) => r.nodeId)).toContain(seeded);
    const refs = await kal.getReferences(seeded);
    const hit = refs.find((r) => r.store === "vault");
    expect(hit?.metadata.sourcePath).toBe("b.md");
    expect(hit?.title).toBe("B");
    expect(hit?.metadata.referencedBy).toBe(seeded);
  });

  test("P1-T2: 未注入 vault 适配器时保持旧行为(仅 KG 边)", async () => {
    const db = makeDb();
    const kal = new KnowledgeAccessLayer(db);
    expect(await kal.getReferences("vault:note:a.md")).toEqual([]);
  });

  test("O3-F2: 未经过 query 建立映射时 vault 入链保守降级为空", async () => {
    const db = makeDb();
    const kal = new KnowledgeAccessLayer(db, {
      getWikiBacklinks: () => [{ path: "b.md", title: "B" }],
    });
    // 归一化 ID 无法逆向还原原始路径；无映射时不猜测、不误查
    expect(await kal.getReferences("vault:note:a.md")).toEqual([]);
  });
});

// ========== 审计整改 O3（F1/F2/F4/F5） ==========

/** 构建带 vault FTS schema 的内存库（对齐 sqlite-memory.ts 的 external-content 结构） */
function makeVaultDb(): Database {
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
      content_rowid=id
    );
    CREATE TRIGGER memory_notes_ai AFTER INSERT ON memory_notes BEGIN
      INSERT INTO memory_notes_fts(rowid, title, content, tags)
      VALUES (new.id, new.title, new.content, new.tags);
    END;
  `);
  return db;
}

function seedNote(db: Database, id: number, path: string, title: string, content: string, tags: string): string {
  db.run(
    `INSERT INTO memory_notes (id, path, title, content, tags) VALUES (?, ?, ?, ?, ?)`,
    [id, path, title, content, tags],
  );
  return `vault:note:${path}`;
}

async function seedVaultNote(db: Database, path: string, content: string): Promise<string> {
  const { createNodeId } = await import("../src/kal/node-id.js");
  seedNote(db, 1, path, path, content, "[]");
  return createNodeId("vault", "note", path);
}

describe("O3-F1: queryVault tagFilter 包含判定过滤", () => {
  test("tagFilter=['z'] 只保留命中全部标签的笔记", async () => {
    const db = makeVaultDb();
    seedNote(db, 1, "a.md", "Alpha", "alpha doc body", JSON.stringify(["x"]));
    seedNote(db, 2, "b.md", "Beta", "beta doc body", JSON.stringify(["y", "z"]));
    const kal = new KnowledgeAccessLayer(db);

    const res = await kal.query({ query: "doc", targetStore: "vault", tagFilter: ["z"] });

    expect(res.results.length).toBe(1);
    expect(res.results[0].tags).toContain("z");
  });

  test("多标签 AND 语义：缺任一标签即排除", async () => {
    const db = makeVaultDb();
    seedNote(db, 1, "c.md", "Gamma", "gamma doc body", JSON.stringify(["m"]));
    seedNote(db, 2, "d.md", "Delta", "delta doc body", JSON.stringify(["m", "n"]));
    const kal = new KnowledgeAccessLayer(db);

    const res = await kal.query({ query: "doc", targetStore: "vault", tagFilter: ["m", "n"] });

    expect(res.results.length).toBe(1);
    expect(res.results[0].metadata.path).toBe("d.md");
  });
});

describe("O3-F2: 真实 .md 路径 createNodeId 往返入链可查", () => {
  test("含空格与点的路径反查出原始路径并调 getWikiBacklinks", async () => {
    const db = makeVaultDb();
    seedNote(db, 1, "notes/real note.md", "Real", "unique token body", "[]");
    const calls: string[] = [];
    const kal = new KnowledgeAccessLayer(db, {
      getWikiBacklinks: (p) => {
        calls.push(p);
        return [{ path: "other.md", title: "Other" }];
      },
    });

    const q = await kal.query({ query: "token", targetStore: "vault" });
    expect(q.results.length).toBe(1);
    const nodeId = q.results[0].nodeId;

    const refs = await kal.getReferences(nodeId);
    expect(calls).toEqual(["notes/real note.md"]); // 反查原始路径而非归一化 ID
    const hit = refs.find((r) => r.store === "vault");
    expect(hit?.metadata.sourcePath).toBe("other.md");
  });
});

describe("O3-F4: kg_edge 单数表边可见", () => {
  test("单数表存在时 getReferences 可见其边", async () => {
    const db = makeDb();
    seedNode(db, "kg:function:S", "function", "S");
    seedNode(db, "kg:function:T", "function", "T");
    db.exec(
      `CREATE TABLE kg_edge (src_node TEXT NOT NULL, dst_node TEXT NOT NULL, relation TEXT NOT NULL)`,
    );
    db.run(`INSERT INTO kg_edge (src_node, dst_node, relation) VALUES (?, ?, ?)`, [
      "kg:function:S",
      "kg:function:T",
      "calls",
    ]);

    const kal = new KnowledgeAccessLayer(db);
    const refs = await kal.getReferences("kg:function:T");
    expect(refs.some((r) => r.nodeId === "kg:function:S")).toBe(true);
  });

  test("双表并存时两腿均可见", async () => {
    const db = makeDb();
    seedNode(db, "kg:function:A", "function", "A");
    seedNode(db, "kg:function:M", "function", "M");
    seedNode(db, "kg:function:B", "function", "B");
    seedEdge(db, "e1", "kg:function:A", "kg:function:M", "calls"); // 复数表
    db.exec(
      `CREATE TABLE kg_edge (src_node TEXT NOT NULL, dst_node TEXT NOT NULL, relation TEXT NOT NULL)`,
    );
    db.run(`INSERT INTO kg_edge (src_node, dst_node, relation) VALUES (?, ?, ?)`, [
      "kg:function:B",
      "kg:function:M",
      "related",
    ]); // 单数表

    const kal = new KnowledgeAccessLayer(db);
    const refs = await kal.getReferences("kg:function:M");
    const ids = refs.map((r) => r.nodeId).sort();
    expect(ids).toEqual(["kg:function:A", "kg:function:B"]);
  });

  test("仅有复数表时旧行为不变（UNION 失败回退不破坏既有结果）", async () => {
    const db = makeDb();
    seedNode(db, "kg:function:A", "function", "A");
    seedNode(db, "kg:function:B", "function", "B");
    seedEdge(db, "e1", "kg:function:A", "kg:function:B", "calls");

    const kal = new KnowledgeAccessLayer(db);
    const refs = await kal.getReferences("kg:function:A");
    expect(refs.length).toBe(1);
    expect(refs[0].nodeId).toBe("kg:function:B");
  });
});

describe("O3-F5: 分库 maxScore 归一化", () => {
  test("vault 恒 0.8 归一化后不再被 kg 高分无条件压制", async () => {
    const db = makeVaultDb();
    new KGWriter(db); // 确保 kg_nodes 存在
    seedNote(db, 1, "v.md", "V", "shared keyword alpha", "[]");
    db.run(
      `INSERT INTO kg_nodes (id, type, name, description, semantic, importance, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ["kg:concept:k1", "concept", "KV", "shared keyword alpha", null, 0.95, Date.now(), Date.now()],
    );
    const kal = new KnowledgeAccessLayer(db);

    const res = await kal.query({ query: "shared keyword alpha" });

    expect(res.storesQueried).toContain("vault");
    expect(res.storesQueried).toContain("kg");
    // 归一化后各库最高分均为 1.0，稳定排序下先查询的 vault 在前
    expect(res.results[0].store).toBe("vault");
    expect(res.results[0].relevance).toBeCloseTo(1, 5);
  });
});
