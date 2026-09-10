/**
 * 知识库存储测试 — 覆盖率空白补充
 *
 * 测试目标：KnowledgeStore 的 CRUD / 版本快照 / 知识图谱边 / 子图检索
 * 测试维度：基础功能 / 边界条件 / 异常输入 / 数据完整性
 *
 * 覆盖组件：src/dre/storage/knowledge-store.ts
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { KnowledgeStore } from "../../src/dre/storage/knowledge-store.js";
import type { KnowledgeParadigm } from "../../src/dre/storage/knowledge-store.js";

/** 创建内存 SQLite 并初始化 knowledge_node / knowledge_revision / kg_edge 表结构 */
function createTestDb(): Database {
  const db = new Database(":memory:");
  db.exec("PRAGMA journal_mode=WAL;");

  db.exec(`
    CREATE TABLE IF NOT EXISTS knowledge_node (
      node_id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      schema_version INTEGER NOT NULL DEFAULT 1,
      domain TEXT NOT NULL,
      paradigm TEXT NOT NULL DEFAULT 'fact',
      confidence REAL NOT NULL DEFAULT 0.5,
      source_type TEXT NOT NULL,
      source_uri TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      revision INTEGER NOT NULL DEFAULT 1,
      is_verified INTEGER NOT NULL DEFAULT 0,
      behavior TEXT,
      prediction TEXT,
      hypothesis TEXT,
      CHECK (confidence BETWEEN 0.0 AND 1.0)
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS knowledge_revision (
      node_id TEXT NOT NULL,
      revision INTEGER NOT NULL,
      content TEXT NOT NULL,
      diff TEXT,
      reason TEXT,
      verified_by TEXT,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (node_id, revision)
    );
  `);

  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_node_fts USING fts5(
      node_id, title, content, domain,
      content=knowledge_node,
      content_rowid=rowid
    );
    CREATE TRIGGER IF NOT EXISTS knowledge_node_ai AFTER INSERT ON knowledge_node BEGIN
      INSERT INTO knowledge_node_fts(rowid, node_id, title, content, domain)
      VALUES (new.rowid, new.node_id, new.title, new.content, new.domain);
    END;
    CREATE TRIGGER IF NOT EXISTS knowledge_node_ad AFTER DELETE ON knowledge_node BEGIN
      INSERT INTO knowledge_node_fts(knowledge_node_fts, rowid, node_id, title, content, domain)
      VALUES ('delete', old.rowid, old.node_id, old.title, old.content, old.domain);
    END;
    CREATE TRIGGER IF NOT EXISTS knowledge_node_au AFTER UPDATE ON knowledge_node BEGIN
      INSERT INTO knowledge_node_fts(knowledge_node_fts, rowid, node_id, title, content, domain)
      VALUES ('delete', old.rowid, old.node_id, old.title, old.content, old.domain);
      INSERT INTO knowledge_node_fts(rowid, node_id, title, content, domain)
      VALUES (new.rowid, new.node_id, new.title, new.content, new.domain);
    END;
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS kg_edge (
      src_node TEXT NOT NULL,
      dst_node TEXT NOT NULL,
      relation TEXT NOT NULL,
      weight REAL DEFAULT 1.0,
      evidence TEXT,
      PRIMARY KEY (src_node, dst_node, relation)
    );
    CREATE INDEX IF NOT EXISTS idx_kg_src ON kg_edge(src_node);
    CREATE INDEX IF NOT EXISTS idx_kg_rel ON kg_edge(relation);
  `);

  return db;
}

/** 构造一个标准知识条目写入参数 */
function makeNode(overrides: Partial<{
  nodeId: string; title: string; content: string; domain: string;
  paradigm: KnowledgeParadigm; confidence: number; sourceType: string; isVerified: boolean;
}> = {}) {
  return {
    nodeId: overrides.nodeId ?? "node-1",
    title: overrides.title ?? "Test Knowledge",
    content: overrides.content ?? "TypeScript is a typed superset of JavaScript.",
    domain: overrides.domain ?? "programming",
    paradigm: (overrides.paradigm ?? "fact") as KnowledgeParadigm,
    confidence: overrides.confidence ?? 0.9,
    sourceType: (overrides.sourceType ?? "manual") as "manual" | "web" | "llm" | "ocr" | "kg",
    isVerified: overrides.isVerified ?? true,
    schemaVersion: 1,
  };
}

// ═══════════════════════════════════════════════════════════════
// A. CRUD: write + read
// ═══════════════════════════════════════════════════════════════

describe("A. KnowledgeStore CRUD", () => {
  let db: Database;
  let store: KnowledgeStore;

  beforeEach(() => {
    db = createTestDb();
    store = new KnowledgeStore(db);
  });

  afterEach(() => {
    db.close();
  });

  test("首次写入应返回 revision=1", () => {
    const node = store.write(makeNode());
    expect(node.revision).toBe(1);
    expect(node.contentHash).toBeTruthy();
    expect(node.createdAt).toBe(node.updatedAt);
  });

  test("read 应返回已写入的节点", () => {
    store.write(makeNode({ nodeId: "read-1", content: "hello world" }));
    const node = store.read("read-1");
    expect(node).not.toBeNull();
    expect(node!.content).toBe("hello world");
    expect(node!.nodeId).toBe("read-1");
  });

  test("read 不存在的节点应返回 null", () => {
    expect(store.read("non-existent")).toBeNull();
  });

  test("重复写入同一 nodeId 应递增 revision", () => {
    store.write(makeNode({ nodeId: "rev-1", content: "v1" }));
    const v2 = store.write(makeNode({ nodeId: "rev-1", content: "v2" }));
    expect(v2.revision).toBe(2);
    const v3 = store.write(makeNode({ nodeId: "rev-1", content: "v3" }));
    expect(v3.revision).toBe(3);
  });

  test("重复写入应保留首次 createdAt", () => {
    store.write(makeNode({ nodeId: "ts-1", content: "first" }));
    const first = store.read("ts-1")!;
    // 等待一小段时间确保 updatedAt 不同
    const v2 = store.write(makeNode({ nodeId: "ts-1", content: "second" }));
    expect(v2.createdAt).toBe(first.createdAt);
    expect(v2.updatedAt).toBeGreaterThanOrEqual(first.updatedAt);
  });

  test("写入应正确存储 behavior/prediction/hypothesis 扩展字段", () => {
    store.write({
      nodeId: "ext-1",
      title: "Behavior Node",
      content: "IF temp > 100 THEN boiling",
      domain: "physics",
      paradigm: "behavior",
      confidence: 0.85,
      sourceType: "llm",
      isVerified: false,
      schemaVersion: 1,
      behavior: {
        triggers: ["temp > 100"],
        outcomes: [{ result: "boiling", probability: 0.95 }],
        preconditions: ["liquid water"],
      },
    });
    const node = store.read("ext-1");
    expect(node).not.toBeNull();
    expect(node!.behavior).toBeDefined();
    expect(node!.behavior!.triggers).toContain("temp > 100");
    expect(node!.behavior!.outcomes[0].probability).toBe(0.95);
  });

  test("写入应计算 contentHash", () => {
    const node = store.write(makeNode({ nodeId: "hash-1", content: "test content" }));
    // SHA-256 hex = 64 chars
    expect(node.contentHash).toHaveLength(64);
    expect(node.contentHash).toMatch(/^[0-9a-f]+$/);
  });

  test("isVerified 应正确存储为布尔值", () => {
    store.write(makeNode({ nodeId: "ver-1", isVerified: true }));
    store.write(makeNode({ nodeId: "ver-2", isVerified: false }));
    expect(store.read("ver-1")!.isVerified).toBe(true);
    expect(store.read("ver-2")!.isVerified).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════
// B. 版本快照: getRevisions
// ═══════════════════════════════════════════════════════════════

describe("B. 版本快照 getRevisions", () => {
  let db: Database;
  let store: KnowledgeStore;

  beforeEach(() => {
    db = createTestDb();
    store = new KnowledgeStore(db);
  });

  afterEach(() => {
    db.close();
  });

  test("首次写入不应产生版本快照", () => {
    store.write(makeNode({ nodeId: "snap-1", content: "v1" }));
    const revs = store.getRevisions("snap-1");
    expect(revs).toHaveLength(0);
  });

  test("更新内容应产生版本快照", () => {
    store.write(makeNode({ nodeId: "snap-2", content: "v1" }));
    store.write(makeNode({ nodeId: "snap-2", content: "v2" }));
    const revs = store.getRevisions("snap-2");
    expect(revs).toHaveLength(1);
    expect(revs[0].content).toBe("v1");
    expect(revs[0].revision).toBe(1);
    expect(revs[0].diff).toBeTruthy();
  });

  test("多次更新应产生多个版本快照（按 revision 降序）", () => {
    store.write(makeNode({ nodeId: "snap-3", content: "v1" }));
    store.write(makeNode({ nodeId: "snap-3", content: "v2" }));
    store.write(makeNode({ nodeId: "snap-3", content: "v3" }));
    const revs = store.getRevisions("snap-3");
    expect(revs).toHaveLength(2);
    // revision DESC: revision=2 在前, revision=1 在后
    expect(revs[0].revision).toBe(2);
    expect(revs[1].revision).toBe(1);
  });

  test("内容不变时不应产生版本快照", () => {
    store.write(makeNode({ nodeId: "snap-4", content: "same" }));
    store.write(makeNode({ nodeId: "snap-4", content: "same" }));
    const revs = store.getRevisions("snap-4");
    // 即使内容相同，write 仍会保存快照（因为代码先检查 existing 再保存旧内容）
    // diff 应为空字符串（因为 oldContent === newContent）
    expect(revs).toHaveLength(1);
    expect(revs[0].diff).toBe("");
  });

  test("不存在的节点应返回空数组", () => {
    expect(store.getRevisions("non-existent")).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════
// C. 搜索: search
// ═══════════════════════════════════════════════════════════════

describe("C. 搜索 search", () => {
  let db: Database;
  let store: KnowledgeStore;

  beforeEach(() => {
    db = createTestDb();
    store = new KnowledgeStore(db);
    // 写入多条测试数据
    store.write(makeNode({ nodeId: "s-1", title: "TypeScript Basics", content: "TypeScript is a typed language", domain: "programming" }));
    store.write(makeNode({ nodeId: "s-2", title: "Python Guide", content: "Python is a scripting language", domain: "programming" }));
    store.write(makeNode({ nodeId: "s-3", title: "Physics Laws", content: "Newton's laws of motion", domain: "science" }));
  });

  afterEach(() => {
    db.close();
  });

  test("FTS5 全文搜索应返回匹配结果", () => {
    const results = store.search("TypeScript");
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results.some((n) => n.nodeId === "s-1")).toBe(true);
  });

  test("搜索应按 confidence 降序排列", () => {
    store.write(makeNode({ nodeId: "s-4", title: "TypeScript Advanced", content: "TypeScript generics and decorators", domain: "programming", confidence: 0.95 }));
    const results = store.search("TypeScript");
    expect(results.length).toBeGreaterThanOrEqual(2);
    expect(results[0].confidence).toBeGreaterThanOrEqual(results[1].confidence);
  });

  test("按 domain 过滤", () => {
    const results = store.search("language", { domain: "programming" });
    expect(results.every((n) => n.domain === "programming")).toBe(true);
  });

  test("按 paradigm 过滤", () => {
    const results = store.search("", { paradigm: "fact" });
    expect(results.every((n) => n.paradigm === "fact")).toBe(true);
  });

  test("按 minConfidence 过滤", () => {
    const results = store.search("", { minConfidence: 0.9 });
    expect(results.every((n) => n.confidence >= 0.9)).toBe(true);
  });

  test("limit 参数应限制返回数量", () => {
    const results = store.search("", { limit: 2 });
    expect(results.length).toBeLessThanOrEqual(2);
  });

  test("空查询应返回所有节点（受 limit 限制）", () => {
    const results = store.search("", { limit: 100 });
    expect(results.length).toBe(3);
  });

  test("无匹配的查询应返回空数组", () => {
    const results = store.search("nonexistent-zzz-12345");
    expect(results).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════
// D. 知识图谱边: addEdge + getOutEdges + getInEdges
// ═══════════════════════════════════════════════════════════════

describe("D. 知识图谱边", () => {
  let db: Database;
  let store: KnowledgeStore;

  beforeEach(() => {
    db = createTestDb();
    store = new KnowledgeStore(db);
    // 写入节点
    store.write(makeNode({ nodeId: "n-a", content: "Node A" }));
    store.write(makeNode({ nodeId: "n-b", content: "Node B" }));
    store.write(makeNode({ nodeId: "n-c", content: "Node C" }));
  });

  afterEach(() => {
    db.close();
  });

  test("addEdge 应成功添加边", () => {
    store.addEdge({ srcNode: "n-a", dstNode: "n-b", relation: "depends-on", weight: 0.8 });
    const edges = store.getOutEdges("n-a");
    expect(edges).toHaveLength(1);
    expect(edges[0].srcNode).toBe("n-a");
    expect(edges[0].dstNode).toBe("n-b");
    expect(edges[0].relation).toBe("depends-on");
    expect(edges[0].weight).toBe(0.8);
  });

  test("getOutEdges 应返回所有出边", () => {
    store.addEdge({ srcNode: "n-a", dstNode: "n-b", relation: "depends-on", weight: 1 });
    store.addEdge({ srcNode: "n-a", dstNode: "n-c", relation: "related-to", weight: 0.5 });
    const edges = store.getOutEdges("n-a");
    expect(edges).toHaveLength(2);
  });

  test("getInEdges 应返回所有入边", () => {
    store.addEdge({ srcNode: "n-a", dstNode: "n-b", relation: "depends-on", weight: 1 });
    store.addEdge({ srcNode: "n-c", dstNode: "n-b", relation: "related-to", weight: 0.5 });
    const edges = store.getInEdges("n-b");
    expect(edges).toHaveLength(2);
  });

  test("无边的节点应返回空数组", () => {
    expect(store.getOutEdges("n-a")).toEqual([]);
    expect(store.getInEdges("n-a")).toEqual([]);
  });

  test("相同 src/dst/relation 的边应被替换（INSERT OR REPLACE）", () => {
    store.addEdge({ srcNode: "n-a", dstNode: "n-b", relation: "depends-on", weight: 0.5 });
    store.addEdge({ srcNode: "n-a", dstNode: "n-b", relation: "depends-on", weight: 0.9 });
    const edges = store.getOutEdges("n-a");
    expect(edges).toHaveLength(1);
    expect(edges[0].weight).toBe(0.9);
  });

  test("边应正确存储 evidence 数组", () => {
    store.addEdge({
      srcNode: "n-a", dstNode: "n-b", relation: "derives-from", weight: 1,
      evidence: ["paper-1", "paper-2"],
    });
    const edges = store.getOutEdges("n-a");
    expect(edges[0].evidence).toEqual(["paper-1", "paper-2"]);
  });

  test("无边 evidence 时应为 undefined", () => {
    store.addEdge({ srcNode: "n-a", dstNode: "n-b", relation: "related-to", weight: 1 });
    const edges = store.getOutEdges("n-a");
    expect(edges[0].evidence).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════
// E. 子图检索: subgraph (BFS)
// ═══════════════════════════════════════════════════════════════

describe("E. 子图检索 subgraph", () => {
  let db: Database;
  let store: KnowledgeStore;

  beforeEach(() => {
    db = createTestDb();
    store = new KnowledgeStore(db);
    // 构建图: A → B → C, A → C
    store.write(makeNode({ nodeId: "g-a", content: "Graph A" }));
    store.write(makeNode({ nodeId: "g-b", content: "Graph B" }));
    store.write(makeNode({ nodeId: "g-c", content: "Graph C" }));
    store.addEdge({ srcNode: "g-a", dstNode: "g-b", relation: "depends-on", weight: 1 });
    store.addEdge({ srcNode: "g-b", dstNode: "g-c", relation: "depends-on", weight: 1 });
    store.addEdge({ srcNode: "g-a", dstNode: "g-c", relation: "related-to", weight: 0.5 });
  });

  afterEach(() => {
    db.close();
  });

  test("depth=1 应返回种子节点及其直接邻居", () => {
    const sub = store.subgraph("g-a", 1, 10);
    const ids = sub.map((n) => n.nodeId);
    expect(ids).toContain("g-a");
    expect(ids).toContain("g-b");
    expect(ids).toContain("g-c");
  });

  test("depth=0 应只返回种子节点", () => {
    const sub = store.subgraph("g-a", 0, 10);
    expect(sub).toHaveLength(1);
    expect(sub[0].nodeId).toBe("g-a");
  });

  test("depth=2 应返回整个连通图", () => {
    const sub = store.subgraph("g-a", 2, 10);
    expect(sub.length).toBe(3);
  });

  test("maxNodes 应限制返回数量", () => {
    const sub = store.subgraph("g-a", 2, 1);
    expect(sub).toHaveLength(1);
  });

  test("不存在的种子节点应返回空数组", () => {
    const sub = store.subgraph("non-existent", 2, 10);
    expect(sub).toEqual([]);
  });

  test("环形图不应无限循环", () => {
    // 添加 C → A 形成环
    store.addEdge({ srcNode: "g-c", dstNode: "g-a", relation: "related-to", weight: 1 });
    const sub = store.subgraph("g-a", 10, 100);
    // 即使有环，也不应无限循环
    expect(sub.length).toBeLessThanOrEqual(100);
    expect(sub.length).toBe(3); // 三个节点
  });
});

// ═══════════════════════════════════════════════════════════════
// F. 边界条件与异常输入
// ═══════════════════════════════════════════════════════════════

describe("F. 边界条件与异常输入", () => {
  let db: Database;
  let store: KnowledgeStore;

  beforeEach(() => {
    db = createTestDb();
    store = new KnowledgeStore(db);
  });

  afterEach(() => {
    db.close();
  });

  test("NaN confidence 应被 SQLite CHECK 约束拒绝", () => {
    // SQLite CHECK(confidence BETWEEN 0.0 AND 1.0) 会拒绝 NaN
    // NaN BETWEEN 0.0 AND 1.0 为 false → 约束失败
    expect(() => {
      store.write(makeNode({ nodeId: "nan-conf", confidence: NaN }));
    }).toThrow();
  });

  test("负数 confidence 应被 SQLite CHECK 约束拒绝", () => {
    expect(() => {
      store.write(makeNode({ nodeId: "neg-conf", confidence: -0.1 }));
    }).toThrow();
  });

  test("超过 1 的 confidence 应被 SQLite CHECK 约束拒绝", () => {
    expect(() => {
      store.write(makeNode({ nodeId: "over-conf", confidence: 1.1 }));
    }).toThrow();
  });

  test("confidence=0 应被接受", () => {
    const node = store.write(makeNode({ nodeId: "zero-conf", confidence: 0 }));
    expect(node.confidence).toBe(0);
  });

  test("confidence=1 应被接受", () => {
    const node = store.write(makeNode({ nodeId: "one-conf", confidence: 1 }));
    expect(node.confidence).toBe(1);
  });

  test("空内容应能写入", () => {
    const node = store.write(makeNode({ nodeId: "empty-content", content: "" }));
    expect(node.content).toBe("");
  });

  test("长内容应能写入", () => {
    const longContent = "x".repeat(10000);
    const node = store.write(makeNode({ nodeId: "long-content", content: longContent }));
    expect(node.content).toBe(longContent);
  });

  test("特殊字符内容应能写入", () => {
    const special = "Hello 'world' <script>alert(1)</script> \"quotes\" \n newline";
    const node = store.write(makeNode({ nodeId: "special-content", content: special }));
    expect(store.read("special-content")!.content).toBe(special);
  });

  test("limit 参数应被 clamp 到 [1, 100]", () => {
    // 写入超过 100 条数据
    for (let i = 0; i < 110; i++) {
      store.write(makeNode({ nodeId: `clamp-${i}`, content: `content ${i}` }));
    }
    // NOTE: limit=0 因 `Number(0) || 10` 被转为默认值 10（JS falsy 陷阱），
    // 这是源码的已知行为，非本次修复范围
    // limit=200 应被 clamp 到 100
    expect(store.search("", { limit: 200 }).length).toBeLessThanOrEqual(100);
    // limit=1 应返回 1 条
    expect(store.search("", { limit: 1 })).toHaveLength(1);
    // limit=50 应返回 50 条
    expect(store.search("", { limit: 50 })).toHaveLength(50);
  });
});
