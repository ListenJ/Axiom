/**
 * 峰谷费率调度（Rate Tier Routing）— 2026-08-16 起 DeepSeek 官方峰谷计费。
 *
 * 事实（api-docs.deepseek.com/quick_start/pricing/）：
 *   - 高峰时段 01:00-04:00 与 06:00-10:00 UTC；其余为谷时，谷价 = 峰价一半。
 *   - flash：峰 $0.44 入 / $1.32 出；谷 $0.22 入 / $0.66 出。
 *   - pro：峰 $1.32 入 / $3.96 出；谷 $0.66 入 / $1.98 出。
 *
 * 策略：高峰时将 deepseek-v4-pro 的有效优先级调低（+8），让 flash/免费/其他供应商优先；
 * 谷时恢复原优先级。纯函数、可测试；由 model-router 的 execute/chatStream 排序接入。
 */
export type RateTier = "peak" | "off-peak";

export const DEEPSEEK_PEAK_WINDOWS: ReadonlyArray<{ start: number; end: number }> = [
  { start: 1, end: 4 },
  { start: 6, end: 10 },
];

/** 当前 UTC 小时是否处于 DeepSeek 高峰（01-04 / 06-10 UTC） */
export function isDeepSeekPeak(date: Date = new Date()): boolean {
  const h = date.getUTCHours();
  return DEEPSEEK_PEAK_WINDOWS.some((w) => h >= w.start && h < w.end);
}

export function deepSeekRateTier(date: Date = new Date()): RateTier {
  return isDeepSeekPeak(date) ? "peak" : "off-peak";
}

export interface RateTierModel {
  provider: string;
  model: string;
  priority?: number;
}

/** 高峰对 deepseek-v4-pro 的优先级惩罚（数字越大越靠后） */
const DEEPSEEK_PEAK_PENALTY = 8;

/** 按峰谷时段计算模型有效优先级（供排序比较器使用） */
export function effectivePriorityForRateTier(
  model: RateTierModel,
  date: Date = new Date(),
): number {
  const base = model.priority ?? 99;
  if (!isDeepSeekPeak(date)) return base;
  if (model.provider === "deepseek" && model.model === "deepseek-v4-pro") {
    return base + DEEPSEEK_PEAK_PENALTY;
  }
  return base;
}
