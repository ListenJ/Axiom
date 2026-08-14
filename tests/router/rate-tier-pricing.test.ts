/**
 * rate-tier 扩展测试：峰谷价格表 / 成本估算 / env 开关
 */
import { afterEach, describe, expect, it } from "bun:test";
import {
  isDeepSeekPeak,
  effectivePriorityForRateTier,
  deepSeekInputPrice,
  deepSeekOutputPrice,
  estimateDeepSeekCostUsd,
  isRateTierSchedulingEnabled,
} from "../../src/router/rate-tier.js";

function utc(hour: number): Date {
  return new Date(`2026-08-14T${String(hour).padStart(2, "0")}:00:00Z`);
}

const originalEnv = process.env.DEEPSEEK_PEAK_SCHEDULING;

afterEach(() => {
  if (originalEnv === undefined) delete process.env.DEEPSEEK_PEAK_SCHEDULING;
  else process.env.DEEPSEEK_PEAK_SCHEDULING = originalEnv;
});

describe("DeepSeek V4 峰谷价格", () => {
  it("峰时 flash/pro 官方峰价，谷时半价", () => {
    expect(deepSeekInputPrice("deepseek-v4-flash", utc(2))).toBe(0.44);
    expect(deepSeekOutputPrice("deepseek-v4-flash", utc(2))).toBe(1.32);
    expect(deepSeekInputPrice("deepseek-v4-pro", utc(2))).toBe(1.32);
    expect(deepSeekOutputPrice("deepseek-v4-pro", utc(2))).toBe(3.96);
    expect(deepSeekInputPrice("deepseek-v4-flash", utc(12))).toBe(0.22);
    expect(deepSeekOutputPrice("deepseek-v4-flash", utc(12))).toBe(0.66);
    expect(deepSeekInputPrice("deepseek-v4-pro", utc(12))).toBe(0.66);
    expect(deepSeekOutputPrice("deepseek-v4-pro", utc(12))).toBe(1.98);
  });

  it("非 V4 模型返回 undefined", () => {
    expect(deepSeekInputPrice("deepseek-v3", utc(2))).toBeUndefined();
    expect(deepSeekOutputPrice("glm-5", utc(2))).toBeUndefined();
  });

  it("estimateDeepSeekCostUsd 按峰谷计价", () => {
    // 1M prompt + 1M output，flash 峰价 = 0.44 + 1.32 = 1.76 USD
    expect(estimateDeepSeekCostUsd("deepseek-v4-flash", 1_000_000, 1_000_000, utc(2))).toBeCloseTo(1.76, 5);
    // 谷价 = 0.22 + 0.66 = 0.88 USD
    expect(estimateDeepSeekCostUsd("deepseek-v4-flash", 1_000_000, 1_000_000, utc(12))).toBeCloseTo(0.88, 5);
    expect(estimateDeepSeekCostUsd("deepseek-v3", 100, 100, utc(2))).toBeUndefined();
  });
});

describe("DEEPSEEK_PEAK_SCHEDULING env 开关", () => {
  it("默认开启；0/false 关闭", () => {
    delete process.env.DEEPSEEK_PEAK_SCHEDULING;
    expect(isRateTierSchedulingEnabled()).toBe(true);
    process.env.DEEPSEEK_PEAK_SCHEDULING = "0";
    expect(isRateTierSchedulingEnabled()).toBe(false);
    process.env.DEEPSEEK_PEAK_SCHEDULING = "false";
    expect(isRateTierSchedulingEnabled()).toBe(false);
    process.env.DEEPSEEK_PEAK_SCHEDULING = "1";
    expect(isRateTierSchedulingEnabled()).toBe(true);
  });

  it("关闭时 effectivePriorityForRateTier 恒返回注册表原优先级", () => {
    process.env.DEEPSEEK_PEAK_SCHEDULING = "0";
    expect(effectivePriorityForRateTier({ provider: "deepseek", model: "deepseek-v4-pro", priority: 1 }, utc(2))).toBe(1);
    process.env.DEEPSEEK_PEAK_SCHEDULING = "1";
    expect(effectivePriorityForRateTier({ provider: "deepseek", model: "deepseek-v4-pro", priority: 1 }, utc(2))).toBe(9);
  });
});