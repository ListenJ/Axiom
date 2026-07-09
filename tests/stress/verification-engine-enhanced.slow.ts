/**
 * VerificationEngine 增强测试
 *
 * 验证 4 项新增功能:
 * 1. strictMode — 任何 issue 都标记 fail (覆盖 score-based verdict)
 * 2. expectedOutput 验证 — 字符串包含 / 对象 key / 数组长度
 * 3. refineCallback 超时 — LLM 挂起时 refine 循环不永久阻塞
 * 4. 对象 result 的证据验证 — 检查 evidence/sources/references 字段
 *
 * 注意: verificationEngine 是单例, 测试后需恢复配置。
 */

import { describe, test, expect, afterEach } from "bun:test";
import { verificationEngine } from "../../src/dre/runtime/verification-engine.js";
import type { VerificationConfig } from "../../src/dre/runtime/verification-engine.js";

const ORIGINAL_CONFIG: VerificationConfig = {
  confidenceThreshold: 0.6,
  llmFallbackThreshold: 0.5,
  strictMode: false,
  refineTimeoutMs: 30000,
};

afterEach(() => {
  // 恢复单例配置, 避免影响其他测试
  verificationEngine.updateConfig(ORIGINAL_CONFIG);
});

// ========== strictMode ==========

describe("VerificationEngine: strictMode", () => {
  test("strictMode=true: any issue should force verdict to fail", async () => {
    verificationEngine.updateConfig({ strictMode: true });

    // "hi" 太短 → 会产生 output issue (severity 5)
    // 正常模式下 score = (0.3+1+1+1)/4 = 0.825 ≥ 0.6 → pass
    // strictMode 下应被强制为 fail
    const report = await verificationEngine.verifyResult("strict-short", "hi");
    expect(report.issues.length).toBeGreaterThan(0);
    expect(report.overallVerdict).toBe("fail");
  });

  test("strictMode=true: no issues should still allow pass", async () => {
    verificationEngine.updateConfig({ strictMode: true });

    // 长字符串含 evidence 关键词 → 无 issue → pass
    const report = await verificationEngine.verifyResult(
      "strict-clean",
      "This is a valid result with evidence and source references.",
    );
    expect(report.issues.length).toBe(0);
    expect(report.overallVerdict).toBe("pass");
  });

  test("strictMode=false: short result with issue can still pass (score-based)", async () => {
    verificationEngine.updateConfig({ strictMode: false });

    // "hi" 太短 → output issue, 但 score = 0.825 ≥ 0.6 → pass
    const report = await verificationEngine.verifyResult("lenient-short", "hi");
    expect(report.issues.length).toBeGreaterThan(0);
    expect(report.overallVerdict).toBe("pass");
  });
});

// ========== expectedOutput 验证 ==========

describe("VerificationEngine: expectedOutput validation", () => {
  test("string expectedOutput: match (contains) should not add issue", async () => {
    const report = await verificationEngine.verifyResult("exp-str-match", "The answer is 42", {
      expectedOutput: "answer is 42",
    });
    const outputIssues = report.issues.filter((i) => i.type === "output");
    // 不应有 expectedOutput 相关的 issue (只有可能的 evidence issue)
    expect(outputIssues.length).toBe(0);
  });

  test("string expectedOutput: mismatch should add issue with severity 7", async () => {
    const report = await verificationEngine.verifyResult("exp-str-miss", "The answer is 42", {
      expectedOutput: "answer is 99",
    });
    const outputIssues = report.issues.filter((i) => i.type === "output");
    expect(outputIssues.length).toBe(1);
    expect(outputIssues[0].severity).toBe(7);
    expect(outputIssues[0].description).toContain("answer is 99");
  });

  test("object expectedOutput: missing keys should be reported", async () => {
    const report = await verificationEngine.verifyResult(
      "exp-obj-miss",
      { verdict: "accept", confidence: 0.9 },
      { expectedOutput: { verdict: "accept", confidence: 0.9, evidence_refs: [] } },
    );
    const outputIssues = report.issues.filter((i) => i.type === "output");
    expect(outputIssues.length).toBe(1);
    expect(outputIssues[0].description).toContain("evidence_refs");
  });

  test("object expectedOutput: all keys present should not add issue", async () => {
    const report = await verificationEngine.verifyResult(
      "exp-obj-match",
      { verdict: "accept", confidence: 0.9, evidence: ["node-1"] },
      { expectedOutput: { verdict: "accept", confidence: 0.9 } },
    );
    const outputIssues = report.issues.filter((i) => i.type === "output");
    expect(outputIssues.length).toBe(0);
  });

  test("array expectedOutput: insufficient length should be reported", async () => {
    const report = await verificationEngine.verifyResult(
      "exp-arr-miss",
      [1, 2],
      { expectedOutput: [1, 2, 3, 4] },
    );
    const outputIssues = report.issues.filter((i) => i.type === "output");
    expect(outputIssues.length).toBe(1);
    expect(outputIssues[0].description).toContain("length 2");
  });
});

// ========== 对象证据验证 ==========

describe("VerificationEngine: object evidence verification", () => {
  test("object with evidence field should not trigger evidence issue", async () => {
    const report = await verificationEngine.verifyResult("evi-obj-has", {
      verdict: "accept",
      evidence: ["node-1", "node-2"],
    });
    const evidenceIssues = report.issues.filter((i) => i.type === "evidence");
    expect(evidenceIssues.length).toBe(0);
    expect(report.scores.evidence).toBe(1.0);
  });

  test("object with sources field should not trigger evidence issue", async () => {
    const report = await verificationEngine.verifyResult("evi-obj-src", {
      verdict: "accept",
      sources: ["doc-1"],
    });
    const evidenceIssues = report.issues.filter((i) => i.type === "evidence");
    expect(evidenceIssues.length).toBe(0);
  });

  test("object without evidence fields should trigger evidence issue", async () => {
    const report = await verificationEngine.verifyResult("evi-obj-none", {
      verdict: "accept",
      confidence: 0.9,
    });
    const evidenceIssues = report.issues.filter((i) => i.type === "evidence");
    expect(evidenceIssues.length).toBe(1);
    expect(report.scores.evidence).toBe(0.3);
  });

  test("object with empty evidence array should trigger evidence issue", async () => {
    const report = await verificationEngine.verifyResult("evi-obj-empty", {
      verdict: "accept",
      evidence: [],
    });
    const evidenceIssues = report.issues.filter((i) => i.type === "evidence");
    expect(evidenceIssues.length).toBe(1);
    expect(report.scores.evidence).toBe(0.3);
  });

  test("string result still uses keyword-based evidence check", async () => {
    const report = await verificationEngine.verifyResult(
      "evi-str-keyword",
      "Based on evidence from node_id abc, the result is confirmed.",
    );
    const evidenceIssues = report.issues.filter((i) => i.type === "evidence");
    expect(evidenceIssues.length).toBe(0);
  });
});

// ========== refineCallback 超时 ==========

describe("VerificationEngine: refineCallback timeout", () => {
  test("slow refineCallback should timeout and break the loop", async () => {
    verificationEngine.updateConfig({ refineTimeoutMs: 100 });

    const slowCallback = async () => {
      await new Promise((r) => setTimeout(r, 5000)); // 5s, 远超 100ms 超时
      return "This is a refined result with evidence and source references.";
    };

    // null → verdict=fail, 触发 refine 循环
    const start = Date.now();
    const report = await verificationEngine.verifyResult("refine-timeout", null, {
      refineCallback: slowCallback,
      maxRefine: 3,
    });
    const elapsed = Date.now() - start;

    // 应在 ~100ms 后超时退出, 而非等 5s
    expect(elapsed).toBeLessThan(2000);
    // 超时后 refine 循环中断, iterations 应为 0 (未成功完成 refine)
    expect(report.refineIterations).toBe(0);
    // 最终 result 仍是原始 result (未被 refine)
    expect(report.finalResult).toBeNull();
  });

  test("fast refineCallback should complete within timeout", async () => {
    verificationEngine.updateConfig({ refineTimeoutMs: 5000 });

    const fastCallback = async () => {
      return "This is a refined result with evidence and source references.";
    };

    // null → verdict=fail, 触发 refine 循环
    const report = await verificationEngine.verifyResult("refine-fast", null, {
      refineCallback: fastCallback,
      maxRefine: 2,
    });

    // refine 应成功执行
    expect(report.refineIterations).toBe(1);
    // finalResult 应是 refine 后的版本
    expect(report.finalResult).toContain("refined result");
    // refine 后 verdict 应为 pass
    expect(report.overallVerdict).toBe("pass");
  });
});
