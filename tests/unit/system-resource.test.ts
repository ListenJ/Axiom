import { describe, test, expect } from "bun:test";
import { ResourceBudgetManager, getResourceBudgetManager } from "../../src/dre/system-resource";

/**
 * H2 审计修复回归：recommendedMaxTokens 单位量纲
 *
 * 物理：availableForKV(MB) × 1024 × 1024 = 字节；÷ bytesPerToken(229376B) = token 数
 * 默认场景：min(4000-1100, 2200)=2200MB → 2200×1048576/229376 ≈ 10057 tokens（未封顶）
 */
describe("system-resource token 预算量纲（H2 回归）", () => {
  test("2200MB KV 预算 ≈ 10057 tokens（封顶前）", () => {
    const mgr = new ResourceBudgetManager({
      resource: { maxMemory: 4000, availableMemory: 3300 },
      modelMemoryMB: 1100,
      safetyMarginMB: 200,
      kvCacheMaxMB: 2200,
      maxTokensCap: 1_000_000, // 不封顶，验证物理计算本身
    });
    const s = mgr.getStatus();
    expect(s.recommendedMaxTokens).toBe(10057);
  });

  test("默认 cap=4096 时输出 4096", () => {
    const mgr = new ResourceBudgetManager({
      resource: { maxMemory: 4000, availableMemory: 3300 },
    });
    const s = mgr.getStatus();
    expect(s.recommendedMaxTokens).toBe(4096);
  });

  test("内存不足时 canRun=false 且无 token 建议（既有行为防回归）", () => {
    const mgr = new ResourceBudgetManager({ resource: { availableMemory: 1000, maxMemory: 4000 } });
    const check = mgr.canRun();
    expect(check.canRun).toBe(false);
    expect(check.recommendedMaxTokens).toBeUndefined();
    expect(check.reason).toContain("Insufficient memory");
  });

  test("推导溯源：Qwen3-1.7B 单token≈229KB（既有断言保留）", () => {
    const layers = 28, hidden = 2048, bytesPerToken = 2 * hidden * 2 * layers;
    expect(bytesPerToken).toBeGreaterThan(200 * 1024);
    expect(bytesPerToken).toBe(229376);
  });

  test("全局单例默认输出为封顶后 4096（消费方可依赖的稳定契约）", () => {
    const s = getResourceBudgetManager().getStatus();
    expect(s.canRunLocal).toBe(true);
    expect(s.recommendedMaxTokens).toBe(4096);
  });
});
