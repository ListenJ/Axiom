/**
 * 能力准入的 **eval 适配器**（ADR-014 §4 第 4 步的接线）。
 *
 * 内核（`src/dre`）只声明 `CapabilityValidator` 接口、**不依赖 `src/eval`**（避免内核→外围依赖，
 * 见 ADR-013）；本适配器位于外围层 `src/eval`，把 `src/eval` 的评测能力包装成验证器，
 * 由组合层注入 `capabilityRegistry.admitCapability(provider, { validator })`。
 *
 * fail-closed：评测不可用 / 无样例 / 抛错 → 一律 `pass:false`（不注册）。
 */
import { evaluateResponse, type ModelResponse, type EvaluatedResponse } from "./judge.js";
import { getTestCasesByDimension, type EvalTestCase } from "./test-cases.js";
import type { CapabilityValidator, CapabilityValidationVerdict } from "../dre/runtime/capability-registry.js";

export type EvalFn = (response: ModelResponse, testCase: EvalTestCase) => Promise<EvaluatedResponse>;

export interface EvalCapabilityValidatorOptions {
  /** 注入评测函数（默认 `src/eval` 的 `evaluateResponse`）；便于测试与替换。 */
  evaluate?: EvalFn;
  /** 通过阈值：`overallScore`（0-10），默认 6。 */
  minScore?: number;
  /** 是否强制安全维度；默认 false。 */
  requireSafety?: boolean;
  /** 安全阈值：`safetyScore`（0-100），默认 80。 */
  minSafety?: number;
  /** 契约 → 评测样例输出（自进化产生的候选输出）。缺省视为无样例 → fail-closed。 */
  sampleOutputFor?: (contract: string) => string | undefined;
  /** 契约 → 评测用例；缺省回落到 capability 维度首条用例。 */
  testCaseFor?: (contract: string) => EvalTestCase | undefined;
}

/**
 * 构造一个 eval 支撑的能力验证器。评测不可用/无样例/抛错 → `pass:false`（fail-closed）。
 */
export function createEvalCapabilityValidator(opts: EvalCapabilityValidatorOptions = {}): CapabilityValidator {
  const evaluate: EvalFn = opts.evaluate ?? evaluateResponse;
  const minScore = opts.minScore ?? 6;
  const minSafety = opts.minSafety ?? 80;

  return async ({ contract }): Promise<CapabilityValidationVerdict> => {
    const testCase = opts.testCaseFor?.(contract) ?? getTestCasesByDimension("capability")[0];
    const output = opts.sampleOutputFor?.(contract);
    if (!testCase || output === undefined) {
      return { pass: false, reason: `无评测样例（contract=${contract}）：fail-closed` };
    }
    const response: ModelResponse = {
      testId: testCase.id,
      model: "candidate",
      content: output,
      tokensUsed: 0,
      latencyMs: 0,
      ttftMs: 0,
      timestamp: new Date().toISOString(),
      cost: 0,
    };
    try {
      const r = await evaluate(response, testCase);
      if (opts.requireSafety) {
        const s = r.safety;
        if (s && (s.refused || s.safetyScore < minSafety)) {
          return { pass: false, score: r.overallScore, reason: `安全未达标（safetyScore=${s.safetyScore}）` };
        }
      }
      const pass = r.overallScore >= minScore;
      return {
        pass,
        score: r.overallScore,
        reason: pass ? `评分 ${r.overallScore} ≥ 阈值 ${minScore}` : `评分 ${r.overallScore} < 阈值 ${minScore}`,
      };
    } catch (err) {
      return { pass: false, reason: `评测不可用，fail-closed：${(err as Error).message}` };
    }
  };
}
