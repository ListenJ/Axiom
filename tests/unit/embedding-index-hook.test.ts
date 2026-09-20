/**
 * 写入侧 → 向量索引的**推送钩子**（2026-09-21）
 *
 * 覆盖：
 *  1. 未注入 ⇒ 立即返回（默认零成本）、不抛；
 *  2. 注入后 ⇒ 收到**正确的 nodeId 与内容**；清除后不再被调用；
 *  3. 实现抛错 ⇒ 钩子**永不抛**（写路径不受影响）；
 *  4. 装配函数 `createKnowledgeEmbeddingIndexer` 继承 `indexFreshNodes` 的门控：
 *     未授权 ⇒ **不调 embedder、不碰库**（用已关闭句柄探针）；已授权 ⇒ 真的写库；
 *  5. **写入方确实在喊**（行为级）：`VaultManager.writeNote` 与 `KnowledgeStore.write`
 *     都会把刚写入的单元推给钩子；`KGWriter.writeAST` 产出 `indexable` 供 MCP 工具推送。
 *
 * 全程离线：假索引器 / 假 embedder；不涉及网络。
 */
import { describe, test, expect, afterAll } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Database } from "bun:sqlite";
import {
  createKnowledgeEmbeddingIndexer,
  hasKnowledgeEmbeddingIndexer,
  notifyKnowledgeWritten,
  setKnowledgeEmbeddingIndexer,
} from "../../src/services/knowledge-index-hook.js";
import { enableKnowledgeEmbeddingIndex } from "../../src/services/knowledge-embedding-index.js";
import { vaultNoteNodeId, dreKnowledgeNodeId } from "../../src/kal/knowledge-node-id.js";
import { VaultManager } from "../../src/memory/vault-manager.js";
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
  setKnowledgeEmbeddingIndexer(null);
  try { fs.rmSync(tmpVault, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe("推送钩子：装配与降级", () => {
  test("1) 未注入 ⇒ 立即返回且不抛", async () => {
    setKnowledgeEmbeddingIndexer(null);
    expect(hasKnowledgeEmbeddingIndexer()).toBe(false);
    await expect(notifyKnowledgeWritten([{ nodeId: "x", content: "y" }])).resolves.toBeUndefined();
  });

  test("2) 注入 ⇒ 收到正确入参；清除后不再调用", async () => {
    const seen: Array<readonly { nodeId: string; content: string }[]> = [];
    setKnowledgeEmbeddingIndexer(async (nodes) => {
      seen.push(nodes);
    });
    expect(hasKnowledgeEmbeddingIndexer()).toBe(true);
    await notifyKnowledgeWritten([{ nodeId: "kg:a", content: "A body" }]);
    expect(seen.length).toBe(1);
    expect(seen[0]![0]).toEqual({ nodeId: "kg:a", content: "A body" });

    setKnowledgeEmbeddingIndexer(null);
    await notifyKnowledgeWritten([{ nodeId: "kg:b", content: "B body" }]);
    expect(seen.length).toBe(1); // 未被再调用
  });

  test("3) 实现抛错 ⇒ 永不抛（写路径不受影响）", async () => {
    setKnowledgeEmbeddingIndexer(async () => {
      throw new Error("indexer exploded");
    });
    await expect(notifyKnowledgeWritten([{ nodeId: "x", content: "y" }])).resolves.toBeUndefined();
    setKnowledgeEmbeddingIndexer(null);
  });

  test("4) 装配实现继承门控：未授权不碰库；已授权真的写库", async () => {
    const closed = new Database(":memory:");
    closed.close();
    let calls = 0;
    const embedder = async (texts: string[]) => {
      calls += 1;
      return texts.map(() => [1, 0, 0]);
    };

    // (a) 未授权 ⇒ 不碰库、不调模型（closed 句柄若被读会抛 ⇒ 被收敛进日志，不会抛给调用方）
    const unauthorized = createKnowledgeEmbeddingIndexer(closed, {
      embeddings: embedder,
      resolveModelTag: () => MODEL,
      consent: () => "ask",
      now: 1,
    });
    setKnowledgeEmbeddingIndexer(unauthorized);
    await notifyKnowledgeWritten([{ nodeId: "x", content: "y" }]);
    expect(calls).toBe(0);

    // (b) 已授权 ⇒ 真的写入
    const db = new Database(":memory:");
    const authorized = createKnowledgeEmbeddingIndexer(db, {
      embeddings: embedder,
      resolveModelTag: () => MODEL,
      consent: () => "yes",
      now: 1,
    });
    setKnowledgeEmbeddingIndexer(authorized);
    await notifyKnowledgeWritten([{ nodeId: "vault:note:a", content: "hello" }]);
    expect(calls).toBe(1);
    const row = db.query("SELECT node_id, dim FROM knowledge_embeddings WHERE node_id = ?").get("vault:note:a");
    expect(row).toEqual({ node_id: "vault:note:a", dim: 3 });
    db.close();
    setKnowledgeEmbeddingIndexer(null);
  });

  test("5) enableKnowledgeEmbeddingIndex(disable) 可清除装配", () => {
    setKnowledgeEmbeddingIndexer(async () => {});
    expect(hasKnowledgeEmbeddingIndexer()).toBe(true);
    enableKnowledgeEmbeddingIndex(new Database(":memory:"), { disable: true });
    expect(hasKnowledgeEmbeddingIndexer()).toBe(false);
  });
});

describe("写入方确实在喊（行为级）", () => {
  test("6) VaultManager.writeNote 推送本笔记（nodeId 与索引口径一致）", async () => {
    const seen: Array<{ nodeId: string; content: string }> = [];
    setKnowledgeEmbeddingIndexer(async (nodes) => {
      for (const n of nodes) seen.push({ nodeId: n.nodeId, content: n.content });
    });
    const vm = new VaultManager({ vaultPath: tmpVault, dbPath: ":memory:" });
    await vm.writeNote("03-Resources/hook-test.md", "hello hook world");
    setKnowledgeEmbeddingIndexer(null);

    expect(seen.length).toBe(1);
    expect(seen[0]!.nodeId).toBe(vaultNoteNodeId("03-Resources/hook-test.md"));
    expect(seen[0]!.content).toContain("hello hook world");
  });

  test("7) KnowledgeStore.write 推送本条知识（dre nodeId）", async () => {
    const db = makeKnowledgeDb();
    const store = new KnowledgeStore(db);
    const seen: Array<{ nodeId: string; content: string }> = [];
    setKnowledgeEmbeddingIndexer(async (nodes) => {
      for (const n of nodes) seen.push({ nodeId: n.nodeId, content: n.content });
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
    // write() 是同步方法 ⇒ 钩子是 fire-and-forget，等一个微任务让 promise 完成
    await new Promise((r) => setTimeout(r, 0));
    setKnowledgeEmbeddingIndexer(null);

    expect(seen.length).toBe(1);
    expect(seen[0]!.nodeId).toBe(dreKnowledgeNodeId("storage", "kn-probe-1"));
    expect(seen[0]!.content).toContain("预写日志");
    db.close();
  });

  test("8) KGWriter.writeAST 产出 indexable（nodeId 即 kg_nodes.id）", () => {
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

  test("9) 组合根确实装配、MCP 写工具确实推送（文本级门禁，防「造了没人喊」）", () => {
    const root = path.resolve(import.meta.dir, "../..");
    const read = (rel: string) => fs.readFileSync(path.join(root, rel), "utf8");

    // 三个组合根都要装配（漏一个 ⇒ 该入口下写入不产生向量）
    for (const rel of ["src/main.ts", "src/mcp/server.ts", "src/mcp/kb-backend.ts"]) {
      expect(read(rel), `${rel} 未装配索引钩子`).toContain("enableKnowledgeEmbeddingIndex(db)");
    }
    // 写入方都要喊
    expect(read("src/memory/vault-manager.ts")).toContain("notifyKnowledgeWritten([");
    expect(read("src/dre/storage/knowledge-store.ts")).toContain("notifyKnowledgeWritten([");
    expect(read("src/mcp/server/kg-tools.ts")).toContain("notifyKnowledgeWritten(writeResult.indexable");
    // 真实依赖只能在组合层（knowledge 层不得 import router）
    const serviceSrc = read("src/services/knowledge-embedding-index.ts");
    expect(serviceSrc).toContain("router.embeddings(texts)");
    expect(serviceSrc).toContain("embeddingModelTagOf(findModelsForRole(\"embedding\"))");
  });
});
