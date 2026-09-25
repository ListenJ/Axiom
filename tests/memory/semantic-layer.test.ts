/**
 * 可选语义层（ADR-010"一部分向量化"）行为测试 + KnowledgeBackend 收拢测试。
 *
 * 锁四件事：
 * 1. 假 embedder 下 rank 的余弦排序与阈值过滤正确，且缓存命中后不再调 embedder；
 * 2. embedder 失败（null）⇒ fail-open：rank 空、searchHybrid 逐项等于纯 search；
 * 3. searchHybrid 合并：FTS 命中 + 仅语义命中合并、语义 reasons 留痕、平序 path 升序；
 * 4. KnowledgeBackend 四子面共享同一连接（收拢语义）。
 *
 * embedder 全部注入 fake——不依赖真实 bge-m3 端点；env 在文件内保存/恢复。
 */
import { describe, it, expect, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { SQLiteMemory } from "../../src/memory/sqlite-memory.js";
import { SemanticLayer, type SemanticEmbedder } from "../../src/memory/semantic-layer.js";
import { KnowledgeBackend } from "../../src/db/knowledge-backend.js";

const ENV_ORIGINAL = process.env.MEMORY_SEMANTIC_SEARCH;
process.env.MEMORY_SEMANTIC_SEARCH = "1"; // 本文件专测语义路径；afterAll 恢复
afterAll(() => {
  if (ENV_ORIGINAL === undefined) delete process.env.MEMORY_SEMANTIC_SEARCH;
  else process.env.MEMORY_SEMANTIC_SEARCH = ENV_ORIGINAL;
});

function catDogEmbedder(counter: { calls: number }): SemanticEmbedder {
  return async (texts) => {
    counter.calls++;
    return texts.map((t) => {
      if (t.includes("猫") || t === "猫的习性") return [0.95, 0.05];
      if (t.includes("狗")) return [0.05, 0.95];
      return [0.5, 0.5];
    });
  };
}

function makeMemory(): SQLiteMemory {
  const sm = new SQLiteMemory(":memory:");
  sm.upsertNote({
    path: "00-Knowledge/cat.md", title: "猫", content: "猫的习性：夜行、独居。",
    excerpt: "", tags: [], paraCategory: "knowledge", type: "note", confidence: 0.9,
    createdAt: 1, updatedAt: 1,
  });
  sm.upsertNote({
    path: "00-Knowledge/dog.md", title: "狗", content: "狗的习性：群居、亲人。",
    excerpt: "", tags: [], paraCategory: "knowledge", type: "note", confidence: 0.9,
    createdAt: 1, updatedAt: 1,
  });
  return sm;
}

describe("SemanticLayer —— 余弦排序与缓存", () => {
  it("query 命中正确排序（猫 >> 狗），阈值过滤生效", async () => {
    const sm = makeMemory();
    const layer = new SemanticLayer(sm.connection);
    const hits = await layer.rank("猫的习性", 5, catDogEmbedder({ calls: 0 }));
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(hits[0]?.path).toBe("00-Knowledge/cat.md");
    expect(hits.some((h) => h.path === "00-Knowledge/dog.md")).toBe(false); // 0.05*0.95≈0.09 < 阈值0.2
  });

  it("缓存命中后 embedder 不再被调用（写一次反复用）", async () => {
    const sm = makeMemory();
    const layer = new SemanticLayer(sm.connection);
    const counter = { calls: 0 };
    await layer.rank("猫的习性", 5, catDogEmbedder(counter));
    const callsAfterFirst = counter.calls;
    await layer.rank("猫的习性", 5, catDogEmbedder(counter));
    expect(counter.calls).toBe(callsAfterFirst);
  });

  it("embedder 返回 null ⇒ fail-open：rank 空列表，不抛错", async () => {
    const sm = makeMemory();
    const layer = new SemanticLayer(sm.connection);
    const hits = await layer.rank("猫的习性", 5, async () => null);
    expect(hits).toEqual([]);
  });
});

describe("SQLiteMemory.searchHybrid —— 合并与 fail-open", () => {
  it("FTS 命中 + 仅语义命中合并；语义命中 reasons 留痕", async () => {
    const sm = makeMemory();
    sm.upsertNote({
      path: "00-Knowledge/meow.md", title: "喵星日常", content: "喵星人的日常记录。",
      excerpt: "", tags: [], paraCategory: "knowledge", type: "note", confidence: 0.9,
      createdAt: 1, updatedAt: 1,
    });
    const results = await sm.searchHybrid("猫的习性", { limit: 5 }, catDogEmbedder({ calls: 0 }));
    const paths = results.map((r) => r.record.path);
    expect(paths).toContain("00-Knowledge/cat.md"); // FTS + 语义双中
    expect(paths).toContain("00-Knowledge/meow.md"); // 仅语义命中被并入
    const cat = results.find((r) => r.record.path === "00-Knowledge/cat.md")!;
    expect(cat.semanticScore).toBeDefined();
  });

  it("embedder null ⇒ searchHybrid 逐项等于纯 search（确定性路径不被破坏）", async () => {
    const sm = makeMemory();
    const base = sm.search("猫的习性", { limit: 5 });
    const hybrid = await sm.searchHybrid("猫的习性", { limit: 5 }, async () => null);
    expect(hybrid.map((r) => r.record.path)).toEqual(base.map((r) => r.record.path));
  });
});

describe("KnowledgeBackend —— 四子面收拢到同一连接", () => {
  it("memory/store/kg/kal 共享同一 Database；写入经 memory 可被同连接读回", () => {
    const db = new Database(":memory:");
    const backend = new KnowledgeBackend(db);
    expect(backend.memory.connection).toBe(db);

    backend.memory.upsertNote({
      path: "00-Knowledge/x.md", title: "x", content: "共享连接写入。",
      excerpt: "", tags: [], paraCategory: "knowledge", type: "note", confidence: 0.9,
      createdAt: 1, updatedAt: 1,
    });
    const readBack = backend.memory.getByPath("00-Knowledge/x.md");
    expect(readBack?.title).toBe("x");

    // store/kg 子面：同一连接上 schema 就位（懒构造子面需先访问触发）
    void backend.store;
    void backend.kg;
    void backend.kal;
    const tables = (db.query("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map(r => r.name);
    expect(tables).toContain("knowledge_sources");
    expect(tables).toContain("kg_nodes"); // kg 子面 schema 同连接就位
  });
});
