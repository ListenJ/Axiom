/**
 * DRE 确定性推理引擎测试
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { VFS, NodeType } from "../src/dre/vfs";
import { SqliteBackend } from "../src/dre/storage/sqlite-backend";
import { KnowledgeStore } from "../src/dre/storage/knowledge-store";
import { ConsciousnessStream, WorkingMemory, EpisodicMemory, ReflectionQueue } from "../src/dre/consciousness/stream";
import { KnowledgeGraph } from "../src/dre/kg/graph";
import { Database } from "bun:sqlite";

describe("DRE VFS", () => {
  let vfs: VFS;

  beforeAll(() => {
    vfs = VFS.instance();
  });

  test("mount and list mounts", () => {
    const backend = new SqliteBackend(":memory:");
    vfs.mount("/test", backend);
    expect(vfs.listMounts()).toContain("/test");
  });

  test("read and write", async () => {
    const backend = new SqliteBackend(":memory:");
    vfs.mount("/rw", backend);

    const writeResult = await vfs.write("/rw/file.txt", "Hello, World!", "test");
    expect(writeResult).toBe(true);

    const content = await vfs.read("/rw/file.txt");
    expect(content).toBe("Hello, World!");
  });

  test("stat returns inode", async () => {
    const backend = new SqliteBackend(":memory:");
    vfs.mount("/stat", backend);

    await vfs.write("/stat/file.txt", "content", "test");
    const inode = await vfs.stat("/stat/file.txt");

    expect(inode).not.toBeNull();
    expect(inode?.path).toBe("/file.txt");
    expect(inode?.type).toBe(NodeType.File);
    expect(inode?.size).toBe(7);
  });

  test("list directory", async () => {
    const backend = new SqliteBackend(":memory:");
    vfs.mount("/list", backend);

    await vfs.write("/list/a.txt", "a", "test");
    await vfs.write("/list/b.txt", "b", "test");

    const items = await vfs.list("/list");
    expect(items.length).toBeGreaterThanOrEqual(2);
  });

  test("content hash is deterministic", () => {
    const hash1 = VFS.contentHash("Hello");
    const hash2 = VFS.contentHash("Hello");
    const hash3 = VFS.contentHash("World");

    expect(hash1).toBe(hash2);
    expect(hash1).not.toBe(hash3);
  });
});

describe("DRE SQLite Backend", () => {
  let backend: SqliteBackend;

  beforeAll(() => {
    backend = new SqliteBackend(":memory:");
  });

  afterAll(() => {
    backend.close();
  });

  test("write creates file", async () => {
    const result = await backend.write("/test.txt", "Hello", "test");
    expect(result).toBe(true);
  });

  test("read returns content", async () => {
    await backend.write("/read.txt", "Content", "test");
    const content = await backend.read("/read.txt");
    expect(content).toBe("Content");
  });

  test("read non-existent returns null", async () => {
    const content = await backend.read("/nonexistent.txt");
    expect(content).toBeNull();
  });

  test("write creates version history", async () => {
    await backend.write("/versioned.txt", "v1", "initial");
    await backend.write("/versioned.txt", "v2", "update");

    const history = backend.getHistory("/versioned.txt");
    expect(history.length).toBe(1);
    expect(history[0].reason).toBe("initial");
  });

  test("rollback restores previous version", async () => {
    await backend.write("/rollback.txt", "original", "initial");
    await backend.write("/rollback.txt", "modified", "update");

    const rollbackResult = backend.rollback("/rollback.txt", 1);
    expect(rollbackResult).toBe(true);

    const content = await backend.read("/rollback.txt");
    expect(content).toBe("original");
  });

  test("delete removes file", async () => {
    await backend.write("/delete.txt", "content", "test");
    const deleteResult = await backend.delete("/delete.txt");
    expect(deleteResult).toBe(true);

    const content = await backend.read("/delete.txt");
    expect(content).toBeNull();
  });
});

describe("DRE Knowledge Store", () => {
  let db: Database;
  let store: KnowledgeStore;

  beforeAll(() => {
    db = new Database(":memory:");
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
        is_verified INTEGER NOT NULL DEFAULT 0
      );
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
      CREATE TABLE IF NOT EXISTS kg_edge (
        src_node TEXT NOT NULL,
        dst_node TEXT NOT NULL,
        relation TEXT NOT NULL,
        weight REAL DEFAULT 1.0,
        evidence TEXT,
        PRIMARY KEY (src_node, dst_node, relation)
      );
    `);
    store = new KnowledgeStore(db);
  });

  afterAll(() => {
    db.close();
  });

  test("write and read knowledge", () => {
    const node = store.write({
      nodeId: "test-1",
      title: "Test Node",
      content: "This is test content",
      domain: "test",
      paradigm: "fact",
      confidence: 0.9,
      sourceType: "manual",
      isVerified: true,
      schemaVersion: 1,
    });

    expect(node.nodeId).toBe("test-1");
    expect(node.title).toBe("Test Node");

    const readNode = store.read("test-1");
    expect(readNode).not.toBeNull();
    expect(readNode?.content).toBe("This is test content");
  });

  test("search knowledge", () => {
    store.write({
      nodeId: "search-1",
      title: "TypeScript Guide",
      content: "TypeScript is a typed superset of JavaScript",
      domain: "cs",
      paradigm: "concept",
      confidence: 0.8,
      sourceType: "manual",
      isVerified: true,
      schemaVersion: 1,
    });

    const results = store.search("TypeScript");
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].title).toBe("TypeScript Guide");
  });

  test("add and get edges", () => {
    store.write({
      nodeId: "edge-src",
      title: "Source",
      content: "Source node",
      domain: "test",
      paradigm: "fact",
      confidence: 1.0,
      sourceType: "manual",
      isVerified: true,
      schemaVersion: 1,
    });

    store.write({
      nodeId: "edge-dst",
      title: "Target",
      content: "Target node",
      domain: "test",
      paradigm: "fact",
      confidence: 1.0,
      sourceType: "manual",
      isVerified: true,
      schemaVersion: 1,
    });

    store.addEdge({
      srcNode: "edge-src",
      dstNode: "edge-dst",
      relation: "related-to",
      weight: 0.8,
    });

    const outEdges = store.getOutEdges("edge-src");
    expect(outEdges.length).toBe(1);
    expect(outEdges[0].dstNode).toBe("edge-dst");

    const inEdges = store.getInEdges("edge-dst");
    expect(inEdges.length).toBe(1);
    expect(inEdges[0].srcNode).toBe("edge-src");
  });

  test("subgraph retrieval", () => {
    store.write({
      nodeId: "sg-center",
      title: "Center",
      content: "Center node",
      domain: "test",
      paradigm: "fact",
      confidence: 1.0,
      sourceType: "manual",
      isVerified: true,
      schemaVersion: 1,
    });

    store.write({
      nodeId: "sg-neighbor",
      title: "Neighbor",
      content: "Neighbor node",
      domain: "test",
      paradigm: "fact",
      confidence: 0.9,
      sourceType: "manual",
      isVerified: true,
      schemaVersion: 1,
    });

    store.addEdge({
      srcNode: "sg-center",
      dstNode: "sg-neighbor",
      relation: "related-to",
      weight: 1.0,
    });

    const subgraph = store.subgraph("sg-center", 1);
    expect(subgraph.length).toBe(2);
  });
});

describe("DRE Consciousness Stream", () => {
  test("working memory capacity limit", () => {
    const wm = new WorkingMemory(3);

    wm.push({ id: "1", content: "First", timestamp: Date.now(), metadata: {} });
    wm.push({ id: "2", content: "Second", timestamp: Date.now(), metadata: {} });
    wm.push({ id: "3", content: "Third", timestamp: Date.now(), metadata: {} });
    wm.push({ id: "4", content: "Fourth", timestamp: Date.now(), metadata: {} });

    expect(wm.size).toBe(3);
    const snapshot = wm.snapshot();
    expect(snapshot[0].content).toBe("Second");
    expect(snapshot[2].content).toBe("Fourth");
  });

  test("episodic memory search", () => {
    const em = new EpisodicMemory();

    em.add({
      id: "ep-1",
      content: "TypeScript is great",
      embedding: [1, 0, 0],
      timestamp: Date.now(),
      metadata: {},
    });

    em.add({
      id: "ep-2",
      content: "Python is useful",
      embedding: [0, 1, 0],
      timestamp: Date.now(),
      metadata: {},
    });

    const results = em.search([1, 0, 0], 1);
    expect(results.length).toBe(1);
    expect(results[0].content).toBe("TypeScript is great");
  });

  test("reflection queue triggers on consecutive failures", () => {
    const rq = new ReflectionQueue();

    const trace = Array.from({ length: 10 }, (_, i) => ({
      stepSeq: i,
      stepType: "think" as const,
      inputHash: `input-${i}`,
      outputHash: `output-${i}`,
      status: i >= 7 ? "failed" as const : "success" as const,
      timestamp: Date.now(),
    }));

    expect(rq.shouldReflect(trace)).toBe(true);
  });

  test("consciousness stream processes steps", async () => {
    const stream = new ConsciousnessStream({
      workingMemoryCapacity: 5,
      episodicTTL: 60000,
    });

    const result = await stream.step({
      observation: "Test observation",
      metadata: { source: "test" },
    });

    expect(result.decision).toBeDefined();
    expect(typeof result.shouldReflect).toBe("boolean");

    const state = stream.getState();
    expect(state.workingMemorySize).toBe(1);
    expect(state.traceLength).toBe(1);
  });
});

describe("DRE Knowledge Graph", () => {
  let kg: KnowledgeGraph;

  beforeAll(() => {
    kg = new KnowledgeGraph();
  });

  test("add and get node", () => {
    kg.addNode({
      id: "node-1",
      title: "Test Node",
      domain: "test",
      paradigm: "fact",
      confidence: 0.9,
    });

    const node = kg.getNode("node-1");
    expect(node).not.toBeNull();
    expect(node?.title).toBe("Test Node");
  });

  test("add edge", () => {
    kg.addNode({
      id: "edge-a",
      title: "A",
      domain: "test",
      paradigm: "fact",
      confidence: 1.0,
    });

    kg.addNode({
      id: "edge-b",
      title: "B",
      domain: "test",
      paradigm: "fact",
      confidence: 1.0,
    });

    kg.addEdge({
      src: "edge-a",
      dst: "edge-b",
      relation: "related-to",
      weight: 0.8,
    });

    const neighbors = kg.getNeighbors("edge-a");
    expect(neighbors.length).toBe(1);
    expect(neighbors[0].id).toBe("edge-b");
  });

  test("shortest path", () => {
    kg.addNode({ id: "sp-a", title: "A", domain: "test", paradigm: "fact", confidence: 1.0 });
    kg.addNode({ id: "sp-b", title: "B", domain: "test", paradigm: "fact", confidence: 1.0 });
    kg.addNode({ id: "sp-c", title: "C", domain: "test", paradigm: "fact", confidence: 1.0 });

    kg.addEdge({ src: "sp-a", dst: "sp-b", relation: "related-to", weight: 1.0 });
    kg.addEdge({ src: "sp-b", dst: "sp-c", relation: "related-to", weight: 1.0 });

    const path = kg.shortestPath("sp-a", "sp-c");
    expect(path).not.toBeNull();
    expect(path!.length).toBe(2);
    expect(path![0].src).toBe("sp-a");
    expect(path![0].dst).toBe("sp-b");
    expect(path![1].src).toBe("sp-b");
    expect(path![1].dst).toBe("sp-c");
  });

  test("subgraph retrieval", () => {
    kg.addNode({ id: "sg-1", title: "SG1", domain: "test", paradigm: "fact", confidence: 1.0 });
    kg.addNode({ id: "sg-2", title: "SG2", domain: "test", paradigm: "fact", confidence: 0.9 });
    kg.addNode({ id: "sg-3", title: "SG3", domain: "test", paradigm: "fact", confidence: 0.8 });

    kg.addEdge({ src: "sg-1", dst: "sg-2", relation: "related-to", weight: 1.0 });
    kg.addEdge({ src: "sg-2", dst: "sg-3", relation: "related-to", weight: 1.0 });

    const subgraph = kg.subgraph("sg-1", 2);
    expect(subgraph.length).toBe(3);
  });

  test("nodes by domain", () => {
    kg.addNode({ id: "dom-1", title: "Domain 1", domain: "cs", paradigm: "fact", confidence: 1.0 });
    kg.addNode({ id: "dom-2", title: "Domain 2", domain: "cs", paradigm: "fact", confidence: 0.9 });
    kg.addNode({ id: "dom-3", title: "Domain 3", domain: "math", paradigm: "fact", confidence: 0.8 });

    const csNodes = kg.nodesByDomain("cs");
    expect(csNodes.length).toBeGreaterThanOrEqual(2);
  });

  test("community detection", () => {
    kg.addNode({ id: "comm-1", title: "Comm 1", domain: "test", paradigm: "fact", confidence: 1.0 });
    kg.addNode({ id: "comm-2", title: "Comm 2", domain: "test", paradigm: "fact", confidence: 1.0 });
    kg.addNode({ id: "comm-3", title: "Comm 3", domain: "test", paradigm: "fact", confidence: 1.0 });

    kg.addEdge({ src: "comm-1", dst: "comm-2", relation: "related-to", weight: 1.0 });
    kg.addEdge({ src: "comm-2", dst: "comm-3", relation: "related-to", weight: 1.0 });

    const communities = kg.detectCommunities();
    expect(communities.size).toBeGreaterThanOrEqual(1);
  });

  test("JSON serialization", () => {
    const json = kg.toJSON();
    expect(json.nodes).toBeDefined();
    expect(json.edges).toBeDefined();

    const restored = KnowledgeGraph.fromJSON(json);
    expect(restored.nodeCount).toBe(kg.nodeCount);
  });
});
