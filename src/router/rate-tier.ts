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
import { readString } from "../utils/env.js";

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
  if (!isRateTierSchedulingEnabled()) return base;
  if (!isDeepSeekPeak(date)) return base;
  if (model.provider === "deepseek" && model.model === "deepseek-v4-pro") {
    return base + DEEPSEEK_PEAK_PENALTY;
  }
  return base;
}


// ═════════════════════════════════════════════════════════════════
// DeepSeek V4 峰谷价格表（$/1M tokens，2026-08-16 起官方峰谷计费）
// 峰价：flash $0.44 入 / $1.32 出；pro $1.32 入 / $3.96 出。谷价 = 峰价一半。
// ═════════════════════════════════════════════════════════════════

export const DEEPSEEK_PEAK_PRICING: Record<string, { input: number; output: number }> = {
  "deepseek-v4-flash": { input: 0.44, output: 1.32 },
  "deepseek-v4-pro": { input: 1.32, output: 3.96 },
};

/** 当前时段 DeepSeek 输入价格（$/1M tokens）；非 V4 模型返回 undefined */
export function deepSeekInputPrice(model: string, date: Date = new Date()): number | undefined {
  const p = DEEPSEEK_PEAK_PRICING[model];
  if (!p) return undefined;
  return isDeepSeekPeak(date) ? p.input : p.input / 2;
}

/** 当前时段 DeepSeek 输出价格（$/1M tokens）；非 V4 模型返回 undefined */
export function deepSeekOutputPrice(model: string, date: Date = new Date()): number | undefined {
  const p = DEEPSEEK_PEAK_PRICING[model];
  if (!p) return undefined;
  return isDeepSeekPeak(date) ? p.output : p.output / 2;
}

/** 估算一次 DeepSeek 调用的成本（USD），按调用时刻峰/谷计价 */
export function estimateDeepSeekCostUsd(
  model: string,
  promptTokens: number,
  completionTokens: number,
  date: Date = new Date(),
): number | undefined {
  const input = deepSeekInputPrice(model, date);
  const output = deepSeekOutputPrice(model, date);
  if (input === undefined || output === undefined) return undefined;
  return (promptTokens * input + completionTokens * output) / 1_000_000;
}

/**
 * 峰谷调度开关（.env: DEEPSEEK_PEAK_SCHEDULING）
 * 默认开启；设为 0/false/no 时关闭（优先级恒用注册表原值）。
 */
export function isRateTierSchedulingEnabled(): boolean {
  const v = readString("DEEPSEEK_PEAK_SCHEDULING", "1");
  const n = v.toLowerCase();
  return n === "1" || n === "true" || n === "yes";
}

// ═════════════════════════════════════════════════════════════════
// 多供应商直连价（USD/1M tokens）——成本估算
// 来源（2026-08-14 官方文档抓取，见 docs/deepseek-api-v4-optimization-2026-08-14.md）：
//   - Kimi：platform.kimi.com/docs/pricing/chat-k26.md / chat-k25.md / chat-k3.md（CNY）
//   - MiniMax：platform.minimaxi.com/docs/guides/pricing-paygo.md（CNY，M3 五折后标准价 ≤512k）
//   - 智谱：docs.bigmodel.cn 免费模型 glm-4.7-flash / glm-4-flash（0 元）
// CNY→USD 用估算汇率（假设，非官方），用于统一成本面板展示。
// ═════════════════════════════════════════════════════════════════

/**
 * CNY→USD 估算汇率（成本估算用，非官方；默认 7.2，可用 COST_CNY_PER_USD 覆盖）。
 * 启动时读取一次（MODEL_PRICING 静态构建用）。
 */
export function getCnyPerUsd(): number {
  const v = readString("COST_CNY_PER_USD", "");
  if (v === "") return 7.2;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 7.2;
}

/** 启动时快照的汇率（MODEL_PRICING 构建用；运行时双币换算请用 getCnyPerUsd()） */
export const CNY_PER_USD = getCnyPerUsd();

/** 成本 USD → CNY 换算（展示用） */
export function costUsdToCny(usd: number): number {
  return usd * getCnyPerUsd();
}

interface StaticModelPricing {
  inputUsd: number;
  outputUsd: number;
}

function cnyToUsd(v: number): number {
  return v / CNY_PER_USD;
}

/** 直连价表，键 = provider/model（与注册表 model 字段一致） */
export const MODEL_PRICING: Record<string, StaticModelPricing> = {
  // Kimi（直连价，¥/1M → USD）
  "kimi/kimi-k2.6": { inputUsd: cnyToUsd(6.5), outputUsd: cnyToUsd(27) },
  "kimi/kimi-k2.5": { inputUsd: cnyToUsd(4), outputUsd: cnyToUsd(21) },
  "kimi/kimi-k3": { inputUsd: cnyToUsd(20), outputUsd: cnyToUsd(100) },
  // MiniMax（直连价，M3 五折后标准价）
  "minimax/MiniMax-M3": { inputUsd: cnyToUsd(2.1), outputUsd: cnyToUsd(8.4) },
  "minimax/MiniMax-M2.7": { inputUsd: cnyToUsd(2.1), outputUsd: cnyToUsd(8.4) },
  "minimax/MiniMax-M2.5": { inputUsd: cnyToUsd(2.1), outputUsd: cnyToUsd(8.4) },
  // 智谱（免费模型）
  "zhipu/glm-4.7-flash": { inputUsd: 0, outputUsd: 0 },
  "zhipu/glm-4-flash": { inputUsd: 0, outputUsd: 0 },
};

/**
 * 估算一次调用的成本（USD）：
 *   1. DeepSeek V4 优先走峰谷计价（model 名匹配）；
 *   2. 其余走 MODEL_PRICING 直连价表（provider/model 匹配）；
 *   3. 未收录返回 undefined（成本记为 0，可后续扩展）。
 */
export function estimateModelCostUsd(
  provider: string,
  model: string,
  promptTokens: number,
  completionTokens: number,
  date: Date = new Date(),
): number | undefined {
  const ds = estimateDeepSeekCostUsd(model, promptTokens, completionTokens, date);
  if (ds !== undefined) return ds;
  const p = MODEL_PRICING[`${provider}/${model}`];
  if (!p) return undefined;
  return (promptTokens * p.inputUsd + completionTokens * p.outputUsd) / 1_000_000;
}
