/**
 * 回归测试: DataUnifier → KnowledgeStore write 路径
 *
 * 之前 dataUnifier.write() 调用 knowledgeStore.write() 时:
 *   1. 字段名 `id` 应为 `nodeId` (KnowledgeStore 期望 nodeId)
 *   2. 缺失 `confidence` (NOT NULL 约束失败)
 *   3. 缺失 `schemaVersion` 和 `isVerified`
 * 错误被 try/catch 吞掉, 导致 knowledgeNode 始终为 undefined,
 * 既有的 property 测试只断言 result.atoms, 未发现此 bug。
 *
 * 本测试直接断言 knowledgeNode 路径, 防止回归。
 */

import { describe, test, expect, beforeAll } from "bun:test";
import { Database } from "bun:sqlite";
import { atomStore } from "../../src/dre/runtime/atom-engine.js";
import { dataUnifier } from "../../src/dre/runtime/data-unifier.js";
import { KnowledgeStore } from "../../src/dre/storage/knowledge-store.js";

function setupKnowledgeTables(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS knowledge_node (
      node_id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      content_hash TEXT NOT NULL DEFAULT '',
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
      hypothesis TEXT
    )
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
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS kg_edge (
      src_node TEXT NOT NULL,
      dst_node TEXT NOT NULL,
      relation TEXT NOT NULL,
      weight REAL DEFAULT 1.0,
      evidence TEXT,
      PRIMARY KEY (src_node, dst_node, relation)
    )
  `);
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_node_fts USING fts5(
      node_id, title, content, domain,
      content=knowledge_node,
      content_rowid=rowid
    );
  `);
}

describe("Regression: DataUnifier write → KnowledgeStore (NOT NULL bug)", () => {
  let db: Database;
  let store: KnowledgeStore;

  beforeAll(() => {
    db = new Database(":memory:");
    setupKnowledgeTables(db);
    store = new KnowledgeStore(db);
    atomStore.initPersist(db);
    dataUnifier.init(db, store);
    dataUnifier.setAutoPersist(false);
  });

  test("write() should return a non-undefined knowledgeNode (no NOT NULL failure)", () => {
    const PREFIX = `regression-NotNull-${Date.now()}-`;
    const result = dataUnifier.write({
      kind: "fact",
      content: `${PREFIX}basic-fact`,
      domain: "testing",
    });

    expect(result.atom).toBeDefined();
    expect(result.knowledgeNode).toBeDefined();
    expect(result.knowledgeNode!.nodeId).toBe(result.atom.id);
    expect(result.knowledgeNode!.content).toBe(`${PREFIX}basic-fact`);
  });

  test("knowledgeNode should have correct field values from DataItem", () => {
    const PREFIX = `regression-Fields-${Date.now()}-`;
    const result = dataUnifier.write({
      kind: "fact",
      content: `${PREFIX}fields-test`,
      domain: "physics",
      paradigm: "rule",
      sourceType: "llm",
      confidence: "certain",
    });

    const node = result.knowledgeNode!;
    expect(node).toBeDefined();
    expect(node.nodeId).toBe(result.atom.id);
    expect(node.title).toBe(`${PREFIX}fields-test`.slice(0, 100));
    expect(node.content).toBe(`${PREFIX}fields-test`);
    expect(node.schemaVersion).toBe(1);
    expect(node.domain).toBe("physics");
    expect(node.paradigm).toBe("rule");
    expect(node.sourceType).toBe("llm");
    expect(node.isVerified).toBe(false);
    // mapConfidence("certain") = 0.9
    expect(node.confidence).toBeCloseTo(0.9, 5);
  });

  test("confidence mapping: all AtomConfidence values map to expected numbers", () => {
    const PREFIX = `regression-Conf-${Date.now()}-`;
    const cases: Array<{ input: "certain" | "inferred" | "uncertain" | "hypothetical"; expected: number }> = [
      { input: "certain", expected: 0.9 },
      { input: "inferred", expected: 0.7 },
      { input: "uncertain", expected: 0.4 },
      { input: "hypothetical", expected: 0.2 },
    ];

    for (const { input, expected } of cases) {
      const result = dataUnifier.write({
        kind: "fact",
        content: `${PREFIX}${input}`,
        confidence: input,
      });
      expect(result.knowledgeNode).toBeDefined();
      expect(result.knowledgeNode!.confidence).toBeCloseTo(expected, 5);
    }
  });

  test("default confidence (undefined) should map to 0.5", () => {
    const PREFIX = `regression-DefaultConf-${Date.now()}-`;
    const result = dataUnifier.write({
      kind: "fact",
      content: `${PREFIX}no-conf`,
    });
    expect(result.knowledgeNode).toBeDefined();
    expect(result.knowledgeNode!.confidence).toBeCloseTo(0.5, 5);
  });

  test("knowledgeNode should be readable via KnowledgeStore.read(nodeId)", () => {
    const PREFIX = `regression-Read-${Date.now()}-`;
    const result = dataUnifier.write({
      kind: "fact",
      content: `${PREFIX}readable`,
      domain: "regression",
    });

    const readBack = store.read(result.atom.id);
    expect(readBack).not.toBeNull();
    expect(readBack!.nodeId).toBe(result.atom.id);
    expect(readBack!.content).toBe(`${PREFIX}readable`);
    expect(readBack!.domain).toBe("regression");
  });

  test("knowledgeNode should appear in dataUnifier.search().knowledgeNodes", () => {
    const NEEDLE = `regression-Search-Needle-${Date.now()}-unique-token`;
    dataUnifier.write({
      kind: "fact",
      content: NEEDLE,
      domain: "searchable",
    });

    const result = dataUnifier.search(NEEDLE);
    expect(result.knowledgeNodes.length).toBeGreaterThan(0);
    const found = result.knowledgeNodes.find((n) => n.content === NEEDLE);
    expect(found).toBeDefined();
    expect(found!.content).toBe(NEEDLE);
  });

  test("repeated writes create distinct atoms (each a fresh knowledge node, revision=1)", () => {
    const PREFIX = `regression-Rev-${Date.now()}-`;
    const content = `${PREFIX}revision-test`;

    const r1 = dataUnifier.write({ kind: "fact", content });
    const r2 = dataUnifier.write({ kind: "fact", content });

    expect(r1.knowledgeNode).toBeDefined();
    expect(r2.knowledgeNode).toBeDefined();
    // DataUnifier 每次都创建新 atom (新 ID), 所以是不同节点
    expect(r1.knowledgeNode!.nodeId).not.toBe(r2.knowledgeNode!.nodeId);
    expect(r1.knowledgeNode!.revision).toBe(1);
    expect(r2.knowledgeNode!.revision).toBe(1);
  });

  test("KnowledgeStore.write() with same nodeId should bump revision (store-level)", () => {
    const FIXED_NODE_ID = `regression-fixed-node-${Date.now()}`;
    const content1 = `first-content-${Date.now()}`;
    const content2 = `second-content-${Date.now()}`;

    const n1 = store.write({
      nodeId: FIXED_NODE_ID,
      title: content1.slice(0, 100),
      content: content1,
      schemaVersion: 1,
      domain: "regression",
      paradigm: "fact",
      confidence: 0.7,
      sourceType: "manual",
      isVerified: false,
    });
    const n2 = store.write({
      nodeId: FIXED_NODE_ID,
      title: content2.slice(0, 100),
      content: content2,
      schemaVersion: 1,
      domain: "regression",
      paradigm: "fact",
      confidence: 0.8,
      sourceType: "manual",
      isVerified: false,
    });

    expect(n1.nodeId).toBe(FIXED_NODE_ID);
    expect(n2.nodeId).toBe(FIXED_NODE_ID);
    expect(n2.revision).toBeGreaterThan(n1.revision);
    expect(n2.content).toBe(content2);
  });
});
