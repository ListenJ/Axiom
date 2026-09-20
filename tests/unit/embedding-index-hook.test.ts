/**
 * 写入侧 → 向量索引的**推送钩子**：索引 + **删除同步**（2026-09-21）
 *
 * 覆盖：
 *  1. 未注入 ⇒ 写入/删除通知都立即返回（默认零成本）、不抛；
 *  2. 注入后 ⇒ 收到**正确的 nodeId 与内容**；清除后不再被调用；
 *  3. 实现抛错 ⇒ 钩子**永不抛**（写/删路径不受影响）；
 *  4. 装配 sink 的 `index` 继承 `indexFreshNodes` 的门控（未授权不碰库；已授权真的写库）；
 *  5. **删除同步**：sink.prune 真的删行；sink 未实现 prune ⇒ 空操作；prune 抛错 ⇒ 不抛；
 *  6. **写入/删除方确实在喊**（行为级）：`VaultManager.writeNote` 推送、`SQLiteMemory.deleteNote` 推送删除、
 *     `KnowledgeStore.write` 推送、`KGWriter.writeAST` 产出 `indexable`；
 *  7. 组合根装配 + MCP 工具推送的文本级门禁（防「造了没人喊」）。
 *
 * 全程离线：假 sink / 假 embedder；不涉及网络。
 */
import { describe, test, expect, afterAll } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Database } from "bun:sqlite";
import {
  createKnowledgeEmbeddingIndexer,
  hasKnowledgeIndexSink,
  notifyKnowledgeDeleted,
  notifyKnowledgeWritten,
  setKnowledgeIndexSink,
} from "../../src/services/knowledge-index-hook.js";
import { enableKnowledgeEmbeddingIndex } from "../../src/services/knowledge-embedding-index.js";
import { vaultNoteNodeId, dreKnowledgeNodeId } from "../../src/kal/knowledge-node-id.js";
import { ensureEmbeddingTable, upsertEmbedding } from "../../src/knowledge/embedding-store.js";
import { VaultManager } from "../../src/memory/vault-manager.js";
import { SQLiteMemory } from "../../src/memory/sqlite-memory.js";
import { KnowledgeStore } from "../../src/dre/storage/knowledge-store.js";
import { KGWriter } from "../../src/crawl/processor/kg-writer.js";
import { parseMarkdownAST } from "../../src/crawl/processor/markdown-ast.js";

const MODEL = "probe/embed-model";
const tmpVault = fs.mkdtempSync(path.join(os.tmpdir(), "hook-vault-"));

/** KnowledgeStore.write 需要 knowledge_node 表（schema 与 tests/coverage-gap 的夹具一致） */
function makeKnowledgeDb(): Database {
  const db = new Database(":memory:");
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
      hypothesis TEXT
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
  `);
  return db;
}

afterAll(() => {
  setKnowledgeIndexSink(null);
  try { fs.rmSync(tmpVault, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe("推送钩子：装配与降级", () => {
  test("1) 未注入 ⇒ 写入/删除通知都立即返回且不抛", async () => {
    setKnowledgeIndexSink(null);
    expect(hasKnowledgeIndexSink()).toBe(false);
    await expect(notifyKnowledgeWritten([{ nodeId: "x", content: "y" }])).resolves.toBeUndefined();
    await expect(notifyKnowledgeDeleted(["x"])).resolves.toBeUndefined();
  });

  test("2) 注入 ⇒ 收到正确入参；清除后不再调用", async () => {
    const seen: Array<readonly { nodeId: string; content: string }[]> = [];
    setKnowledgeIndexSink({ index: async (nodes) => { seen.push(nodes); } });
    expect(hasKnowledgeIndexSink()).toBe(true);
    await notifyKnowledgeWritten([{ nodeId: "kg:a", content: "A body" }]);
    expect(seen.length).toBe(1);
    expect(seen[0]![0]).toEqual({ nodeId: "kg:a", content: "A body" });

    setKnowledgeIndexSink(null);
    await notifyKnowledgeWritten([{ nodeId: "kg:b", content: "B body" }]);
    expect(seen.length).toBe(1); // 未被再调用
  });

  test("3) 实现抛错 ⇒ 永不抛（写/删路径不受影响）", async () => {
    setKnowledgeIndexSink({
      index: async () => { throw new Error("indexer exploded"); },
      prune: async () => { throw new Error("prune exploded"); },
    });
    await expect(notifyKnowledgeWritten([{ nodeId: "x", content: "y" }])).resolves.toBeUndefined();
    await expect(notifyKnowledgeDeleted(["x"])).resolves.toBeUndefined();
    setKnowledgeIndexSink(null);
  });

  test("4) 装配 sink 的 index 继承门控：未授权不碰库；已授权真的写库", async () => {
    const closed = new Database(":memory:");
    closed.close();
    let calls = 0;
    const embedder = async (texts: string[]) => {
      calls += 1;
      return texts.map(() => [1, 0, 0]);
    };

    // (a) 未授权 ⇒ 不碰库、不调模型
    setKnowledgeIndexSink(createKnowledgeEmbeddingIndexer(closed, {
      embeddings: embedder,
      resolveModelTag: () => MODEL,
      consent: () => "ask",
      now: 1,
    }));
    await notifyKnowledgeWritten([{ nodeId: "x", content: "y" }]);
    expect(calls).toBe(0);

    // (b) 已授权 ⇒ 真的写入
    const db = new Database(":memory:");
    setKnowledgeIndexSink(createKnowledgeEmbeddingIndexer(db, {
      embeddings: embedder,
      resolveModelTag: () => MODEL,
      consent: () => "yes",
      now: 1,
    }));
    await notifyKnowledgeWritten([{ nodeId: "vault:note:a", content: "hello" }]);
    expect(calls).toBe(1);
    const row = db.query("SELECT node_id, dim FROM knowledge_embeddings WHERE node_id = ?").get("vault:note:a");
    expect(row).toEqual({ node_id: "vault:note:a", dim: 3 });
    db.close();
    setKnowledgeIndexSink(null);
  });

  test("5a) 装配 sink 的 prune 真的删行；未实现 prune 时为空操作", async () => {
    const db = new Database(":memory:");
    ensureEmbeddingTable(db);
    upsertEmbedding(db, { nodeId: "vault:note:gone", model: MODEL, vector: [1, 0, 0] }, 1);
    upsertEmbedding(db, { nodeId: "vault:note:keep", model: MODEL, vector: [0, 1, 0] }, 1);

    setKnowledgeIndexSink(createKnowledgeEmbeddingIndexer(db, {
      embeddings: async (t) => t.map(() => [1, 0, 0]),
      resolveModelTag: () => MODEL,
      consent: () => "yes",
      now: 1,
    }));
    await notifyKnowledgeDeleted(["vault:note:gone"]);
    const left = db.query("SELECT node_id FROM knowledge_embeddings ORDER BY node_id").all();
    expect(left).toEqual([{ node_id: "vault:note:keep" }]);

    // sink 未实现 prune ⇒ 只跳过，不抛、不动库
    setKnowledgeIndexSink({ index: async () => {} });
    await expect(notifyKnowledgeDeleted(["vault:note:keep"])).resolves.toBeUndefined();
    expect(db.query("SELECT COUNT(*) AS c FROM knowledge_embeddings").get()).toEqual({ c: 1 });
    db.close();
    setKnowledgeIndexSink(null);
  });

  test("5b) enableKnowledgeEmbeddingIndex(disable) 可清除装配", () => {
    setKnowledgeIndexSink({ index: async () => {} });
    expect(hasKnowledgeIndexSink()).toBe(true);
    enableKnowledgeEmbeddingIndex(new Database(":memory:"), { disable: true });
    expect(hasKnowledgeIndexSink()).toBe(false);
  });
});

describe("写入/删除方确实在喊（行为级）", () => {
  test("6a) VaultManager.writeNote 推送本笔记（nodeId 与索引口径一致）", async () => {
    const seen: Array<{ nodeId: string; content: string }> = [];
    setKnowledgeIndexSink({
      index: async (nodes) => { for (const n of nodes) seen.push({ nodeId: n.nodeId, content: n.content }); },
    });
    const vm = new VaultManager({ vaultPath: tmpVault, dbPath: ":memory:" });
    await vm.writeNote("03-Resources/hook-test.md", "hello hook world");
    setKnowledgeIndexSink(null);

    expect(seen.length).toBe(1);
    expect(seen[0]!.nodeId).toBe(vaultNoteNodeId("03-Resources/hook-test.md"));
    expect(seen[0]!.content).toContain("hello hook world");
  });

  test("6b) SQLiteMemory.deleteNote 推送删除（nodeId 与索引口径一致）", async () => {
    const mem = new SQLiteMemory(":memory:");
    mem.upsertNote({
      path: "03-Resources/doomed.md",
      title: "doomed",
      content: "to be deleted",
      excerpt: "to be deleted",
      tags: [],
      paraCategory: "resources",
      type: "note",
      confidence: 1,
      createdAt: 1,
      updatedAt: 1,
    });
    const deleted: string[][] = [];
    setKnowledgeIndexSink({
      index: async () => {},
      prune: async (ids) => { deleted.push([...ids]); },
    });
    const ok = mem.deleteNote("03-Resources/doomed.md");
    await new Promise((r) => setTimeout(r, 0)); // deleteNote 是同步方法 ⇒ fire-and-forget，等一个微任务
    setKnowledgeIndexSink(null);
    mem.close();

    expect(ok).toBe(true);
    expect(deleted.length).toBe(1);
    expect(deleted[0]).toEqual([vaultNoteNodeId("03-Resources/doomed.md")]);
  });

  test("6c) KnowledgeStore.write 推送本条知识（dre nodeId）", async () => {
    const db = makeKnowledgeDb();
    const store = new KnowledgeStore(db);
    const seen: Array<{ nodeId: string; content: string }> = [];
    setKnowledgeIndexSink({
      index: async (nodes) => { for (const n of nodes) seen.push({ nodeId: n.nodeId, content: n.content }); },
    });

    store.write({
      nodeId: "kn-probe-1",
      title: "预写日志",
      content: "先落盘再改数据",
      domain: "storage",
      paradigm: "fact",
      confidence: 0.8,
      sourceType: "manual",
      schemaVersion: 1,
      isVerified: false,
    });
    await new Promise((r) => setTimeout(r, 0));
    setKnowledgeIndexSink(null);

    expect(seen.length).toBe(1);
    expect(seen[0]!.nodeId).toBe(dreKnowledgeNodeId("storage", "kn-probe-1"));
    expect(seen[0]!.content).toContain("预写日志");
    db.close();
  });

  test("6d) KGWriter.writeAST 产出 indexable（nodeId 即 kg_nodes.id）", () => {
    const db = new Database(":memory:");
    const writer = new KGWriter(db);
    const ast = parseMarkdownAST("# 标题\n\n正文内容\n\n## 小节\n\n更多内容\n");
    const res = writer.writeAST(ast, "ProbeDoc");
    expect(res.indexable).toBeDefined();
    expect(res.indexable!.length).toBeGreaterThan(0);
    for (const item of res.indexable!) {
      expect(item.nodeId.startsWith("kg:")).toBe(true);
      expect(item.content.length).toBeGreaterThan(0);
    }
    db.close();
  });

  test("7) 组合根确实装配、MCP 写工具确实推送（文本级门禁，防「造了没人喊」）", () => {
    const root = path.resolve(import.meta.dir, "../..");
    const read = (rel: string) => fs.readFileSync(path.join(root, rel), "utf8");

    for (const rel of ["src/main.ts", "src/mcp/server.ts", "src/mcp/kb-backend.ts"]) {
      expect(read(rel), `${rel} 未装配索引钩子`).toContain("enableKnowledgeEmbeddingIndex(db)");
    }
    expect(read("src/memory/vault-manager.ts")).toContain("notifyKnowledgeWritten([");
    expect(read("src/memory/sqlite-memory.ts")).toContain("notifyKnowledgeDeleted([");
    expect(read("src/dre/storage/knowledge-store.ts")).toContain("notifyKnowledgeWritten([");
    expect(read("src/mcp/server/kg-tools.ts")).toContain("notifyKnowledgeWritten(writeResult.indexable");
    const serviceSrc = read("src/services/knowledge-embedding-index.ts");
    expect(serviceSrc).toContain("router.embeddings(texts)");
    expect(serviceSrc).toContain("embeddingModelTagOf(findModelsForRole(\"embedding\"))");
  });
});
