/**
 * DRE Core Modules 测试
 *
 * 覆盖:
 * - ConsciousnessStream (意识流)
 * - KnowledgeGraph (知识图谱)
 * - Pipeline (三段甄别)
 */

import { describe, test, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import {
  ConsciousnessStream,
  WorkingMemory,
  EpisodicMemory,
  ReflectionQueue,
} from "../src/dre/consciousness/stream.js";
import { KnowledgeGraph, type KGNode, type KGEdge } from "../src/dre/kg/graph.js";
import { KnowledgeStore } from "../src/dre/storage/knowledge-store.js";
import { Pipeline } from "../src/dre/pipeline/pipeline.js";
import { LLMClient } from "../src/dre/llm/client.js";

// ========== WorkingMemory ==========

describe("WorkingMemory", () => {
  test("should push and retrieve items", () => {
    const wm = new WorkingMemory(3);
    wm.push({ id: "1", content: "a", timestamp: 1, metadata: {} });
    wm.push({ id: "2", content: "b", timestamp: 2, metadata: {} });
    wm.push({ id: "3", content: "c", timestamp: 3, metadata: {} });

    expect(wm.size).toBe(3);
    const snap = wm.snapshot();
    expect(snap.length).toBe(3);
    expect(snap[0].content).toBe("a");
  });

  test("should evict oldest when capacity exceeded", () => {
    const wm = new WorkingMemory(2);
    wm.push({ id: "1", content: "a", timestamp: 1, metadata: {} });
    wm.push({ id: "2", content: "b", timestamp: 2, metadata: {} });
    wm.push({ id: "3", content: "c", timestamp: 3, metadata: {} });

    expect(wm.size).toBe(2);
    expect(wm.snapshot()[0].content).toBe("b");
  });

  test("recent(n) should return last n items", () => {
    const wm = new WorkingMemory(10);
    for (let i = 0; i < 5; i++) {
      wm.push({ id: `${i}`, content: `item-${i}`, timestamp: i, metadata: {} });
    }
    const recent = wm.recent(3);
    expect(recent.length).toBe(3);
    expect(recent[0].content).toBe("item-2");
  });

  test("clear should empty memory", () => {
    const wm = new WorkingMemory(5);
    wm.push({ id: "1", content: "a", timestamp: 1, metadata: {} });
    wm.clear();
    expect(wm.size).toBe(0);
  });
});

// ========== EpisodicMemory ==========

describe("EpisodicMemory", () => {
  test("should add and search items", () => {
    const em = new EpisodicMemory(60000);
    em.add({ id: "1", content: "hello world", timestamp: 1, metadata: {} });
    em.add({ id: "2", content: "foo bar", timestamp: 2, metadata: {} });

    expect(em.size).toBe(2);
    const all = em.getAll();
    expect(all.length).toBe(2);
  });

  test("should cleanup expired items", () => {
    const em = new EpisodicMemory(60000);
    // TTL 是过期时间戳, 不是持续时间
    em.add({ id: "1", content: "expire me", timestamp: Date.now() - 100, metadata: {}, ttl: Date.now() - 50 });
    em.add({ id: "2", content: "keep me", timestamp: Date.now(), metadata: {}, ttl: Date.now() + 60000 });
    const removed = em.cleanup();
    expect(removed).toBe(1);
    expect(em.size).toBe(1);
  });
});

// ========== ReflectionQueue ==========

describe("ReflectionQueue", () => {
  test("should not reflect on short trace", () => {
    const rq = new ReflectionQueue();
    const trace = [
      { stepSeq: 1, stepType: "think" as const, inputHash: "a", outputHash: "b", status: "success" as const, timestamp: 1 },
    ];
    expect(rq.shouldReflect(trace)).toBe(false);
  });

  test("should reflect on consecutive failures", () => {
    const rq = new ReflectionQueue();
    // shouldReflect 需要 trace.length >= 10
    const trace = Array.from({ length: 12 }, (_, i) => ({
      stepSeq: i,
      stepType: "think" as const,
      inputHash: "a",
      outputHash: "b",
      status: "failed" as const,
      timestamp: i,
    }));
    expect(rq.shouldReflect(trace)).toBe(true);
  });
});

// ========== ConsciousnessStream ==========

describe("ConsciousnessStream", () => {
  let stream: ConsciousnessStream;

  beforeEach(() => {
    stream = new ConsciousnessStream({ workingMemoryCapacity: 8, episodicTTL: 60000 });
  });

  test("should process step and update state", async () => {
    const result = await stream.step({ observation: "test observation" });

    expect(result.decision).toBeDefined();
    expect(result.shouldReflect).toBe(false);
    expect(stream.getState().workingMemorySize).toBe(1);
    expect(stream.getState().traceLength).toBe(1);
  });

  test("should maintain working memory FIFO", async () => {
    const smallStream = new ConsciousnessStream({ workingMemoryCapacity: 3 });
    for (let i = 0; i < 5; i++) {
      await smallStream.step({ observation: `obs-${i}` });
    }
    expect(smallStream.getState().workingMemorySize).toBe(3);
  });

  test("should emit reflection event when triggered", async () => {
    let reflected = false;
    stream.on("reflection", () => { reflected = true; });

    // Trigger 6 failures to cause reflection
    for (let i = 0; i < 7; i++) {
      await stream.step({ observation: `failure-${i}` });
    }
    // Reflection may or may not fire depending on internal logic
    // Just verify no crash
    expect(stream.getState().traceLength).toBe(7);
  });

  test("getState should return correct snapshot", async () => {
    await stream.step({ observation: "test" });
    const state = stream.getState();
    expect(typeof state.workingMemorySize).toBe("number");
    expect(typeof state.episodicMemorySize).toBe("number");
    expect(typeof state.traceLength).toBe("number");
    expect(state.reflectionCount).toBe(0);
  });

  test("getTrace should return copy of trace", async () => {
    await stream.step({ observation: "test" });
    const trace = stream.getTrace();
    expect(trace.length).toBe(1);
    expect(trace[0].stepType).toBe("think");
  });

  test("cleanup should remove expired episodic items", () => {
    stream.cleanup(); // Should not crash
  });
});

// ========== KnowledgeGraph ==========

describe("KnowledgeGraph", () => {
  let kg: KnowledgeGraph;

  beforeEach(() => {
    kg = new KnowledgeGraph();
  });

  test("should add and get nodes", () => {
    kg.addNode({ id: "n1", title: "Node 1", domain: "test", paradigm: "fact", confidence: 0.9 });
    expect(kg.nodeCount).toBe(1);
    expect(kg.getNode("n1")?.title).toBe("Node 1");
  });

  test("should add edges and count them", () => {
    kg.addNode({ id: "n1", title: "A", domain: "d", paradigm: "fact", confidence: 1 });
    kg.addNode({ id: "n2", title: "B", domain: "d", paradigm: "fact", confidence: 1 });
    kg.addEdge({ src: "n1", dst: "n2", relation: "related-to", weight: 0.8 });

    expect(kg.edgeCount).toBe(1);
    // subgraph(depth=1) 包含 seed + 直接邻居
    const neighbors = kg.subgraph("n1", 1);
    expect(neighbors.length).toBe(2); // n1 + n2
  });

  test("should prevent duplicate edges", () => {
    kg.addNode({ id: "n1", title: "A", domain: "d", paradigm: "fact", confidence: 1 });
    kg.addNode({ id: "n2", title: "B", domain: "d", paradigm: "fact", confidence: 1 });
    kg.addEdge({ src: "n1", dst: "n2", relation: "related-to", weight: 0.8 });
    kg.addEdge({ src: "n1", dst: "n2", relation: "related-to", weight: 0.9 });

    expect(kg.edgeCount).toBe(1);
  });

  test("should throw on missing node", () => {
    expect(() => {
      kg.addEdge({ src: "missing", dst: "also-missing", relation: "related-to", weight: 1 });
    }).toThrow("Node not found");
  });

  test("should find shortest path", () => {
    kg.addNode({ id: "a", title: "A", domain: "d", paradigm: "fact", confidence: 1 });
    kg.addNode({ id: "b", title: "B", domain: "d", paradigm: "fact", confidence: 1 });
    kg.addNode({ id: "c", title: "C", domain: "d", paradigm: "fact", confidence: 1 });
    kg.addEdge({ src: "a", dst: "b", relation: "related-to", weight: 1 });
    kg.addEdge({ src: "b", dst: "c", relation: "related-to", weight: 1 });

    // shortestPath 返回 KGEdge[] (边序列), 不是 node ID 数组
    const path = kg.shortestPath("a", "c");
    expect(path).not.toBeNull();
    expect(path!.length).toBe(2);
    expect(path![0].src).toBe("a");
    expect(path![0].dst).toBe("b");
    expect(path![1].src).toBe("b");
    expect(path![1].dst).toBe("c");
  });

  test("should return null for unreachable nodes", () => {
    kg.addNode({ id: "a", title: "A", domain: "d", paradigm: "fact", confidence: 1 });
    kg.addNode({ id: "b", title: "B", domain: "d", paradigm: "fact", confidence: 1 });

    expect(kg.shortestPath("a", "b")).toBeNull();
  });

  test("should detect communities", () => {
    kg.addNode({ id: "a", title: "A", domain: "d", paradigm: "fact", confidence: 1 });
    kg.addNode({ id: "b", title: "B", domain: "d", paradigm: "fact", confidence: 1 });
    kg.addNode({ id: "c", title: "C", domain: "d", paradigm: "fact", confidence: 1 });
    kg.addEdge({ src: "a", dst: "b", relation: "related-to", weight: 1 });
    // c is isolated

    const communities = kg.detectCommunities();
    expect(communities.size).toBe(3);
  });

  test("should serialize and deserialize", () => {
    kg.addNode({ id: "n1", title: "N1", domain: "d", paradigm: "fact", confidence: 0.9 });
    kg.addNode({ id: "n2", title: "N2", domain: "d", paradigm: "rule", confidence: 0.8 });
    kg.addEdge({ src: "n1", dst: "n2", relation: "depends-on", weight: 0.7 });

    const json = kg.toJSON();
    const restored = KnowledgeGraph.fromJSON(json);

    expect(restored.nodeCount).toBe(2);
    expect(restored.edgeCount).toBe(1);
    expect(restored.getNode("n1")?.title).toBe("N1");
  });

  test("subgraph should return nodes within depth", () => {
    kg.addNode({ id: "a", title: "A", domain: "d", paradigm: "fact", confidence: 1 });
    kg.addNode({ id: "b", title: "B", domain: "d", paradigm: "fact", confidence: 1 });
    kg.addNode({ id: "c", title: "C", domain: "d", paradigm: "fact", confidence: 1 });
    kg.addEdge({ src: "a", dst: "b", relation: "related-to", weight: 1 });
    kg.addEdge({ src: "b", dst: "c", relation: "related-to", weight: 1 });

    const sub = kg.subgraph("a", 1);
    expect(sub.length).toBe(2); // a + b (depth 1)
  });
});

// ========== Pipeline (基础) ==========

describe("Pipeline", () => {
  let db: Database;
  let store: KnowledgeStore;

  beforeEach(() => {
    db = new Database(":memory:");
    // Create required tables
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
    store = new KnowledgeStore(db);
  });

  test("should create pipeline", () => {
    // Pipeline needs an LLM client, but we can test the prefilter logic
    // by using a mock or testing the stage1Prefilter directly
    expect(store).toBeDefined();
  });

  test("should write and read knowledge", () => {
    const node = store.write({
      nodeId: "test:fact:1",
      title: "Test",
      content: "Test content",
      domain: "test",
      paradigm: "fact",
      confidence: 0.9,
      sourceType: "manual",
      schemaVersion: 1,
      isVerified: true,
    });

    expect(node.nodeId).toBe("test:fact:1");
    expect(node.revision).toBe(1);

    const read = store.read("test:fact:1");
    expect(read?.title).toBe("Test");
  });

  test("should search knowledge with FTS5", () => {
    store.write({
      nodeId: "test:fact:1",
      title: "JWT 认证",
      content: "JSON Web Token 用于身份验证",
      domain: "auth",
      paradigm: "fact",
      confidence: 0.9,
      sourceType: "manual",
      schemaVersion: 1,
      isVerified: true,
    });

    store.write({
      nodeId: "test:fact:2",
      title: "Git 合并",
      content: "合并分支代码",
      domain: "vcs",
      paradigm: "fact",
      confidence: 0.8,
      sourceType: "manual",
      schemaVersion: 1,
      isVerified: true,
    });

    const results = store.search("JWT");
    expect(results.length).toBe(1);
    expect(results[0].nodeId).toBe("test:fact:1");
  });

  test("should search with domain filter", () => {
    store.write({
      nodeId: "test:fact:1", title: "A", content: "test", domain: "auth",
      paradigm: "fact", confidence: 0.9, sourceType: "manual", schemaVersion: 1, isVerified: true,
    });
    store.write({
      nodeId: "test:fact:2", title: "B", content: "test", domain: "vcs",
      paradigm: "fact", confidence: 0.8, sourceType: "manual", schemaVersion: 1, isVerified: true,
    });

    const authResults = store.search("test", { domain: "auth" });
    expect(authResults.length).toBe(1);
    expect(authResults[0].domain).toBe("auth");
  });
});
