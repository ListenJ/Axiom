/**
 * 审计 M2（docs/reviews/2026-08-28-independent-full-audit.md 2.2）：DeterministicRetrievalEngine
 * mergeWithTraversed（原 :777）同分结果仅按 b.score - a.score 排序，无次级键——
 * W1 修复了同文件 phaseMergeAndRank（:493，有 id localeCompare 次级键）但漏了此处。
 *
 * 复现路径：retrieveWithPaths() 多跳遍历产生两条同分 traversed 结果
 * （起始实体 A 以相同 weight 链接到 Z 与 B，且 Z 的链接先插入），
 * 修复前同分时保持合并插入序（Z 在 B 前），与 id 字典序相悖。
 *
 * 注：knowledgeNetwork.create 生成的 id 含 Math.random()（跨实例不可控），
 * 故经引擎构造器的 graph 依赖注入接缝注入确定性 mock 图谱，
 * 精确控制 id（kn_b < kn_z）与链接插入顺序——与 KeywordSearcher 注入同一设计缝。
 */
import { describe, test, expect } from "bun:test";
import { DeterministicRetrievalEngine } from "../src/dre/retrieval/deterministic-retrieval-engine.js";
import {
  knowledgeNetwork,
  type KnowledgeEntity,
  type EntityLink,
} from "../src/dre/runtime/knowledge-network.js";

function mkEntity(id: string, name: string, content: string, confidence = 0.9): KnowledgeEntity {
  return {
    id,
    kind: "concept",
    name,
    content,
    state: { current: "open", properties: {}, lastChanged: 0 },
    constraints: [],
    capabilities: [],
    evidence: [],
    timeline: [],
    behaviors: [],
    predictions: [],
    hypotheses: [],
    confidence,
    source: "test",
    createdAt: 0,
    updatedAt: 0,
    version: 1,
  };
}

function mkLink(id: string, src: string, dst: string, weight = 1.0): EntityLink {
  return { id, src, dst, relation: "relates_to", weight, createdAt: 0 };
}

/** 确定性 mock 图谱：A --(w=1)--> Z（先插入），A --(w=1)--> B（后插入） */
function makeTieGraph(): typeof knowledgeNetwork {
  const entities = [
    mkEntity("kn_a", "Anchor", "anchor hub content"),
    mkEntity("kn_z", "Zeta", "zeta leaf content"),
    mkEntity("kn_b", "Beta", "beta leaf content"),
  ];
  const linksBySrc = new Map<string, EntityLink[]>([
    ["kn_a", [mkLink("l1", "kn_a", "kn_z"), mkLink("l2", "kn_a", "kn_b")]],
  ]);
  return {
    search: (q: string, limit: number) =>
      entities
        .filter((e) => e.name.toLowerCase().includes(q) || e.content.toLowerCase().includes(q))
        .slice(0, limit),
    get: (id: string) => entities.find((e) => e.id === id),
    getLinksFrom: (src: string) => linksBySrc.get(src) ?? [],
    getStats: () => ({ entities: entities.length, links: 2 }),
  } as unknown as typeof knowledgeNetwork;
}

describe("DRE 同分结果确定性次级键（审计 M2）", () => {
  test("retrieveWithPaths 同分 traversed 结果按 id 字典序，跨实例稳定（3 次新建引擎）", () => {
    const orders: string[] = [];
    for (let i = 0; i < 3; i++) {
      const engine = new DeterministicRetrievalEngine({
        graph: makeTieGraph(),
        keywordSearcher: null,
      });
      const { results } = engine.retrieveWithPaths("anchor", { maxDepth: 1 });
      // kn_a 直接匹配得分最高；kn_b 与 kn_z 为同 weight 同跳数的遍历结果 → 同分
      expect(results.length).toBeGreaterThanOrEqual(3);
      const tieIds = results.filter((r) => r.id !== "kn_a").map((r) => r.id);
      expect(tieIds).toContain("kn_b");
      expect(tieIds).toContain("kn_z");
      orders.push(results.map((r) => r.id).join("|"));
      // 次级键：同分内按 id 字典序 → kn_b 先于 kn_z（与链接插入序相反）
      expect(tieIds.indexOf("kn_b")).toBeLessThan(tieIds.indexOf("kn_z"));
    }
    // 跨实例顺序完全一致
    expect(new Set(orders).size).toBe(1);
  });
});
