/**
 * 回归自动检测纯函数（S5）— run.ts CLI 的判定逻辑剥离层。
 *
 * 定位：run.ts 是带顶层副作用的 CLI 脚本（真正跑评测 + process.exit），无法被
 * 单测 import；本模块只做「要不要查、查了算不算回归」的有状态判定，无任何副作用。
 * 判定复用 registry.checkRegression（自动取同族同模型同 split 历史最优，或显式
 * --baseline），本层只负责区分三类跳过原因，供 run.ts 做分级退出码与 stderr 告警。
 */
import type { Registry, RegressionCheck } from "./registry.js";

/** autoCheckRegression 一次判定的完整结果 */
export interface AutoCheckOutcome {
  /** 是否实际执行了一次对比（false = 因故跳过） */
  checked: boolean;
  /** 对比是否判回归（仅 checked 时有意义） */
  regressed: boolean;
  /** 判定详情（checked 时非空） */
  check: RegressionCheck | null;
  /** 跳过原因；null = 正常对比过 */
  skipped: "no-candidate" | "no-baseline" | null;
}

/**
 * 评测落库后自动回归检测。
 * runId null（--no-persist）→ 纯无操作；候选轮缺失 → no-candidate；
 * 同作用域无可比基准 → no-baseline；正常对比 → checked + regressed/check。
 */
export function autoCheckRegression(
  registry: Registry,
  opts: { runId: number | null; baseline?: string | number; maxDropPp?: number },
): AutoCheckOutcome {
  const { runId, baseline, maxDropPp } = opts;
  if (runId === null) return { checked: false, regressed: false, check: null, skipped: null };
  if (registry.getRun(runId) === null) {
    return { checked: false, regressed: false, check: null, skipped: "no-candidate" };
  }
  const check = registry.checkRegression(runId, { baseline, maxDropPp });
  if (check === null) {
    return { checked: false, regressed: false, check: null, skipped: "no-baseline" };
  }
  return { checked: true, regressed: check.regressed, check, skipped: null };
}