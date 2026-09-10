/**
 * 证据验证链 — Layer 3 测试套件
 *
 * 覆盖维度（对应用户质量保障要求）：
 *   1. 功能测试：正常场景 + 边界条件 + 异常情况
 *   2. 状态判定：verified / unverified / contradicted 三态
 *   3. ConfRAG 触发：高/低/空/混合结果集的深度检索触发判断
 *   4. 性能基准：批量验证延迟
 *
 * 测试策略（遵循 AGENTS.md 规则 7 测试驱动）：
 *   - 测行为不测实现：全部通过 verifyResult() / verifyBatch() / shouldTriggerDeepRetrieval() 公共接口验证
 *   - 垂直切片：每个测试响应上一轮的发现
 *   - 手工构造 RetrievalResult，不依赖检索引擎实例
 */
import { describe, beforeEach, afterEach, test, expect } from "bun:test";
import {
  VerificationChain,
  _resetVerificationChainForTest,
  type VerificationStatus,
} from "../src/dre/retrieval/verification-chain.js";
import type { RetrievalResult, EvidenceStep } from "../src/dre/retrieval/deterministic-retrieval-engine.js";

// ─── 测试辅助 ────────────────────────────────────────────────────────────

/** 构造证据步骤 */
function makeStep(
  type: EvidenceStep["type"],
  target: string,
  confidence: number,
  reasoning: string,
  source = "query",
  relation?: string,
): EvidenceStep {
  return { type, source, target, confidence, reasoning, ...(relation !== undefined ? { relation } : {}) };
}

/** 构造检索结果 */
function makeResult(opts: {
  id?: string;
  title?: string;
  excerpt?: string;
  score?: number;
  steps?: EvidenceStep[];
  source?: RetrievalResult["source"];
  notePath?: string;
  entityId?: string;
  totalConfidence?: number;
}): RetrievalResult {
  return {
    id: opts.id ?? "result-1",
    title: opts.title ?? "测试结果",
    excerpt: opts.excerpt ?? "测试内容摘要",
    score: opts.score ?? 80,
    reasons: ["测试"],
    evidenceChain: {
      query: "测试查询",
      steps: opts.steps ?? [
        makeStep("graph_entity", "entity-1", 0.9, "图谱实体匹配"),
        makeStep("graph_traverse", "entity-2", 0.8, "图遍历到 entity-2"),
      ],
      totalConfidence: opts.totalConfidence ?? 0.85,
    },
    source: opts.source ?? "graph",
    ...(opts.notePath !== undefined ? { notePath: opts.notePath } : {}),
    ...(opts.entityId !== undefined ? { entityId: opts.entityId } : {}),
  };
}

/** 构造高置信度结果（多来源 + 多步骤 + 有引用） */
function makeVerifiedResult(): RetrievalResult {
  return makeResult({
    id: "ts-debug",
    title: "TypeScript Debugging",
    excerpt: "TypeScript debugging techniques with score 85",
    source: "hybrid",
    notePath: "notes/ts.md",
    entityId: "entity-ts",
    steps: [
      makeStep("keyword_match", "notes/ts.md", 0.85, "关键词匹配得分 85"),
      makeStep("graph_entity", "entity-ts", 0.9, "图谱实体 TypeScript confidence=0.90"),
      makeStep("graph_traverse", "entity-debug", 0.8, "图遍历 --supports--> Debugging"),
    ],
    totalConfidence: 0.9,
  });
}

// ─── 功能测试：正常场景 ──────────────────────────────────────────────────

describe("VerificationChain — 正常场景", () => {
  let chain: VerificationChain;

  beforeEach(() => {
    chain = new VerificationChain();
  });

  afterEach(() => {
    _resetVerificationChainForTest();
  });

  test("verifyResult 返回完整验证结论", () => {
    const result = makeVerifiedResult();
    const verdict = chain.verifyResult(result);

    expect(verdict.status).toBeDefined();
    expect(verdict.overallConfidence).toBeGreaterThanOrEqual(0);
    expect(verdict.overallConfidence).toBeLessThanOrEqual(1);
    expect(verdict.checks.length).toBe(4); // 4 项检查
    expect(verdict.reasoning.length).toBeGreaterThan(0);
    // 每项检查都有完整字段
    for (const check of verdict.checks) {
      expect(check.name).toBeDefined();
      expect(typeof check.passed).toBe("boolean");
      expect(check.score).toBeGreaterThanOrEqual(0);
      expect(check.score).toBeLessThanOrEqual(1);
      expect(check.detail.length).toBeGreaterThan(0);
    }
  });

  test("引用存在性检查：hybrid 结果通过 citation 检查", () => {
    const result = makeVerifiedResult();
    const verdict = chain.verifyResult(result);
    const citation = verdict.checks.find((c) => c.name === "citation")!;
    expect(citation.passed).toBe(true);
    expect(citation.score).toBe(1);
    expect(citation.detail).toContain("实体:entity-ts");
    expect(citation.detail).toContain("笔记:notes/ts.md");
  });

  test("证据重叠检查：多步骤指向同一目标时通过", () => {
    const result = makeResult({
      steps: [
        makeStep("keyword_match", "target-x", 0.8, "关键词匹配"),
        makeStep("graph_entity", "target-x", 0.85, "图谱实体匹配"), // 同一 target
        makeStep("graph_traverse", "target-y", 0.8, "图遍历"),
      ],
    });
    const verdict = chain.verifyResult(result);
    const overlap = verdict.checks.find((c) => c.name === "evidence_overlap")!;
    expect(overlap.passed).toBe(true);
    expect(overlap.detail).toContain("1 个目标被多次指向");
  });

  test("来源多样性检查：hybrid 结果通过 diversity 检查", () => {
    const result = makeVerifiedResult();
    const verdict = chain.verifyResult(result);
    const diversity = verdict.checks.find((c) => c.name === "source_diversity")!;
    expect(diversity.passed).toBe(true);
    expect(diversity.detail).toContain("keyword");
    expect(diversity.detail).toContain("graph");
  });

  test("数值一致性检查：无数值时默认通过", () => {
    const result = makeResult({ excerpt: "无数值的纯文本内容" });
    const verdict = chain.verifyResult(result);
    const numerical = verdict.checks.find((c) => c.name === "numerical_consistency")!;
    expect(numerical.passed).toBe(true);
    expect(numerical.score).toBe(1);
    expect(numerical.detail).toBe("无数值需验证");
  });

  test("批量验证保持顺序并返回对应结论", () => {
    const results = [
      makeResult({ id: "r1", title: "结果一" }),
      makeResult({ id: "r2", title: "结果二" }),
      makeResult({ id: "r3", title: "结果三" }),
    ];
    const batch = chain.verifyBatch(results);
    expect(batch.length).toBe(3);
    expect(batch[0].result.id).toBe("r1");
    expect(batch[1].result.id).toBe("r2");
    expect(batch[2].result.id).toBe("r3");
    // 每条都有验证结论
    for (const entry of batch) {
      expect(entry.verdict.checks.length).toBe(4);
      expect(entry.verdict.reasoning.length).toBeGreaterThan(0);
    }
  });
});

// ─── 边界条件 ──────────────────────────────────────────────────────────

describe("VerificationChain — 边界条件", () => {
  let chain: VerificationChain;

  beforeEach(() => {
    chain = new VerificationChain();
  });

  afterEach(() => {
    _resetVerificationChainForTest();
  });

  test("空证据步骤：citation 不通过且 score=0", () => {
    const result = makeResult({
      steps: [],
      entityId: "entity-1",
      totalConfidence: 0,
    });
    const verdict = chain.verifyResult(result);
    const citation = verdict.checks.find((c) => c.name === "citation")!;
    expect(citation.passed).toBe(false);
    expect(citation.score).toBe(0);
  });

  test("仅一条证据步骤：overlap 不通过但 score=0.3", () => {
    const result = makeResult({
      steps: [makeStep("graph_entity", "entity-1", 0.9, "图谱匹配")],
    });
    const verdict = chain.verifyResult(result);
    const overlap = verdict.checks.find((c) => c.name === "evidence_overlap")!;
    expect(overlap.passed).toBe(false);
    expect(overlap.score).toBe(0.3);
    expect(overlap.detail).toContain("仅一条证据步骤");
  });

  test("无 citation（缺失 entityId 和 notePath）：citation 不通过", () => {
    const result = makeResult({
      source: "graph",
      steps: [makeStep("graph_entity", "entity-1", 0.9, "图谱匹配")],
    });
    // 确保 entityId 和 notePath 都未设置
    expect(result.entityId).toBeUndefined();
    expect(result.notePath).toBeUndefined();
    const verdict = chain.verifyResult(result);
    const citation = verdict.checks.find((c) => c.name === "citation")!;
    expect(citation.passed).toBe(false);
    expect(citation.detail).toContain("无可追溯来源");
  });

  test("数值一致性：excerpt 数值在证据中找到时通过", () => {
    const result = makeResult({
      excerpt: "得分 85 的结果，置信度 0.9",
      steps: [
        makeStep("keyword_match", "notes/x", 0.85, "匹配得分 85"),
        makeStep("graph_entity", "entity-x", 0.9, "置信度 0.9"),
      ],
    });
    const verdict = chain.verifyResult(result);
    const numerical = verdict.checks.find((c) => c.name === "numerical_consistency")!;
    expect(numerical.passed).toBe(true);
    expect(numerical.detail).toContain("2/2");
  });

  test("数值一致性：excerpt 数值完全不在证据中时不通过", () => {
    const result = makeResult({
      excerpt: "得分 999 的结果",
      steps: [
        makeStep("keyword_match", "notes/x", 0.85, "匹配得分 85"),
        makeStep("graph_entity", "entity-x", 0.9, "图谱匹配"),
      ],
    });
    const verdict = chain.verifyResult(result);
    const numerical = verdict.checks.find((c) => c.name === "numerical_consistency")!;
    expect(numerical.passed).toBe(false);
    expect(numerical.score).toBe(0); // 完全矛盾
  });

  test("禁用数值检查时仅运行 3 项检查", () => {
    const chainNoNum = new VerificationChain({ enableNumericalCheck: false });
    const result = makeVerifiedResult();
    const verdict = chainNoNum.verifyResult(result);
    expect(verdict.checks.length).toBe(3);
    expect(verdict.checks.find((c) => c.name === "numerical_consistency")).toBeUndefined();
  });
});

// ─── 状态判定 ──────────────────────────────────────────────────────────

describe("VerificationChain — 状态判定", () => {
  afterEach(() => {
    _resetVerificationChainForTest();
  });

  test("verified 状态：高置信度多来源结果", () => {
    const chain = new VerificationChain({ confidenceThreshold: 0.6 });
    const result = makeVerifiedResult();
    const verdict = chain.verifyResult(result);
    expect(verdict.status).toBe("verified");
    expect(verdict.overallConfidence).toBeGreaterThanOrEqual(0.6);
  });

  test("unverified 状态：低置信度单来源结果", () => {
    const chain = new VerificationChain({ confidenceThreshold: 0.6 });
    const result = makeResult({
      excerpt: "未知内容",
      source: "graph",
      steps: [makeStep("graph_entity", "entity-x", 0.3, "低置信度匹配")],
      totalConfidence: 0.2,
    });
    const verdict = chain.verifyResult(result);
    expect(verdict.status).toBe("unverified");
    expect(verdict.overallConfidence).toBeLessThan(0.6);
  });

  test("contradicted 状态：数值完全矛盾触发 contradicted", () => {
    const chain = new VerificationChain();
    const result = makeResult({
      excerpt: "得分 999 的内容",
      source: "hybrid",
      notePath: "notes/x",
      entityId: "entity-x",
      steps: [
        makeStep("keyword_match", "notes/x", 0.9, "匹配得分 85"),
        makeStep("graph_entity", "entity-x", 0.9, "图谱匹配 90"),
      ],
      totalConfidence: 0.9,
    });
    const verdict = chain.verifyResult(result);
    expect(verdict.status).toBe("contradicted");
    const numerical = verdict.checks.find((c) => c.name === "numerical_consistency")!;
    expect(numerical.passed).toBe(false);
    expect(numerical.score).toBe(0);
  });

  test("自定义阈值：高阈值使原本 verified 的结果变为 unverified", () => {
    const result = makeVerifiedResult();
    // 默认阈值 0.6 → verified
    const chainDefault = new VerificationChain();
    expect(chainDefault.verifyResult(result).status).toBe("verified");
    // 阈值 0.99 → unverified
    const chainStrict = new VerificationChain({ confidenceThreshold: 0.99 });
    expect(chainStrict.verifyResult(result).status).toBe("unverified");
  });

  test("推理说明包含通过和未通过的检查项", () => {
    const chain = new VerificationChain();
    const result = makeResult({
      excerpt: "得分 999 的内容",
      source: "hybrid",
      notePath: "notes/x",
      entityId: "entity-x",
      steps: [
        makeStep("keyword_match", "notes/x", 0.9, "匹配得分 85"),
        makeStep("graph_entity", "entity-x", 0.9, "图谱匹配 90"),
      ],
      totalConfidence: 0.9,
    });
    const verdict = chain.verifyResult(result);
    expect(verdict.reasoning).toContain("验证状态");
    // 应包含未通过的检查（数值一致性）
    expect(verdict.reasoning).toContain("numerical_consistency");
  });
});

// ─── ConfRAG 触发判断 ──────────────────────────────────────────────────

describe("VerificationChain — ConfRAG 触发判断", () => {
  let chain: VerificationChain;

  beforeEach(() => {
    chain = new VerificationChain();
  });

  afterEach(() => {
    _resetVerificationChainForTest();
  });

  test("高置信度结果集不触发深度检索", () => {
    const results = [
      makeVerifiedResult(),
      makeVerifiedResult(),
      makeVerifiedResult(),
    ];
    const trigger = chain.shouldTriggerDeepRetrieval(results);
    expect(trigger.trigger).toBe(false);
    expect(trigger.verifiedRate).toBeGreaterThan(0.5);
    expect(trigger.avgConfidence).toBeGreaterThan(0.5);
    expect(trigger.reason).toContain("无需深度检索");
  });

  test("低置信度结果集触发深度检索", () => {
    const results = [
      makeResult({
        excerpt: "未知内容",
        source: "graph",
        steps: [makeStep("graph_entity", "entity-x", 0.2, "低置信度")],
        totalConfidence: 0.2,
      }),
    ];
    const trigger = chain.shouldTriggerDeepRetrieval(results);
    expect(trigger.trigger).toBe(true);
    expect(trigger.verifiedRate).toBeLessThan(0.5);
    expect(trigger.reason).toContain("触发深度检索");
  });

  test("空结果集触发深度检索", () => {
    const trigger = chain.shouldTriggerDeepRetrieval([]);
    expect(trigger.trigger).toBe(true);
    expect(trigger.verifiedRate).toBe(0);
    expect(trigger.avgConfidence).toBe(0);
    expect(trigger.reason).toContain("无检索结果");
  });

  test("混合结果集：verified 占比低于阈值时触发", () => {
    const results = [
      makeVerifiedResult(), // verified
      makeResult({
        excerpt: "未知",
        source: "graph",
        steps: [makeStep("graph_entity", "x", 0.2, "低")],
        totalConfidence: 0.2,
      }), // unverified
      makeResult({
        excerpt: "未知",
        source: "graph",
        steps: [makeStep("graph_entity", "y", 0.2, "低")],
        totalConfidence: 0.2,
      }), // unverified
    ];
    // verifiedRate = 1/3 ≈ 0.33 < 0.5 → 触发
    const trigger = chain.shouldTriggerDeepRetrieval(results);
    expect(trigger.trigger).toBe(true);
    expect(trigger.verifiedRate).toBeCloseTo(1 / 3, 1);
  });

  test("自定义阈值：放宽触发条件使低验证率不触发", () => {
    const results = [
      makeVerifiedResult(),
      makeResult({
        excerpt: "未知",
        source: "graph",
        steps: [makeStep("graph_entity", "x", 0.4, "中")],
        totalConfidence: 0.4,
      }),
    ];
    // 默认阈值：verifiedRate=0.5 >= 0.5，但 avgConfidence 可能 < 0.5
    // 自定义放宽：minVerifiedRate=0.3, minAvgConfidence=0.2
    const trigger = chain.shouldTriggerDeepRetrieval(results, {
      minVerifiedRate: 0.3,
      minAvgConfidence: 0.2,
    });
    expect(trigger.trigger).toBe(false);
  });
});

// ─── 性能基准 ──────────────────────────────────────────────────────────

describe("VerificationChain — 性能基准", () => {
  let chain: VerificationChain;

  beforeEach(() => {
    chain = new VerificationChain();
  });

  afterEach(() => {
    _resetVerificationChainForTest();
  });

  test("100 结果批量验证延迟 < 50ms", () => {
    const results: RetrievalResult[] = [];
    for (let i = 0; i < 100; i++) {
      results.push(
        makeResult({
          id: `r-${i}`,
          title: `结果 ${i}`,
          excerpt: `内容 ${i} 得分 80`,
          source: "hybrid",
          notePath: `notes/${i}.md`,
          entityId: `entity-${i}`,
          steps: [
            makeStep("keyword_match", `notes/${i}.md`, 0.8, `匹配得分 80`),
            makeStep("graph_entity", `entity-${i}`, 0.85, "图谱匹配"),
            makeStep("graph_traverse", `entity-${i + 1}`, 0.8, "图遍历"),
          ],
          totalConfidence: 0.85,
        }),
      );
    }
    const start = performance.now();
    const batch = chain.verifyBatch(results);
    const elapsed = performance.now() - start;
    expect(batch.length).toBe(100);
    expect(elapsed).toBeLessThan(50);
  });

  test("shouldTriggerDeepRetrieval 100 结果延迟 < 50ms", () => {
    const results: RetrievalResult[] = [];
    for (let i = 0; i < 100; i++) {
      results.push(makeVerifiedResult());
    }
    const start = performance.now();
    const trigger = chain.shouldTriggerDeepRetrieval(results);
    const elapsed = performance.now() - start;
    expect(trigger.trigger).toBe(false);
    expect(elapsed).toBeLessThan(50);
  });
});

// ─── 单例 ──────────────────────────────────────────────────────────────

describe("VerificationChain — 单例", () => {
  afterEach(() => {
    _resetVerificationChainForTest();
  });

  test("getVerificationChain 返回同一实例", async () => {
    const { getVerificationChain } = await import("../src/dre/retrieval/verification-chain.js");
    const a = getVerificationChain();
    const b = getVerificationChain();
    expect(a).toBe(b);
  });

  test("_resetVerificationChainForTest 重置单例", async () => {
    const { getVerificationChain } = await import("../src/dre/retrieval/verification-chain.js");
    const a = getVerificationChain();
    _resetVerificationChainForTest();
    const b = getVerificationChain();
    expect(a).not.toBe(b);
  });
});
