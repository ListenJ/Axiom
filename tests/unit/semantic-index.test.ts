/**
 * 语义索引写入腿 + 查询腿（切片 4 剩余部分）
 *
 * 全程离线：embedder 由本文件注入（假实现），**不发起任何网络请求**。
 */
import { describe, it, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { indexNodeEmbeddings, recallBySimilarity, MAX_EMBED_TEXT_CHARS } from "../../src/knowledge/semantic-index.js";
import { EMBEDDING_TABLE, countEmbeddings } from "../../src/knowledge/embedding-store.js";

const MODEL = "test-model";

function freshDb(): Database {
  return new Database(":memory:");
}

function tableExists(db: Database): boolean {
  const row = db.query("SELECT name FROM sqlite_master WHERE type='table' AND name = ?").get(EMBEDDING_TABLE);
  return Boolean(row);
}

/** 固定词表向量：把文本映射为已知向量（确定性，无模型） */
function mapEmbedder(map: Record<string, number[]>, counter?: { n: number }) {
  return async (texts: string[]): Promise<number[][]> => {
    if (counter) counter.n++;
    return texts.map((t) => map[t] ?? [0, 0, 0]);
  };
}

describe("语义索引 · 未授权（embedder=null）", () => {
  it("写入腿零调用、不建表", async () => {
    const db = freshDb();
    const stats = await indexNodeEmbeddings(
      { db, embedder: null, model: MODEL, now: 1 },
      [{ nodeId: "n1", content: "x" }],
    );
    expect(stats).toEqual({ indexed: 0, failed: 0, dim: 0, model: MODEL });
    expect(tableExists(db)).toBe(false);
    db.close();
  });

  it("查询腿零调用、零候选", async () => {
    const db = freshDb();
    const out = await recallBySimilarity({ db, embedder: null, model: MODEL, query: "x" });
    expect(out.used).toBe(false);
    expect(out.candidates).toEqual([]);
    expect(out.scanned).toBe(0);
    expect(tableExists(db)).toBe(false);
    db.close();
  });
});

describe("语义索引 · 写入腿", () => {
  it("嵌入并落库；同 nodeId 重复摄取幂等（不产生第二行）", async () => {
    const db = freshDb();
    const embedder = mapEmbedder({ a: [1, 0, 0], b: [0, 1, 0] });
    const s1 = await indexNodeEmbeddings(
      { db, embedder, model: MODEL, now: 10 },
      [{ nodeId: "n1", content: "a" }, { nodeId: "n2", content: "b" }],
    );
    expect(s1).toEqual({ indexed: 2, failed: 0, dim: 3, model: MODEL });
    expect(countEmbeddings(db, MODEL)).toBe(2);

    const s2 = await indexNodeEmbeddings(
      { db, embedder, model: MODEL, now: 11 },
      [{ nodeId: "n1", content: "a" }],
    );
    expect(s2.indexed).toBe(1);
    expect(countEmbeddings(db, MODEL)).toBe(2); // 覆盖，不是新增
    db.close();
  });

  it("embedder 返回条数不符 ⇒ failed 报数且**一条都不写**（不静默）", async () => {
    const db = freshDb();
    const bad = async () => [[1, 0, 0]];
    const s = await indexNodeEmbeddings(
      { db, embedder: bad, model: MODEL, now: 1 },
      [{ nodeId: "n1", content: "a" }, { nodeId: "n2", content: "b" }],
    );
    expect(s.indexed).toBe(0);
    expect(s.failed).toBe(2);
    expect(countEmbeddings(db, MODEL)).toBe(0);
    db.close();
  });

  it("同一批里维度不一致 ⇒ 不一致的那条不写（避免混维度入库）", async () => {
    const db = freshDb();
    const embedder = async (texts: string[]) => texts.map((t) => (t === "a" ? [1, 0, 0] : [1, 0]));
    const s = await indexNodeEmbeddings(
      { db, embedder, model: MODEL, now: 1 },
      [{ nodeId: "n1", content: "a" }, { nodeId: "n2", content: "b" }],
    );
    expect(s.indexed).toBe(1);
    expect(s.failed).toBe(1);
    expect(countEmbeddings(db, MODEL)).toBe(1);
    db.close();
  });

  it("超长内容按 MAX_EMBED_TEXT_CHARS 截断后送嵌入（防止整批顶过服务字符上限）", async () => {
    const db = freshDb();
    const seen: number[] = [];
    const embedder = async (texts: string[]) => {
      seen.push(...texts.map((t) => t.length));
      return texts.map(() => [1, 0, 0]);
    };
    const long = "x".repeat(MAX_EMBED_TEXT_CHARS + 5000);
    const s = await indexNodeEmbeddings(
      { db, embedder, model: MODEL, now: 1 },
      [{ nodeId: "n1", content: long }],
    );
    expect(s.indexed).toBe(1);
    expect(seen).toEqual([MAX_EMBED_TEXT_CHARS]);
    db.close();
  });

  it("embedder 抛错 ⇒ 降级为 failed 报数，不向上抛", async () => {
    const db = freshDb();
    const boom = async () => { throw new Error("network down"); };
    const s = await indexNodeEmbeddings(
      { db, embedder: boom, model: MODEL, now: 1 },
      [{ nodeId: "n1", content: "a" }],
    );
    expect(s.indexed).toBe(0);
    expect(s.failed).toBe(1);
    db.close();
  });
});

describe("语义索引 · 查询腿", () => {
  it("查询文本同样按 MAX_EMBED_TEXT_CHARS 截断（写读同口径）", async () => {
    const db = freshDb();
    const seen: number[] = [];
    const embedder = async (texts: string[]) => {
      seen.push(...texts.map((t) => t.length));
      return texts.map(() => [1, 0, 0]);
    };
    await indexNodeEmbeddings({ db, embedder, model: MODEL, now: 1 }, [{ nodeId: "n1", content: "a" }]);
    seen.length = 0;
    await recallBySimilarity({ db, embedder, model: MODEL, query: "q".repeat(MAX_EMBED_TEXT_CHARS + 10) });
    expect(seen).toEqual([MAX_EMBED_TEXT_CHARS]);
    db.close();
  });

  /** 按给定顺序逐条写入（每条单独一次调用 ⇒ 显式控制表中的插入顺序） */
  async function seeded(order: string[], vec: Record<string, number[]>) {
    const db = freshDb();
    for (const k of order) {
      await indexNodeEmbeddings({ db, embedder: mapEmbedder(vec), model: MODEL, now: 1 }, [{ nodeId: k, content: k }]);
    }
    return db;
  }

  it("召回语义相近、词面不重合的节点（候选只做召回，不决定最终排序）", async () => {
    const vec: Record<string, number[]> = {
      "连接池耗尽导致超时": [0, 1, 0],
      "内存只增不减": [1, 0, 0],
      "磁盘满了": [0, 0, 1],
      "内存泄漏怎么排查": [1, 0, 0],
    };
    const db = await seeded(["连接池耗尽导致超时", "内存只增不减", "磁盘满了"], vec);
    const out = await recallBySimilarity({
      db, embedder: mapEmbedder(vec), model: MODEL,
      query: "内存泄漏怎么排查", topK: 2,
    });
    expect(out.used).toBe(true);
    expect(out.scanned).toBe(3);
    expect(out.candidates.map((c) => c.id)).toEqual(["内存只增不减"]);
    db.close();
  });

  it("同分按 node_id 码元升序 ⇒ **不依赖 Map 遍历顺序**（不同插入序结果一致）", async () => {
    const vec: Record<string, number[]> = {
      q: [1, 0, 0], "a-node": [1, 0, 0], "b-node": [1, 0, 0], "c-node": [1, 0, 0],
    };
    const a = await seeded(["b-node", "a-node", "c-node"], vec); // 插入序 1
    const b = await seeded(["c-node", "a-node", "b-node"], vec); // 插入序 2
    const outA = await recallBySimilarity({ db: a, embedder: mapEmbedder(vec), model: MODEL, query: "q" });
    const outB = await recallBySimilarity({ db: b, embedder: mapEmbedder(vec), model: MODEL, query: "q" });
    // 三节点向量完全相同 ⇒ 余弦同分 ⇒ 只能靠 node_id 升序决定
    expect(outA.candidates.map((c) => c.id)).toEqual(["a-node", "b-node", "c-node"]);
    expect(outB.candidates.map((c) => c.id)).toEqual(outA.candidates.map((c) => c.id));
    a.close(); b.close();
  });

  it("低于阈值 ⇒ 无候选（used=false）", async () => {
    const vec: Record<string, number[]> = { "磁盘满了": [0, 0, 1], q: [0, 1, 0] };
    const db = await seeded(["磁盘满了"], vec);
    const out = await recallBySimilarity({
      db, embedder: mapEmbedder(vec), model: MODEL, query: "q",
    });
    expect(out.used).toBe(false);
    expect(out.candidates).toEqual([]);
    expect(out.scanned).toBe(1);
    db.close();
  });

  it("确定性：同输入 5 次候选序列完全一致", async () => {
    const vec: Record<string, number[]> = { q: [1, 1, 1], a: [1, 1, 0], b: [1, 1, 0], c: [1, 1, 0] };
    const db = await seeded(["a", "b", "c"], vec);
    const runs: string[] = [];
    for (let i = 0; i < 5; i++) {
      const out = await recallBySimilarity({ db, embedder: mapEmbedder(vec), model: MODEL, query: "q" });
      runs.push(JSON.stringify(out.candidates));
    }
    for (const r of runs) expect(r).toEqual(runs[0]);
    db.close();
  });

  it("旧库（无该表）⇒ 自动建表并返回空候选，不抛错", async () => {
    const db = freshDb();
    const out = await recallBySimilarity({ db, embedder: mapEmbedder({ q: [1, 0, 0] }), model: MODEL, query: "q" });
    expect(out.error).toBeUndefined();
    expect(out.candidates).toEqual([]);
    expect(out.scanned).toBe(0);
    expect(tableExists(db)).toBe(true);
    db.close();
  });

  it("embedder 抛错 ⇒ 降级无候选，不抛错", async () => {
    const db = await seeded(["a"], { a: [1, 0, 0] });
    const boom = async () => { throw new Error("rate limited"); };
    const out = await recallBySimilarity({ db, embedder: boom, model: MODEL, query: "q" });
    expect(out.used).toBe(false);
    expect(out.scanned).toBe(1);
    db.close();
  });
});
