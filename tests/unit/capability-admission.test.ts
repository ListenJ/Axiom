/**
 * ADR-014 §4 第 4 步：验证后准入（Validate）——缺口/候选 → eval 验证 → 达标才注册。
 *
 * 覆盖两层：
 *   - 内核 `admitCapability`：缺验证器 / 未过 / 验证抛错 → 拒绝（fail-closed），不注册；
 *   - 组合层 `createEvalCapabilityValidator`：由 `src/eval` 适配，评测不可用/无样例 → 拒绝。
 */
import { describe, test, expect, beforeEach } from "bun:test";
import { capabilityRegistry, CapabilityRegistrationError, type CapabilityProvider } from "../../src/dre/runtime/capability-registry.js";
import { createEvalCapabilityValidator, type EvalFn } from "../../src/eval/capability-validator.js";
import type { EvaluatedResponse } from "../../src/eval/judge.js";

const base = (over: Partial<CapabilityProvider>): CapabilityProvider => ({
  id: "adm-1",
  name: "Admission Provider",
  type: "external",
  capabilities: ["analysis.summarization"],
  costPerCall: 0,
  avgLatencyMs: 5,
  reliability: 0.9,
  maxConcurrency: 2,
  metadata: {},
  placement: "periphery",
  isolation: "in-process",
  sideEffects: ["internal"],
  invoke: async () => ({ ok: true }),
  ...over,
});

describe("ADR-014 §4 Validate：验证后准入", () => {
  beforeEach(() => capabilityRegistry.reset());

  test("缺验证器 → 拒绝（未经验证不得注册）", async () => {
    await expect(
      capabilityRegistry.admitCapability(base({}), { validator: undefined as never }),
    ).rejects.toThrow(CapabilityRegistrationError);
    expect(capabilityRegistry.listByContract("analysis.summarization")).toHaveLength(0);
  });

  test("验证通过 → 注册成立", async () => {
    const verdict = await capabilityRegistry.admitCapability(base({}), {
      validator: () => ({ pass: true, score: 8, reason: "ok" }),
    });
    expect(verdict.pass).toBe(true);
    expect(capabilityRegistry.listByContract("analysis.summarization")).toHaveLength(1);
  });

  test("验证未通过 → 拒绝，不注册", async () => {
    await expect(
      capabilityRegistry.admitCapability(base({}), { validator: () => ({ pass: false, reason: "score too low" }) }),
    ).rejects.toThrow(/验证未通过/);
    expect(capabilityRegistry.listByContract("analysis.summarization")).toHaveLength(0);
  });

  test("验证器抛错 → fail-closed 拒绝，不注册", async () => {
    await expect(
      capabilityRegistry.admitCapability(base({}), { validator: () => { throw new Error("eval down"); } }),
    ).rejects.toThrow(/fail-closed/);
    expect(capabilityRegistry.listByContract("analysis.summarization")).toHaveLength(0);
  });

  test("eval 适配器：注入评测返回高分 → pass；低分 → fail", async () => {
    const high: EvalFn = async () => ({ overallScore: 8 } as EvaluatedResponse);
    const low: EvalFn = async () => ({ overallScore: 3 } as EvaluatedResponse);
    const vHigh = createEvalCapabilityValidator({ evaluate: high, sampleOutputFor: () => "candidate output" });
    const vLow = createEvalCapabilityValidator({ evaluate: low, sampleOutputFor: () => "candidate output" });
    expect((await vHigh({ provider: base({}), contract: "analysis.summarization" })).pass).toBe(true);
    expect((await vLow({ provider: base({}), contract: "analysis.summarization" })).pass).toBe(false);
  });

  test("eval 适配器：评测抛错 / 无样例 → fail-closed", async () => {
    const boom: EvalFn = async () => { throw new Error("no judge"); };
    const v1 = createEvalCapabilityValidator({ evaluate: boom, sampleOutputFor: () => "x" });
    expect((await v1({ provider: base({}), contract: "analysis.summarization" })).pass).toBe(false);
    const v2 = createEvalCapabilityValidator({ evaluate: boom }); // 无 sampleOutputFor
    expect((await v2({ provider: base({}), contract: "analysis.summarization" })).pass).toBe(false);
  });

  test("eval 适配器：requireSafety 且安全不达标 → fail", async () => {
    const fn: EvalFn = async () => ({ overallScore: 9, safety: { safetyScore: 10, refused: false, piiExposed: false, jailbreakResisted: true, biasDetected: false } } as EvaluatedResponse);
    const v = createEvalCapabilityValidator({ evaluate: fn, sampleOutputFor: () => "x", requireSafety: true, minSafety: 80 });
    expect((await v({ provider: base({}), contract: "analysis.summarization" })).pass).toBe(false);
  });
});
