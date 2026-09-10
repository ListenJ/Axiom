/**
 * 心智模型性能测试 — 长验证链追加（O(n²) → O(1) 回归护栏）
 *
 * 修复前 appendTrace 每次全量加载 traces 计算 seq（O(n)），n 次激活 = O(n²)。
 * 修复后用 store.nextSeq（单条 MAX(seq)）→ 线性。本测试护栏：
 *   1) 1000 次激活必须在宽松时限内完成；
 *   2) 验证链完整、激活次数精确、seq 连续。
 */
import { describe, it, expect } from "bun:test";
import { createSynapseEngine } from "../src/dre/synapse/index.js";

describe("SynapseEngine 性能", () => {
  it("1000 次激活：线性追加 + 验证链完整（O(n²)→O(1) 护栏）", () => {
    const engine = createSynapseEngine(":memory:");
    const s = engine.createSynapse("scene:hot", "skill:hot-path", { sourceType: "scene", targetType: "skill", weight: 0.3 });
    const N = 1000;
    const t0 = performance.now();
    for (let i = 0; i < N; i++) engine.activate("scene:hot", `act-${i}`, { delta: 0.01 });
    const elapsed = performance.now() - t0;

    // 宽松上限：修复后 1000 次 < 500ms；若回归 O(n²) 会显著超时
    expect(elapsed).toBeLessThan(5000);
    const after = engine.storeSnapshot().find((x) => x.id === s.id)!;
    expect(after.activationCount).toBe(N);
    expect(engine.verify(s.id).valid).toBe(true);
    const traces = engine.trace(s.id);
    expect(traces.length).toBe(N + 1); // create + N activate（无其他突触 → 无衰减）
    for (let i = 1; i < traces.length; i++) expect(traces[i].seq).toBe(traces[i - 1].seq + 1);
  });

  it("5000 次扩散访问不崩溃（BFS 索引队列）", () => {
    const engine = createSynapseEngine(":memory:");
    // 链式网络：seed → n1 → n2 → ... → n500
    for (let i = 0; i < 500; i++) {
      engine.createSynapse(`n${i}`, `n${i + 1}`, { sourceType: "concept", targetType: "concept", weight: 0.5 });
    }
    const r = engine.spreadActivation(["n0"], "deep", { maxHops: 500 });
    expect(r.activated.length).toBeGreaterThan(400);
    // 全库验证链完整
    for (const s of engine.storeSnapshot()) {
      expect(engine.verify(s.id).valid).toBe(true);
    }
  });
});
