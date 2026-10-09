/**
 * ADR-014 自进化**端到端演练**（用注入评测真跑，无需外部模型）：
 *   Observe(gap) → Propose(candidate) → Validate(admit) → Register → Invoke → Retire
 *
 * 证明闭环可跑通、且验证不通过时 fail-closed（不注册、缺口仍在）。
 */
import { describe, test, expect, beforeEach } from "bun:test";
import { capabilityRegistry, type CapabilityProvider } from "../../src/dre/runtime/capability-registry.js";
import { createEvalCapabilityValidator, type EvalFn } from "../../src/eval/capability-validator.js";
import type { EvaluatedResponse } from "../../src/eval/judge.js";

const CONTRACT = "analysis.summarization";

function candidate(invoke: CapabilityProvider["invoke"]): CapabilityProvider {
  return {
    id: "evo-1",
    name: "Evolved Provider",
    type: "external",
    capabilities: [CONTRACT],
    costPerCall: 0,
    avgLatencyMs: 1,
    reliability: 0.8,
    maxConcurrency: 1,
    metadata: {},
    placement: "periphery",
    isolation: "in-process",
    sideEffects: ["internal"],
    invoke,
  };
}

const passEval: EvalFn = async () => ({ overallScore: 9 } as EvaluatedResponse);
const failEval: EvalFn = async () => ({ overallScore: 2 } as EvaluatedResponse);
const validator = (evaluate: EvalFn) => createEvalCapabilityValidator({ evaluate, sampleOutputFor: () => "candidate output" });

describe("ADR-014 自进化端到端闭环", () => {
  beforeEach(() => capabilityRegistry.reset());

  test("gap → admit(validate) → invoke → retire 全链跑通", async () => {
    // 1) Observe：检索空 → 记 miss
    expect(capabilityRegistry.select(CONTRACT)).toBeNull();
    const gaps = capabilityRegistry.analyzeGaps();
    const gap = gaps.find((g) => g.contract === CONTRACT && g.kind === "no-provider");
    expect(gap).toBeDefined();

    // 2) Propose：候选 provider（外围、进程内、内部副作用）
    let invoked = 0;
    const cand = candidate(async (req) => {
      invoked++;
      return { ok: true, echo: req.x };
    });

    // 3) Validate + Register：eval 通过才准入
    const verdict = await capabilityRegistry.admitCapability(cand, { validator: validator(passEval), gap });
    expect(verdict.pass).toBe(true);
    expect(capabilityRegistry.listContracts()).toContain(CONTRACT); // 缺口已填

    // 4) Invoke：按声明执行并记结果
    const out = await capabilityRegistry.invokeCapability(CONTRACT, { x: 42 });
    expect(out).toEqual({ ok: true, echo: 42 });
    expect(invoked).toBe(1);

    // 5) Retire：撤销 provider → 契约回落为不可服务
    expect(capabilityRegistry.unregisterProvider("evo-1")).toBe(true);
    expect(capabilityRegistry.listContracts()).not.toContain(CONTRACT);
  });

  test("验证不通过 → fail-closed：不注册、缺口仍在（闭环被拦住）", async () => {
    capabilityRegistry.select(CONTRACT); // 观测缺口
    let invoked = 0;
    const cand = candidate(async () => { invoked++; return { ok: true }; });
    await expect(
      capabilityRegistry.admitCapability(cand, { validator: validator(failEval) }),
    ).rejects.toThrow(/验证未通过/);
    expect(capabilityRegistry.listContracts()).not.toContain(CONTRACT); // 未注册
    expect(invoked).toBe(0);
    const gaps = capabilityRegistry.analyzeGaps();
    expect(gaps.some((g) => g.contract === CONTRACT && g.kind === "no-provider")).toBe(true); // 缺口仍在
  });

  test("退役后可再次观测到缺口（闭环可重复）", async () => {
    capabilityRegistry.select(CONTRACT);
    await capabilityRegistry.admitCapability(candidate(async () => ({ ok: true })), { validator: validator(passEval) });
    capabilityRegistry.unregisterProvider("evo-1");
    capabilityRegistry.reset();
    capabilityRegistry.select(CONTRACT); // 退役/重置后再观测
    expect(capabilityRegistry.analyzeGaps().some((g) => g.kind === "no-provider")).toBe(true);
  });
});
