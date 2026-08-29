/**
 * P0-C 幻觉防线接线测试 — 2026-08-29（docs/superpowers/specs/2026-08-29-p0-lift-design.md §C）
 *
 * 审计判定：hallucinationDetector 实例化即弃（main.ts:228 factBase=[]）、calibrate 零调用
 * → pValue 恒 1.0 永不判幻觉；chat 已有检索证据却未用于校验响应。
 *
 * 本文件经公共接口验证四组行为：
 * ① assessStatement：带证据 factBase 下，无支撑陈述（编造事实）→ 可疑（anomalous）、
 *    证据支撑陈述 → accepted；空陈述/空证据不判定（null）
 * ② chat 缝：prepareChatContext 返回请求级 evidence（knowledge+codegraph → FactEntry[]），
 *    assessStatement 产出响应元数据形状 { pValue, verdict, isAccepted }
 * ③ 请求级隔离：两次请求 factBase 互不污染
 * ④ factBase 构建纯函数：knowledge/codegraph 检索文本 → FactEntry[]；DRE metadata.evidence → FactEntry[]
 *
 * 校准债（P1）：calibrate 需要 (statement, isFact) 标注对积累，P0 交付未校准运行 ——
 * pValue 恒 1.0，可疑判定仅由 confidence（证据相似度）驱动，可观测不阻断。
 */

import { describe, test, expect, mock } from "bun:test";
import path from "path";

const ROOT = path.resolve(import.meta.dir, "..");

// ── 模块 mock（与 tests/services-chat.test.ts 同型：绝对路径 mock.module，确定性、零网络）──
// isRewriteEnabled=false 关闭边缘合并快路径；shouldEnhanceIntent=false 关闭意图 LLM 增强。
mock.module(path.join(ROOT, "src", "router", "model-router.js"), () => ({
  router: {
    routeByIntent: () => ({ content: "routed", model: "m1", provider: "p1", layer: "code" }),
    chat: () => ({ content: "general", model: "m2", provider: "p2", layer: "general" }),
  },
}));
mock.module(path.join(ROOT, "src", "agents", "intent-enhancer.js"), () => ({
  shouldEnhanceIntent: () => false,
  enhanceIntentWithLLM: async (_input: string, intent: { intent: string }) => intent,
  buildEnhancedSystemPrompt: (intent: string) => `Enhanced ${intent}`,
}));
mock.module(path.join(ROOT, "src", "agents", "prompt-optimizer.js"), () => ({
  optimizePrompt: async (text: string) => ({ changed: false, text }),
  shouldSkipOptimization: (text: string) => text.trim().length < 20,
  isRewriteEnabled: () => false,
  passesDeterministicGates: () => false,
  isPrivacyMode: () => false,
}));
mock.module(path.join(ROOT, "src", "utils", "read-optimizer-init.js"), () => ({
  isReadOptimizerInitialized: () => false,
}));
mock.module(path.join(ROOT, "src", "memory", "codegraph-index.js"), () => ({
  retrieveCodeMemory: async () => ({
    source: "codegraph",
    results: "export function sortNumbers(nums: number[]) { return nums.sort((a, b) => a - b); }",
  }),
  getFileSymbolsFromCodeGraph: async () => null,
}));
mock.module(path.join(ROOT, "src", "services", "knowledge.js"), () => ({
  retrieveKnowledge: async () => ({
    context:
      '[自适应检索: "quicksort algorithm"]\n检索范围: web\n找到 1 条结果:\n\n' +
      "• [web] Sorting algorithm basics\n" +
      "  QuickSort runs in O(n log n) average time and is widely used for sorting.\n",
    sources: [{ source: "web", title: "Sorting algorithm basics" }],
    totalResults: 1,
  }),
}));

import {
  assessStatement,
  buildFactBaseFromRetrieval,
  buildFactBaseFromEvidence,
  type FactEntry,
} from "../src/memory/hallucination-detector.js";

describe("① assessStatement：带证据 factBase 的 verify 分类", () => {
  const factBase: FactEntry[] = [
    { text: "quicksort runs in o(n log n) average time on random inputs", source: "web", confidence: 0.9 },
    { text: "javascript array sort compares strings by default", source: "web", confidence: 0.9 },
  ];

  test("证据支撑的陈述 → accepted（未校准下 pValue=1，confidence 由证据相似度驱动）", () => {
    const a = assessStatement(factBase, "quicksort runs in o(n log n) average time on random inputs of size n");
    expect(a).not.toBeNull();
    expect(a!.isAccepted).toBe(true);
    expect(a!.verdict).toBe("accepted");
    expect(a!.pValue).toBe(1);
  });

  test("无支撑陈述（编造事实）→ 可疑 anomalous，isAccepted=false", () => {
    const a = assessStatement(factBase, "the platypus lays transparent eggs on mars every leap year");
    expect(a).not.toBeNull();
    expect(a!.isAccepted).toBe(false);
    expect(a!.verdict).toBe("anomalous");
  });

  test("空陈述 / 空证据 → null（不判定，可观测优先不误标）", () => {
    expect(assessStatement([], "anything at all here")).toBeNull();
    expect(assessStatement(factBase, "   ")).toBeNull();
  });
});

describe("② chat 缝：请求级 evidence 与 _hallucination 元数据", () => {
  test("prepareChatContext 返回本次检索命中的 evidence（knowledge+codegraph）", async () => {
    const { prepareChatContext } = await import("../src/services/chat.js");
    const r = await prepareChatContext([{ role: "user", content: "explain the quicksort algorithm" }], true, null);
    expect(Array.isArray(r.evidence)).toBe(true);
    expect(r.evidence.length).toBeGreaterThan(0);
    // knowledge 证据（含 snippet）与 codegraph 证据都进入请求级 factBase
    expect(r.evidence.some((f) => f.text.toLowerCase().includes("quicksort"))).toBe(true);
    expect(r.evidence.some((f) => f.source === "codegraph")).toBe(true);
    // 检索头信息不作为证据
    expect(r.evidence.some((f) => f.text.includes("自适应检索"))).toBe(false);
  });

  test("assessStatement 输出即响应 _hallucination 元数据形状 { pValue, verdict, isAccepted }", () => {
    const a = assessStatement(
      [{ text: "quicksearch index built lazily at startup", confidence: 0.9 }],
      "quicksearch index built lazily at startup when first query arrives",
    );
    expect(a).not.toBeNull();
    expect(Object.keys(a!).sort()).toEqual(["isAccepted", "pValue", "verdict"]);
  });

  test("chat 响应正文基于请求证据判定：编造内容被标可疑", async () => {
    const { prepareChatContext } = await import("../src/services/chat.js");
    const r = await prepareChatContext([{ role: "user", content: "explain the quicksort algorithm" }], true, null);
    const fabricated = assessStatement(r.evidence, "the platypus lays transparent eggs on mars every leap year");
    expect(fabricated).not.toBeNull();
    expect(fabricated!.isAccepted).toBe(false);
    const grounded = assessStatement(r.evidence, "quicksort runs in o(n log n) average time and is widely used");
    expect(grounded!.isAccepted).toBe(true);
  });
});

describe("③ 请求级隔离：两次请求 factBase 互不污染", () => {
  test("无检索请求 evidence 为空，判定仅取决于各自请求的 evidence", async () => {
    const { prepareChatContext } = await import("../src/services/chat.js");
    const r1 = await prepareChatContext([{ role: "user", content: "explain the quicksort algorithm" }], true, null);
    const r2 = await prepareChatContext([{ role: "user", content: "hi" }], false, null);
    expect(r2.evidence).toEqual([]);

    const supported = "quicksort runs in o(n log n) average time and is widely used";
    // 请求 1：有证据 → 判定 accepted
    expect(assessStatement(r1.evidence, supported)!.isAccepted).toBe(true);
    // 请求 2：无证据 → 不判定（不会被请求 1 的证据污染）
    expect(assessStatement(r2.evidence, supported)).toBeNull();
    // 同一陈述在不同请求证据下结论独立
    expect(assessStatement(r2.evidence.length ? r2.evidence : [], supported)).toBeNull();
  });

  test("assessStatement 不共享检测器状态：连续调用互不影响", () => {
    const fbA: FactEntry[] = [{ text: "water boils at one hundred degrees celsius", confidence: 0.95 }];
    const fbB: FactEntry[] = [{ text: "light travels fastest in vacuum", confidence: 0.9 }];
    const a1 = assessStatement(fbA, "water boils at one hundred degrees celsius at sea level");
    const a2 = assessStatement(fbB, "water boils at one hundred degrees celsius at sea level");
    expect(a1!.isAccepted).toBe(true);
    expect(a2!.isAccepted).toBe(false);
    // 再跑一次 a1 结论不变（无累积状态）
    expect(assessStatement(fbA, "water boils at one hundred degrees celsius at sea level")!.isAccepted).toBe(true);
  });
});

describe("④ factBase 构建纯函数", () => {
  test("knowledgeContext 解析为 FactEntry[]：提取 source、剔除检索头", () => {
    const facts = buildFactBaseFromRetrieval({
      knowledgeContext:
        '[自适应检索: "q"]\n检索范围: web\n找到 2 条结果:\n\n' +
        "• [web] Title A\n  Quantum decoherence explains loss of coherence.\n\n" +
        "• [vault] Title B\n  Spaced repetition improves retention.\n",
    });
    expect(facts.length).toBe(2);
    expect(facts[0]!.source).toBe("web");
    expect(facts[1]!.source).toBe("vault");
    expect(facts[0]!.text).toContain("Quantum decoherence");
    expect(facts.every((f) => f.confidence > 0 && f.confidence <= 1)).toBe(true);
  });

  test("codegraphContext 分块进入 factBase 且 source=codegraph", () => {
    const facts = buildFactBaseFromRetrieval({
      codegraphContext: "export function a() { return 1; }\n\nexport function b() { return 2; }",
    });
    expect(facts.length).toBeGreaterThanOrEqual(1);
    expect(facts.every((f) => f.source === "codegraph")).toBe(true);
  });

  test("knowledge+codegraph 同时提供时合并", () => {
    const facts = buildFactBaseFromRetrieval({
      knowledgeContext: "• [web] T\n  some web snippet text here\n",
      codegraphContext: "const x = 1;",
    });
    expect(facts.length).toBe(2);
  });

  test("空输入 → 空数组", () => {
    expect(buildFactBaseFromRetrieval({})).toEqual([]);
    expect(buildFactBaseFromRetrieval({ knowledgeContext: "", codegraphContext: "" })).toEqual([]);
  });

  test("DRE metadata.evidence：string[] 与 {text,confidence,source}[] 均可", () => {
    const a = buildFactBaseFromEvidence(["sky is blue", "grass is green"]);
    expect(a.length).toBe(2);
    expect(a[0]!.text).toBe("sky is blue");

    const b = buildFactBaseFromEvidence([
      { text: "fact one", confidence: 0.5, source: "retrieval" },
      { text: "" },
      42,
      null,
    ]);
    expect(b.length).toBe(1);
    expect(b[0]!.confidence).toBe(0.5);
    expect(b[0]!.source).toBe("retrieval");

    expect(buildFactBaseFromEvidence(undefined)).toEqual([]);
    expect(buildFactBaseFromEvidence("not an array")).toEqual([]);
  });
});
