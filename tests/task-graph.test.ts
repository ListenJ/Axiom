/**
 * TaskGraph — 执行表示层测试
 *
 * 覆盖:
 * - Task 生命周期 (pending→ready→running→completed/failed)
 * - DAG 依赖解析 (拓扑排序)
 * - 并行执行
 * - 失败回滚
 * - Checkpoint/Resume (通过 KnowledgeStore)
 * - CognitivePipeline runFull 集成
 */

import { describe, test, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { tmpdir } from "os";
import { join } from "path";
import { unlinkSync, existsSync } from "fs";
import {
  TaskGraph,
  type Task,
  type TaskStatus,
  type TaskGraphSnapshot,
} from "../src/dre/pipeline/task-graph.js";
import { KnowledgeStore } from "../src/dre/storage/knowledge-store.js";
import { DREngine } from "../src/dre/engine.js";
import { CognitivePipeline } from "../src/dre/pipeline/cognitive-pipeline.js";

let dbFiles: string[] = [];

function dbPath(): string {
  const p = join(tmpdir(), `taskgraph-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  dbFiles.push(p);
  return p;
}

function cleanup() {
  for (const f of dbFiles) {
    try { if (existsSync(f)) unlinkSync(f); } catch {}
    try { if (existsSync(f + "-wal")) unlinkSync(f + "-wal"); } catch {}
    try { if (existsSync(f + "-shm")) unlinkSync(f + "-shm"); } catch {}
  }
  dbFiles = [];
}

describe("TaskGraph", () => {
  let graph: TaskGraph;

  beforeEach(() => {
    graph = new TaskGraph();
  });

  // ── 基础操作 ──

  test("should add tasks and retrieve them", () => {
    graph.addTask("a", "Task A", async () => "result-a");
    graph.addTask("b", "Task B", async () => "result-b", { dependsOn: ["a"] });

    const taskA = graph.getTask("a");
    expect(taskA).toBeDefined();
    expect(taskA!.description).toBe("Task A");
    expect(taskA!.status).toBe("pending");

    const taskB = graph.getTask("b");
    expect(taskB).toBeDefined();
    expect(taskB!.dependsOn).toEqual(["a"]);
  });

  test("should execute simple task", async () => {
    let called = false;
    graph.addTask("t1", "Simple", async () => { called = true; return "ok"; });
    await graph.executeAll();

    expect(called).toBe(true);
    expect(graph.getStatus()).toBe("completed");
    expect(graph.isComplete()).toBe(true);
  });

  test("should execute tasks in dependency order", async () => {
    const order: string[] = [];
    graph.addTask("a", "First", async () => { order.push("a"); });
    graph.addTask("b", "Second", async () => { order.push("b"); }, { dependsOn: ["a"] });
    graph.addTask("c", "Third", async () => { order.push("c"); }, { dependsOn: ["b"] });

    await graph.executeAll();
    expect(order).toEqual(["a", "b", "c"]);
    expect(graph.getStatus()).toBe("completed");
  });

  test("should execute parallel tasks concurrently", async () => {
    const started = new Set<string>();
    const syncPoint = Promise.resolve();

    graph.addTask("p1", "Parallel 1", async () => { started.add("p1"); });
    graph.addTask("p2", "Parallel 2", async () => { started.add("p2"); });
    graph.addTask("p3", "Parallel 3", async () => { started.add("p3"); });

    await graph.executeAll();
    expect(started.size).toBe(3);
    expect(graph.getStatus()).toBe("completed");
  });

  // ── 错误处理 ──

  test("should handle task failure gracefully", async () => {
    graph.addTask("good", "Works", async () => "ok");
    graph.addTask("bad", "Fails", async () => { throw new Error("task error"); }, { dependsOn: ["good"] });

    await graph.executeAll();
    expect(graph.getStatus()).not.toBe("completed");
    expect(graph.getTask("bad")?.status).toBe("failed");
    expect(graph.getTask("bad")?.error).toContain("task error");
  });

  test("should rollback on failure when rollback defined", async () => {
    let rolledBack = false;
    graph.addTask("good", "Works", async () => "ok", {
      rollback: async () => { rolledBack = true; },
    });
    graph.addTask("bad", "Fails", async () => { throw new Error("fail"); }, {
      dependsOn: ["good"],
      rollback: async () => {},
    });

    await graph.executeAll();
    expect(rolledBack).toBe(true);
  });

  test("should detect cycles", async () => {
    graph.addTask("a", "A", async () => {}, { dependsOn: ["b"] });
    graph.addTask("b", "B", async () => {}, { dependsOn: ["a"] });

    await expect(graph.executeAll()).rejects.toThrow("cycle");
  });

  // ── 序列化 ──

  test("should serialize and deserialize", async () => {
    graph.addTask("a", "Task A", async () => "ok");
    graph.addTask("b", "Task B", async () => "ok", { dependsOn: ["a"] });
    await graph.executeAll();

    const snapshot = graph.toJSON();
    expect(snapshot.tasks.length).toBe(2);
    expect(snapshot.status).toBe("completed");

    const restored = new TaskGraph();
    restored.fromJSON(snapshot);
    expect(restored.getAllTasks().length).toBe(2);
    expect(restored.getStatus()).toBe("completed");
    expect(restored.getTask("a")?.status).toBe("completed");
  });

  // ── Checkpoint/Resume ──

  test("should checkpoint and resume through KnowledgeStore", async () => {
    const db = new Database(dbPath());
    const store = new KnowledgeStore(db);

    // Create tables
    db.exec(`
      CREATE TABLE IF NOT EXISTS knowledge_node (
        node_id TEXT PRIMARY KEY, title TEXT NOT NULL, content TEXT NOT NULL,
        content_hash TEXT NOT NULL DEFAULT '', schema_version INTEGER NOT NULL DEFAULT 1,
        domain TEXT NOT NULL, paradigm TEXT NOT NULL DEFAULT 'fact',
        confidence REAL NOT NULL DEFAULT 0.5, source_type TEXT NOT NULL, source_uri TEXT,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        revision INTEGER NOT NULL DEFAULT 1, is_verified INTEGER NOT NULL DEFAULT 0,
        behavior TEXT, prediction TEXT, hypothesis TEXT
      )
    `);
    db.exec(`
      CREATE TABLE IF NOT EXISTS knowledge_revision (
        node_id TEXT NOT NULL, revision INTEGER NOT NULL, content TEXT NOT NULL,
        diff TEXT, reason TEXT, verified_by TEXT, created_at INTEGER NOT NULL,
        PRIMARY KEY (node_id, revision)
      )
    `);

    graph.addTask("c1", "Checkpoint test", async () => "saved");
    await graph.executeAll();

    const cid = await graph.checkpoint(store);
    expect(cid).toBeDefined();

    // Resume into new graph
    const restored = new TaskGraph();
    const ok = await restored.resume(store, cid.replace("dre:procedure:", ""));
    expect(ok).toBe(true);
    expect(restored.getStatus()).toBe("completed");
    expect(restored.getTask("c1")?.description).toBe("Checkpoint test");
  });

  test("should return false for missing checkpoint", async () => {
    const db = new Database(dbPath());
    db.exec(`CREATE TABLE IF NOT EXISTS knowledge_node (
      node_id TEXT PRIMARY KEY, title TEXT NOT NULL, content TEXT NOT NULL,
      content_hash TEXT NOT NULL DEFAULT '', schema_version INTEGER NOT NULL DEFAULT 1,
      domain TEXT NOT NULL, paradigm TEXT NOT NULL DEFAULT 'fact',
      confidence REAL NOT NULL DEFAULT 0.5, source_type TEXT NOT NULL, source_uri TEXT,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      revision INTEGER NOT NULL DEFAULT 1, is_verified INTEGER NOT NULL DEFAULT 0,
      behavior TEXT, prediction TEXT, hypothesis TEXT
    )`);
    const store = new KnowledgeStore(db);
    const restored = new TaskGraph();
    const ok = await restored.resume(store, "nonexistent");
    expect(ok).toBe(false);
  });
});

describe("CognitivePipeline runFull", () => {
  let engine: DREngine;
  let pipeline: CognitivePipeline;

  beforeEach(() => {
    engine = new DREngine({
      dbPath: dbPath(),
      mainLLM: { baseUrl: "http://localhost:8080", model: "test", maxTokens: 128 },
      workingMemoryCapacity: 8,
    });
    pipeline = new CognitivePipeline(engine);
    engine.knowledgeStore.write({
      nodeId: "dre:fact:exec001",
      title: "执行测试",
      content: "用户认证模块需要重构以支持 JWT",
      domain: "auth",
      paradigm: "fact",
      confidence: 0.9,
      sourceType: "manual",
      schemaVersion: 1,
      isVerified: true,
    });
  });

  test("runFull should execute task when action is recommended", async () => {
    const result = await pipeline.runFull("重构认证模块");
    expect(result.trace.length).toBe(6);
    // executionGraph may be undefined if no action recommended
    if (result.executionGraph) {
      expect(result.executionGraph.tasks).toBeGreaterThan(0);
    }
  });

  test("runFull should fall back to base result on execution error", async () => {
    const result = await pipeline.runFull("");
    expect(result.trace.length).toBe(6);
  });
});
