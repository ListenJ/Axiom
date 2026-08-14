/**
 * 神经突触并发效果测试（需求 4：测试并发）
 */
import { describe, it, expect } from "bun:test";
import { createSynapseEngine } from "../src/dre/synapse/index.js";

describe("SynapseEngine 并发", () => {
  it("50 次并发激活同一突触：激活次数精确累计且验证链完整", async () => {
    const engine = createSynapseEngine(":memory:");
    const s = engine.createSynapse("scene:hot", "skill:hot-path", { sourceType: "scene", targetType: "skill", weight: 0.3 });

    const N = 50;
    await Promise.all(Array.from({ length: N }, (_, i) => Promise.resolve(engine.activate("scene:hot", `concurrent-${i}`, { delta: 0.1 }))));

    const after = engine.storeSnapshot().find((x) => x.id === s.id)!;
    expect(after.activationCount).toBe(N);
    expect(after.weight).toBeGreaterThan(s.weight);
    // 全链校验：50 次 activate + 1 create + decay 汇总
    expect(engine.verify(s.id).valid).toBe(true);
    const traces = engine.trace(s.id);
    expect(traces.filter((t) => t.operation === "activate").length).toBe(N);
    // 链式哈希连续（验证 verify 已覆盖，这里再显式检查 seq 连续）
    for (let i = 1; i < traces.length; i++) {
      expect(traces[i].seq).toBe(traces[i - 1].seq + 1);
    }
  });

  it("并发扩散激活多种子不崩溃且总量非负", async () => {
    const engine = createSynapseEngine(":memory:");
    for (let i = 0; i < 20; i++) {
      engine.createSynapse(`seed${i}`, `hop-${i}-a`, { sourceType: "scene", targetType: "skill", weight: 0.5 });
      engine.createSynapse(`hop-${i}-a`, `hop-${i}-b`, { sourceType: "concept", targetType: "skill", weight: 0.5 });
    }
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) => Promise.resolve(engine.spreadActivation([`seed${i}`], `concurrent-spread-${i}`, { maxHops: 2 }))),
    );
    for (const r of results) {
      expect(r.totalActivation).toBeGreaterThanOrEqual(0);
      expect(r.activated.length).toBeGreaterThanOrEqual(1);
    }
    // 全库突触验证链仍完整
    for (const s of engine.storeSnapshot()) {
      expect(engine.verify(s.id).valid).toBe(true);
    }
  });

  it("并发 suggest 幂等（只读建议不改坏验证链）", async () => {
    const engine = createSynapseEngine(":memory:");
    engine.createSynapse("scene:code", "skill:write-tests", { sourceType: "scene", targetType: "skill", weight: 0.7 });
    const out = await Promise.all(
      Array.from({ length: 20 }, () => engine.suggestNextSteps("writing code", "improve", { limit: 5 })),
    );
    for (const r of out) {
      expect(Array.isArray(r)).toBe(true);
    }
    for (const s of engine.storeSnapshot()) {
      expect(engine.verify(s.id).valid).toBe(true);
    }
  });
});
