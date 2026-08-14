/**
 * 峰谷费率调度（rate-tier）测试
 * DeepSeek 官方 2026-08-16 起：高峰 01:00-04:00 与 06:00-10:00 UTC，谷价 = 峰价一半。
 * 策略：高峰 deepseek-v4-pro 有效优先级 +8，flash/免费/其他供应商优先。
 */
import { describe, expect, it } from "bun:test";
import {
  isDeepSeekPeak,
  deepSeekRateTier,
  effectivePriorityForRateTier,
} from "../../src/router/rate-tier.js";

function utc(hour: number): Date {
  return new Date(`2026-08-14T${String(hour).padStart(2, "0")}:00:00Z`);
}

describe("isDeepSeekPeak / deepSeekRateTier", () => {
  it("高峰窗口 01-04 / 06-10 UTC 判定正确", () => {
    expect(isDeepSeekPeak(utc(0))).toBe(false);
    expect(isDeepSeekPeak(utc(1))).toBe(true);
    expect(isDeepSeekPeak(utc(2))).toBe(true);
    expect(isDeepSeekPeak(utc(3))).toBe(true);
    expect(isDeepSeekPeak(utc(4))).toBe(false); // 边界：04:00 结束
    expect(isDeepSeekPeak(utc(5))).toBe(false);
    expect(isDeepSeekPeak(utc(6))).toBe(true);
    expect(isDeepSeekPeak(utc(8))).toBe(true);
    expect(isDeepSeekPeak(utc(10))).toBe(false); // 边界：10:00 结束
    expect(isDeepSeekPeak(utc(12))).toBe(false);
  });

  it("deepSeekRateTier 返回 peak/off-peak", () => {
    expect(deepSeekRateTier(utc(2))).toBe("peak");
    expect(deepSeekRateTier(utc(12))).toBe("off-peak");
  });
});

describe("effectivePriorityForRateTier", () => {
  const pro = { provider: "deepseek", model: "deepseek-v4-pro", priority: 1 };
  const flash = { provider: "deepseek", model: "deepseek-v4-flash", priority: 2 };
  const glm = { provider: "zhipu", model: "glm-5.2", priority: 2 };

  it("谷时优先级不变", () => {
    expect(effectivePriorityForRateTier(pro, utc(12))).toBe(1);
    expect(effectivePriorityForRateTier(flash, utc(12))).toBe(2);
    expect(effectivePriorityForRateTier(glm, utc(12))).toBe(2);
  });

  it("高峰仅 deepseek-v4-pro 受罚（+8），flash 与其他供应商不变", () => {
    expect(effectivePriorityForRateTier(pro, utc(2))).toBe(9);
    expect(effectivePriorityForRateTier(flash, utc(2))).toBe(2);
    expect(effectivePriorityForRateTier(glm, utc(2))).toBe(2);
  });

  it("无 priority 时默认 99，高峰 pro 仍按 provider/model 识别", () => {
    expect(effectivePriorityForRateTier({ provider: "deepseek", model: "deepseek-v4-pro" }, utc(2))).toBe(107);
  });
});