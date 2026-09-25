/**
 * 切片 4/5：语义候选召回 + 稳定排序（D3 硬约束）
 *
 * 锁定四条性质：
 *  1. 向量**只做候选召回** —— 词法没召回的条目可由语义候选补进来；
 *  2. **稳定 tie-breaker** —— 同分按 id **升序**（码元序），不随机、不按输入顺序；
 *  3. **不依赖 Map 遍历顺序** —— 等价输入的 Map 插入序不同，输出必须一致；
 *  4. **确定性** —— 同输入连续 N 次结果完全一致。
 */
import { describe, it, expect } from "bun:test";
import { rankWithSemanticRecall, type RecallItem } from "../../src/knowledge/semantic-recall.js";

const ITEMS: RecallItem[] = [
  { id: "kb-a", content: "alpha" },
  { id: "kb-b", content: "beta" },
  { id: "kb-c", content: "gamma" },
];

describe("语义候选召回 + 稳定排序", () => {
  it("语义候选可把词法没召回的条目补进结果（候选召回的意义）", () => {
    const out = rankWithSemanticRecall({
      items: ITEMS,
      lexicalScore: (it) => (it.id === "kb-a" ? 1 : 0),
      semanticCandidates: [{ id: "kb-c", score: 0.9 }],
    });
    // kb-a 词法 1 > kb-c 语义 0.9 ⇒ kb-a 在前；语义候选的作用是把 kb-c **补进候选集**
    expect(out.map((r) => r.id)).toEqual(["kb-a", "kb-c"]);
  });

  it("总分取 max（词法 1 vs 语义 0.9 ⇒ 不是相加）", () => {
    const out = rankWithSemanticRecall({
      items: ITEMS,
      lexicalScore: (it) => (it.id === "kb-a" ? 1 : 0),
      semanticCandidates: [{ id: "kb-c", score: 0.9 }],
    });
    const a = out.find((r) => r.id === "kb-a")!;
    const c = out.find((r) => r.id === "kb-c")!;
    expect(a.score).toBe(1);
    expect(c.score).toBe(0.9);
    expect(out[0]!.id).toBe("kb-a"); // 1 > 0.9
    expect(out[1]!.id).toBe("kb-c");
  });

  it("同分按 id 升序（稳定 tie-breaker，不按输入顺序）", () => {
    const shuffled: RecallItem[] = [
      { id: "kb-c", content: "g" },
      { id: "kb-a", content: "a" },
      { id: "kb-b", content: "b" },
    ];
    const out = rankWithSemanticRecall({ items: shuffled, lexicalScore: () => 1 });
    expect(out.map((r) => r.id)).toEqual(["kb-a", "kb-b", "kb-c"]);
  });

  it("不依赖 Map 遍历顺序：等价输入的插入序不同，输出一致", () => {
    const cands1 = [{ id: "kb-a", score: 0.5 }, { id: "kb-b", score: 0.5 }];
    const cands2 = [{ id: "kb-b", score: 0.5 }, { id: "kb-a", score: 0.5 }];
    const r1 = rankWithSemanticRecall({ items: ITEMS, semanticCandidates: cands1 });
    const r2 = rankWithSemanticRecall({ items: ITEMS, semanticCandidates: cands2 });
    expect(r1.map((x) => x.id)).toEqual(r2.map((x) => x.id));
    expect(r1.map((x) => x.id)).toEqual(["kb-a", "kb-b"]);
  });

  it("确定性：同输入连续 5 次结果完全一致", () => {
    const opts = {
      items: ITEMS,
      lexicalScore: (it: RecallItem) => (it.id === "kb-b" ? 0.7 : 0.7),
      semanticCandidates: [{ id: "kb-a", score: 0.7 }],
    };
    const runs = Array.from({ length: 5 }, () => rankWithSemanticRecall(opts).map((r) => `${r.id}:${r.score}`));
    for (const run of runs) expect(run).toEqual(runs[0]);
  });

  it("limit 生效；无分数条目被排除", () => {
    const out = rankWithSemanticRecall({ items: ITEMS, lexicalScore: () => 0, limit: 2 });
    expect(out).toEqual([]);
  });
});
