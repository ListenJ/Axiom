/**
 * 混合融合排序 — Layer 4 测试套件
 *
 * 覆盖维度：
 *   1. 功能测试：去重 + 验证加权 + 交叉来源加成 + 多样性加成
 *   2. 边界条件：空输入 / 单结果 / 无验证 / 全重复
 *   3. 排序与过滤：得分降序 / minScore 过滤 / limit 截断
 *   4. 性能基准：100 结果融合延迟
 *
 * 测试策略：全部通过 fuse() 公共接口验证，手工构造 RetrievalResult。
 */
import { describe, beforeEach, afterEach, test, expect } from "bun:test";
import {
  HybridFusion,
  _resetHybridFusionForTest,
  type FusionInput,
  type FusionResult,
} from "../src/dre/retrieval/hybrid-fusion.js";
import type { RetrievalResult, EvidenceStep } from "../src/dre/retrieval/deterministic-retrieval-engine.js";
import type { VerificationVerdict } from "../src/dre/retrieval/verification-chain.js";

// ─── 测试辅助 ────────────────────────────────────────────────────────────

function makeStep(
  type: EvidenceStep["type"],
  target: string,
  confidence = 0.8,
  reasoning = "测试步骤",
): EvidenceStep {
  return { type, source: "query", target, confidence, reasoning };
}

function makeResult(opts: {
  id: string;
  title?: string;
  score?: number;
  source?: RetrievalResult["source"];
  notePath?: string;
  entityId?: string;
  steps?: EvidenceStep[];
  totalConfidence?: number;
}): RetrievalResult {
  return {
    id: opts.id,
    title: opts.title ?? `结果 ${opts.id}`,
    excerpt: `内容摘要 ${opts.id}`,
    score: opts.score ?? 50,
    reasons: ["测试"],
    evidenceChain: {
      query: "测试",
      steps: opts.steps ?? [makeStep("graph_entity", opts.id)],
      totalConfidence: opts.totalConfidence ?? 0.8,
    },
    source: opts.source ?? "graph",
    ...(opts.notePath !== undefined ? { notePath: opts.notePath } : {}),
    ...(opts.entityId !== undefined ? { entityId: opts.entityId } : {}),
  };
}

function makeVerdict(status: VerificationVerdict["status"], confidence = 0.7): VerificationVerdict {
  return {
    status,
    overallConfidence: confidence,
    checks: [],
    reasoning: `验证状态: ${status}`,
  };
}

// ─── 功能测试：融合流程 ──────────────────────────────────────────────────

describe("HybridFusion — 融合流程", () => {
  let fusion: HybridFusion;

  beforeEach(() => {
    fusion = new HybridFusion();
  });

  afterEach(() => {
    _resetHybridFusionForTest();
  });

  test("fuse 返回完整融合响应", () => {
    const input: FusionInput = {
      query: "test",
      results: [makeResult({ id: "r1", score: 80 })],
    };
    const response = fusion.fuse(input);
    expect(response.results.length).toBe(1);
    expect(response.metrics.totalInput).toBe(1);
    expect(response.metrics.totalOutput).toBe(1);
    expect(response.metrics.latencyMs).toBeGreaterThanOrEqual(0);
    // 融合结果有额外字段
    const r = response.results[0];
    expect(r.fusionScore).toBeDefined();
    expect(r.sourceContributions).toBeInstanceOf(Array);
    expect(r.fusionReasoning.length).toBeGreaterThan(0);
  });

  test("去重：同 ID 结果合并保留最高分", () => {
    const input: FusionInput = {
      query: "test",
      results: [
        makeResult({ id: "r1", score: 60 }),
        makeResult({ id: "r1", score: 80 }),
        makeResult({ id: "r1", score: 70 }),
      ],
    };
    const response = fusion.fuse(input);
    expect(response.results.length).toBe(1);
    expect(response.metrics.duplicatesRemoved).toBe(2);
    // 基础分应为最高分 80
    expect(response.results[0].score).toBe(80);
  });

  test("验证加权：verified 结果得分提升", () => {
    const verdicts = new Map([["r1", makeVerdict("verified", 0.9)]]);
    const input: FusionInput = {
      query: "test",
      results: [makeResult({ id: "r1", score: 80 })],
      verdicts,
    };
    const response = fusion.fuse(input);
    const r = response.results[0];
    expect(r.verificationStatus).toBe("verified");
    expect(r.fusionScore).toBeGreaterThan(80); // 80 * 1.1 = 88
    expect(r.fusionReasoning).toContain("验证通过");
  });

  test("验证加权：contradicted 结果得分大幅降低", () => {
    const verdicts = new Map([["r1", makeVerdict("contradicted", 0.3)]]);
    const input: FusionInput = {
      query: "test",
      results: [makeResult({ id: "r1", score: 80 })],
      verdicts,
    };
    const response = fusion.fuse(input);
    const r = response.results[0];
    expect(r.verificationStatus).toBe("contradicted");
    expect(r.fusionScore).toBeLessThan(50); // 80 * 0.5 = 40
    expect(r.fusionReasoning).toContain("存在矛盾");
  });

  test("交叉来源加成：多源结果得分提升", () => {
    // 同一 ID，一个来自 keyword，一个来自 graph
    const input: FusionInput = {
      query: "test",
      results: [
        makeResult({
          id: "r1",
          score: 70,
          source: "keyword",
          notePath: "notes/x.md",
          steps: [makeStep("keyword_match", "notes/x.md")],
        }),
        makeResult({
          id: "r1",
          score: 75,
          source: "graph",
          entityId: "entity-x",
          steps: [makeStep("graph_entity", "entity-x")],
        }),
      ],
    };
    const response = fusion.fuse(input);
    const r = response.results[0];
    expect(r.sourceContributions.length).toBe(2); // keyword + graph
    expect(r.fusionScore).toBeGreaterThan(75); // 基础 75 + 交叉加成
    expect(response.metrics.crossSourceCount).toBe(1);
  });

  test("多样性加成：hybrid 结果额外加分", () => {
    const input: FusionInput = {
      query: "test",
      results: [
        makeResult({ id: "r1", score: 80, source: "hybrid", notePath: "n", entityId: "e" }),
      ],
    };
    const response = fusion.fuse(input);
    const r = response.results[0];
    expect(r.fusionReasoning).toContain("混合来源");
  });

  test("证据步骤去重：合并后证据步骤不重复", () => {
    const input: FusionInput = {
      query: "test",
      results: [
        makeResult({
          id: "r1",
          score: 70,
          steps: [
            makeStep("keyword_match", "target-a"),
            makeStep("graph_entity", "target-b"),
          ],
        }),
        makeResult({
          id: "r1",
          score: 80,
          steps: [
            makeStep("keyword_match", "target-a"), // 重复
            makeStep("graph_traverse", "target-c"),
          ],
        }),
      ],
    };
    const response = fusion.fuse(input);
    const steps = response.results[0].evidenceChain.steps;
    // target-a 只应出现一次
    const targetASteps = steps.filter((s) => s.target === "target-a");
    expect(targetASteps.length).toBe(1);
    expect(steps.length).toBe(3); // a, b, c
  });
});

// ─── 边界条件 ──────────────────────────────────────────────────────────

describe("HybridFusion — 边界条件", () => {
  let fusion: HybridFusion;

  beforeEach(() => {
    fusion = new HybridFusion();
  });

  afterEach(() => {
    _resetHybridFusionForTest();
  });

  test("空输入返回空结果", () => {
    const response = fusion.fuse({ query: "test", results: [] });
    expect(response.results.length).toBe(0);
    expect(response.metrics.totalInput).toBe(0);
    expect(response.metrics.totalOutput).toBe(0);
  });

  test("单结果无验证：正常返回", () => {
    const response = fusion.fuse({
      query: "test",
      results: [makeResult({ id: "r1", score: 50 })],
    });
    expect(response.results.length).toBe(1);
    expect(response.results[0].verificationStatus).toBeUndefined();
    expect(response.results[0].fusionScore).toBe(50); // 无加成
  });

  test("无验证结论时 verificationStatus 为 undefined", () => {
    const response = fusion.fuse({
      query: "test",
      results: [makeResult({ id: "r1", score: 50 })],
      verdicts: new Map(),
    });
    expect(response.results[0].verificationStatus).toBeUndefined();
  });

  test("minScore 过滤低分结果", () => {
    const response = fusion.fuse({
      query: "test",
      results: [
        makeResult({ id: "r1", score: 30 }),
        makeResult({ id: "r2", score: 80 }),
      ],
      options: { minScore: 50 },
    });
    expect(response.results.length).toBe(1);
    expect(response.results[0].id).toBe("r2");
  });

  test("limit 截断结果数", () => {
    const results: RetrievalResult[] = [];
    for (let i = 0; i < 10; i++) {
      results.push(makeResult({ id: `r${i}`, score: 50 + i }));
    }
    const response = fusion.fuse({
      query: "test",
      results,
      options: { limit: 3 },
    });
    expect(response.results.length).toBe(3);
  });
});

// ─── 排序与加权 ────────────────────────────────────────────────────────

describe("HybridFusion — 排序与加权", () => {
  let fusion: HybridFusion;

  beforeEach(() => {
    fusion = new HybridFusion();
  });

  afterEach(() => {
    _resetHybridFusionForTest();
  });

  test("结果按 fusionScore 降序排列", () => {
    const response = fusion.fuse({
      query: "test",
      results: [
        makeResult({ id: "low", score: 30 }),
        makeResult({ id: "high", score: 90 }),
        makeResult({ id: "mid", score: 60 }),
      ],
    });
    expect(response.results[0].id).toBe("high");
    expect(response.results[1].id).toBe("mid");
    expect(response.results[2].id).toBe("low");
  });

  test("verified 结果排在 unverified 之前", () => {
    // 同等基础分，验证状态决定排序
    const verdicts = new Map<string, VerificationVerdict>([
      ["verified-id", makeVerdict("verified")],
      ["unverified-id", makeVerdict("unverified")],
    ]);
    const response = fusion.fuse({
      query: "test",
      results: [
        makeResult({ id: "unverified-id", score: 80 }),
        makeResult({ id: "verified-id", score: 80 }),
      ],
      verdicts,
    });
    expect(response.results[0].id).toBe("verified-id");
    expect(response.results[0].fusionScore).toBeGreaterThan(response.results[1].fusionScore);
  });

  test("contradicted 结果排在最后", () => {
    const verdicts = new Map<string, VerificationVerdict>([
      ["bad", makeVerdict("contradicted")],
      ["good", makeVerdict("verified")],
    ]);
    const response = fusion.fuse({
      query: "test",
      results: [
        makeResult({ id: "bad", score: 80 }),
        makeResult({ id: "good", score: 80 }),
      ],
      verdicts,
    });
    expect(response.results[0].id).toBe("good");
    expect(response.results[1].id).toBe("bad");
  });

  test("自定义选项覆盖默认值", () => {
    // 使用极大 verificationBoost 使 verified 结果得分翻倍
    const verdicts = new Map([["r1", makeVerdict("verified")]]);
    const response = fusion.fuse({
      query: "test",
      results: [makeResult({ id: "r1", score: 50 })],
      verdicts,
      options: { verificationBoost: 1.0 }, // +100%
    });
    expect(response.results[0].fusionScore).toBe(100); // 50 * 2.0
  });

  test("metrics 统计完整", () => {
    const verdicts = new Map<string, VerificationVerdict>([
      ["r1", makeVerdict("verified")],
      ["r2", makeVerdict("contradicted")],
    ]);
    const response = fusion.fuse({
      query: "test",
      results: [
        makeResult({ id: "r1", score: 80 }),
        makeResult({ id: "r2", score: 70 }),
        makeResult({ id: "r3", score: 60 }),
      ],
      verdicts,
    });
    expect(response.metrics.verifiedCount).toBe(1);
    expect(response.metrics.contradictedCount).toBe(1);
    expect(response.metrics.totalInput).toBe(3);
    expect(response.metrics.totalOutput).toBe(3);
  });
});

// ─── 性能基准 ──────────────────────────────────────────────────────────

describe("HybridFusion — 性能基准", () => {
  let fusion: HybridFusion;

  beforeEach(() => {
    fusion = new HybridFusion();
  });

  afterEach(() => {
    _resetHybridFusionForTest();
  });

  test("100 结果融合延迟 < 50ms", () => {
    const results: RetrievalResult[] = [];
    for (let i = 0; i < 100; i++) {
      results.push(makeResult({ id: `r-${i}`, score: 50 + (i % 50) }));
    }
    const start = performance.now();
    const response = fusion.fuse({ query: "test", results, options: { limit: 100 } });
    const elapsed = performance.now() - start;
    expect(response.results.length).toBe(100);
    expect(elapsed).toBeLessThan(50);
  });

  test("100 结果 + 50 验证结论融合延迟 < 50ms", () => {
    const results: RetrievalResult[] = [];
    const verdicts = new Map<string, VerificationVerdict>();
    for (let i = 0; i < 100; i++) {
      results.push(makeResult({ id: `r-${i}`, score: 50 + (i % 50) }));
      if (i < 50) {
        verdicts.set(`r-${i}`, makeVerdict(i % 3 === 0 ? "verified" : "unverified"));
      }
    }
    const start = performance.now();
    const response = fusion.fuse({ query: "test", results, verdicts, options: { limit: 100 } });
    const elapsed = performance.now() - start;
    expect(response.results.length).toBe(100);
    expect(elapsed).toBeLessThan(50);
  });
});

// ─── 单例 ──────────────────────────────────────────────────────────────

describe("HybridFusion — 单例", () => {
  afterEach(() => {
    _resetHybridFusionForTest();
  });

  test("getHybridFusion 返回同一实例", async () => {
    const { getHybridFusion } = await import("../src/dre/retrieval/hybrid-fusion.js");
    const a = getHybridFusion();
    const b = getHybridFusion();
    expect(a).toBe(b);
  });

  test("_resetHybridFusionForTest 重置单例", async () => {
    const { getHybridFusion } = await import("../src/dre/retrieval/hybrid-fusion.js");
    const a = getHybridFusion();
    _resetHybridFusionForTest();
    const b = getHybridFusion();
    expect(a).not.toBe(b);
  });
});
