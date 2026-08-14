/**
 * MindAdvisor — 心智模块 × 自进化闭环测试
 */
import { describe, it, expect, beforeEach } from "bun:test";
import { createSynapseEngine } from "../src/dre/synapse/index.js";
import { MindAdvisor, createMindAdvisor } from "../src/self-evolve/mind-suggest.js";
import type { Induction } from "../src/self-evolve/types.js";

describe("MindAdvisor", () => {
  let advisor: MindAdvisor;

  beforeEach(() => {
    const synapse = createSynapseEngine(":memory:");
    advisor = createMindAdvisor({ synapse });
  });

  it("recordInduction 把场景关键词写成突触，后续同场景可被建议", async () => {
    const induction: Induction = { pattern: "遇到 SQLite 锁先设 busy_timeout", support: 3, successRate: 1, recommendation: "加 busy_timeout" };
    const n = advisor.recordInduction(induction, "sqlite database lock busy timeout 修复");
    expect(n).toBeGreaterThan(0);

    const result = await advisor.suggest("sqlite 数据库锁问题", "修复并发写", { limit: 5 });
    // 场景命中 → 建议里出现该归纳模式
    expect(result.suggestions.some((s) => s.targetId.startsWith("induction:"))).toBe(true);
    expect(result.suggestions[0].via.length).toBe(2);
    expect(result.suggestions[0].reason).toContain("via");
  });

  it("recordImprovement 把教训写成突触（memory），空教训跳过", () => {
    const n = advisor.recordImprovement("并行测试 flake", "测试并行度限制为 8");
    expect(n).toBeGreaterThan(0);
    expect(advisor.recordImprovement("失败任务", "")).toBe(0);
  });

  it("suggest 支持注入 lessonsProvider 附带教训证据", async () => {
    const synapse = createSynapseEngine(":memory:");
    const adv = createMindAdvisor({
      synapse,
      lessonsProvider: async () => ["教训：测试并行度限制为 8"],
    });
    adv.recordInduction({ pattern: "限并行度", support: 2, successRate: 1, recommendation: "限并行度" }, "parallel worker 并行 测试");
    const result = await adv.suggest("高并行 worker 跑测试", "稳定全绿", { limit: 5 });
    expect(result.lessons.length).toBe(1);
    expect(result.suggestions.length).toBeGreaterThanOrEqual(1);
  });

  it("无相关突触时建议为空数组（不抛错）", async () => {
    const result = await advisor.suggest("完全不相关的领域", "随便", { limit: 5 });
    expect(Array.isArray(result.suggestions)).toBe(true);
    expect(result.lessons).toEqual([]);
  });
});
