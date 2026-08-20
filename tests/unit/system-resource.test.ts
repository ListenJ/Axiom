import { describe, test, expect } from "bun:test";
import { getResourceBudgetManager } from "../../src/dre/system-resource";

describe("system-resource bytesPerToken", () => {
  test("2200MB预算应得≈9 tokens而非112万", () => {
    const mgr = getResourceBudgetManager();
    // 当前错误 bytesPerToken=2 会得 1_126_400 (capped 4096) -> >20
    // 正确 28*2048*2*2≈229KB => 2200*1024/229376≈9.8 => capped 9
    const s = mgr.getStatus();
    expect(s.recommendedMaxTokens).toBeLessThan(20);
    expect(s.recommendedMaxTokens).toBeGreaterThan(5);
  });
  test("推导溯源：Qwen3-1.7B 单token≈229KB", () => {
    const layers = 28, hidden = 2048, bytesPerToken = 2 * hidden * 2 * layers; // 简化 K/V FP16
    // 28*2048*2*2 = 229376 bytes ≈224KB (1024) / 229KB (1000)
    expect(bytesPerToken).toBeGreaterThan(200 * 1024);
    expect(bytesPerToken).toBe(229376);
  });
});
