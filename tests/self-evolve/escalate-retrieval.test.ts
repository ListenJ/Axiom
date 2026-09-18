import { describe, expect, it } from "bun:test";
import { SelfEvolveEngine, buildEscalationQuery } from "../../src/self-evolve/engine.js";
import type { EvidenceSource, SelfEvolveDeps } from "../../src/self-evolve/types.js";

function engineWithRetriever(retrieve: (q: string) => Promise<EvidenceSource[]>): SelfEvolveEngine {
  const deps: SelfEvolveDeps = {
    think: async () => JSON.stringify({ goal: "g", assumptions: [], plan: ["p"], risks: [] }),
    retrieve,
  };
  return new SelfEvolveEngine(deps);
}

const src = (title: string, score: number): EvidenceSource => ({ title, url: `https://x/${title}`, snippet: title, score, provenance: "test" });

describe("retrieval escalation (low confidence -> extra retrieval round)", () => {
  it("builds escalation query from input + evidence titles", () => {
    const q = buildEscalationQuery("如何优化 SQL 查询", [src("PostgreSQL 索引优化", 0.8)]);
    expect(q).toContain("如何优化 SQL 查询");
    expect(q).toContain("PostgreSQL");
  });

  it("triggers second retrieval when confidence < 0.6 and evidence < 3", async () => {
    const calls: string[] = [];
    const engine = engineWithRetriever(async (q) => {
      calls.push(q);
      if (calls.length === 1) return [src("PostgreSQL 索引优化", 0.5)]; // 低置信度
      return [src("SQL 查询优化实践", 0.9), src("执行计划分析", 0.85)]; // 补充强证据
    });
    const thought = await engine.selfThink({ input: "如何优化 SQL 查询" });
    expect(calls.length).toBeGreaterThanOrEqual(2); // 自动升级检索
    expect(thought.confidence).toBeGreaterThanOrEqual(0.6); // 置信度提升
    expect(thought.evidence.length).toBeGreaterThanOrEqual(3); // 证据合并
  });

  it("does not escalate when confidence is already high", async () => {
    const calls: string[] = [];
    const engine = engineWithRetriever(async (q) => {
      calls.push(q);
      return [src("A", 0.95), src("B", 0.9), src("C", 0.85)];
    });
    await engine.selfThink({ input: "x" });
    expect(calls.length).toBe(1); // 只检索一轮
  });
});
