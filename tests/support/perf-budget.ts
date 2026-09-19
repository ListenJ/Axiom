/**
 * 性能断言口径（2026-09-20 统一）
 *
 * ## 问题
 * 本仓库默认套件以 `--parallel=8` 运行（`package.json` 的 `test`）。CPU 争用会让**绝对墙钟阈值**
 * 偶发失败 —— 实测（2026-09-20）：
 *   - `tests/stress/high-intensity-load.test.ts` 的 `p99 < 50ms` 等：**干净 HEAD 上同样 2 fail**；
 *   - `tests/edge-cases/performance-degradation.test.ts`：同一棵树交替跑 3 次 0 fail，另一次 1 fail；
 *   - `tests/business-scenarios/retrieval-workflows.test.ts:713` 的 `latencyMs < 500`：全量并行下偶发。
 * ⇒ 结论：**绝对墙钟阈值是"基准"（benchmark），不是"正确性"**；在并行套件里当门禁必然偶发红，
 *   而偶发红的门禁会让人习惯性忽略红灯，比没有门禁更糟。
 *
 * ## 口径
 * - **默认（并行套件）**：只做**防挂起上界**（宽松），仍能拦住"卡死 / 数量级爆炸"这类真问题；
 * - **`AXIOM_PERF_ASSERT=1`**（专属性能门禁：`test:perf` / `test:gate` / `test:stress`）：使用**严格阈值**。
 *
 * 与既有结构一致：CI 的 `stress-test` job 本就区分"`test:gate` 阻塞"与"`stress:compare` 仅报告"，
 * 本文件只是把同一分层下沉到断言级。
 */

/** 是否处于严格性能断言模式（由专属性能脚本设置） */
export const PERF_ASSERT_STRICT = process.env.AXIOM_PERF_ASSERT === "1";

/**
 * 返回本次应使用的阈值：严格模式用 `strictMs`，否则用宽松的防挂起上界 `relaxedMs`。
 */
export function perfBudget(strictMs: number, relaxedMs: number): number {
  return PERF_ASSERT_STRICT ? strictMs : relaxedMs;
}
