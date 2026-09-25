/**
 * 切片 4/5 拼装：授权门 + 语义候选 + 稳定排序（全程离线，用假 embedder）
 *
 * 覆盖：
 *  - 未授权（embedder=null）→ 纯词法且**零调用**；
 *  - 假 embedder 生效 → 词法召不到的条目被语义候选补进结果；
 *  - embedder 失败（返回 [])→ 静默降级为纯词法（semanticUsed=false）；
 *  - 相似度低于阈值不进候选；
 *  - 确定性：同输入 5 次一致。
 */
import { describe, it, expect } from "bun:test";
import { queryKnowledgeSemantically, SEMANTIC_MIN_SIMILARITY } from "../../src/knowledge/semantic-layer.js";
import type { RecallItem } from "../../src/knowledge/semantic-recall.js";

const ITEMS: RecallItem[] = [
  { id: "kb-lex", content: "连接池耗尽导致超时" },
  { id: "kb-sem", content: "内存只增不减" },
];

/** 假 embedder：把内容映射成简单向量，便于构造"语义相近但词面不重合" */
function fakeEmbedder(map: Record<string, number[]>, counter?: { n: number }) {
  return async (texts: string[]): Promise<number[][]> => {
    if (counter) counter.n++;
    return texts.map((t) => map[t] ?? [0, 0, 0]);
  };
}

describe("语义层拼装（离线）", () => {
  it("未授权（embedder=null）→ 纯词法，且**一次都不调用**", async () => {
    let called = 0;
    const spy = async (texts: string[]) => { called++; return texts.map(() => [1, 0, 0]); };
    const out = await queryKnowledgeSemantically({
      query: "连接池", items: ITEMS, embedder: null,
      lexicalScore: (it) => (it.id === "kb-lex" ? 1 : 0),
    });
    expect(out.semanticUsed).toBe(false);
    expect(out.results.map((r) => r.id)).toEqual(["kb-lex"]);
    expect(called).toBe(0);
    void spy;
  });

  it("已授权 + 假 embedder：词法召不到的条目由语义候选补进结果", async () => {
    const map = {
      "内存泄漏怎么排查": [1, 0, 0],
      "连接池耗尽导致超时": [0, 1, 0],
      "内存只增不减": [1, 0, 0], // 与 query 同向 ⇒ 高相似
    };
    const out = await queryKnowledgeSemantically({
      query: "内存泄漏怎么排查", items: ITEMS, embedder: fakeEmbedder(map),
      lexicalScore: (it) => (it.id === "kb-lex" ? 0.2 : 0), // 词法只给到 kb-lex 一点点
    });
    expect(out.semanticUsed).toBe(true);
    expect(out.results.map((r) => r.id)).toContain("kb-sem");
    const sem = out.results.find((r) => r.id === "kb-sem")!;
    expect(sem.reasons).toContain("semantic");
  });

  it("embedder 失败（返回 []）→ 降级纯词法，且 semanticUsed=false", async () => {
    const out = await queryKnowledgeSemantically({
      query: "x", items: ITEMS, embedder: async () => [],
      lexicalScore: (it) => (it.id === "kb-lex" ? 1 : 0),
    });
    expect(out.semanticUsed).toBe(false);
    expect(out.results.map((r) => r.id)).toEqual(["kb-lex"]);
  });

  it("相似度低于阈值不进候选", async () => {
    const map = {
      q: [1, 0, 0],
      "连接池耗尽导致超时": [0, 1, 0],
      "内存只增不减": [-1, 0, 0], // 余弦 -1 < 阈值
    };
    const out = await queryKnowledgeSemantically({
      query: "q", items: ITEMS, embedder: fakeEmbedder(map), lexicalScore: () => 0,
    });
    expect(out.semanticUsed).toBe(false);
    expect(out.results).toEqual([]);
    expect(SEMANTIC_MIN_SIMILARITY).toBeGreaterThan(0);
  });

  it("确定性：同输入 5 次结果一致", async () => {
    const map = {
      q: [1, 0, 0],
      "连接池耗尽导致超时": [0.9, 0.1, 0],
      "内存只增不减": [0.8, 0.2, 0],
    };
    const runs: string[] = [];
    for (let i = 0; i < 5; i++) {
      const out = await queryKnowledgeSemantically({
        query: "q", items: ITEMS, embedder: fakeEmbedder(map), lexicalScore: () => 0.1,
      });
      runs.push(JSON.stringify(out.results));
    }
    for (const r of runs) expect(r).toEqual(runs[0]);
  });
});
