/**
 * 神经突触心智模块测试 — 确定性 + 可校验路径 + 追溯
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { join } from "path";
import { tmpdir } from "os";
import { rmSync, existsSync } from "fs";
import { SynapseStore, SynapseEngine, createSynapseEngine, makeSynapse, type SynapseSuggestion } from "../src/dre/synapse/index.js";

describe("SynapseStore — 可校验路径", () => {
  test("创建突触：id 确定性 + verify 通过", () => {
    const store = new SynapseStore(":memory:");
    const s = makeSynapse("scene:code-bug", "skill:debug", "scene", "skill", 0.8);
    store.upsert(s);
    expect(store.get(s.id)?.id).toBe(s.id);
    expect(store.verify(s.id).valid).toBe(true);
    store.close();
  });

  test("同源目标 id 确定性一致", () => {
    const a = makeSynapse("x", "y", "concept", "skill", 0.5);
    const b = makeSynapse("x", "y", "concept", "skill", 0.9);
    expect(a.id).toBe(b.id);
  });

  test("篡改 weight 后 verify 失败（可校验路径）", () => {
    const store = new SynapseStore(":memory:");
    const s = makeSynapse("scene:a", "skill:b", "scene", "skill", 0.5);
    store.upsert(s);
    // 直接改库（绕过 store.updateActivation，模拟篡改）
    store.upsert({ ...s, weight: 0.99 });
    const v = store.verify(s.id);
    expect(v.valid).toBe(false);
    expect(v.reason).toContain("mismatch");
    store.close();
  });
});

describe("SynapseEngine — 激活/扩散/建议/追溯", () => {
  let engine: SynapseEngine;

  beforeEach(() => {
    engine = createSynapseEngine(":memory:", { decayPerActivation: 0.01, spreadDecay: 0.5 });
  });

  afterEach(() => {
    // engine 持有 store，close 释放
    (engine as unknown as { storeSnapshot(): unknown }).storeSnapshot();
  });

  test("activate：出边增强 + 全局轻微衰减 + 验证链追加", () => {
    const a = engine.createSynapse("scene:planning", "skill:task-split", { sourceType: "scene", targetType: "skill", weight: 0.5 });
    const b = engine.createSynapse("scene:planning", "skill:roadmap", { sourceType: "scene", targetType: "skill", weight: 0.3 });
    const c = engine.createSynapse("scene:unrelated", "skill:other", { sourceType: "scene", targetType: "skill", weight: 0.9 });

    const enhanced = engine.activate("scene:planning", "user selected planning scene");
    expect(enhanced.length).toBe(2);
    const aAfter = engine.storeSnapshot().find((s) => s.id === a.id)!;
    expect(aAfter.weight).toBeGreaterThan(a.weight);
    expect(aAfter.activationCount).toBe(1);
    // 非激活路径轻微衰减
    const cAfter = engine.storeSnapshot().find((s) => s.id === c.id)!;
    expect(cAfter.weight).toBeLessThan(c.weight);
    // 验证链完整：create → activate → (decay 汇总)
    const ops = engine.trace(a.id).map((x) => x.operation);
    expect(ops).toEqual(["create", "activate", "decay"]);
    expect(engine.verify(a.id).valid).toBe(true);
  });

  test("spreadActivation：沿突触扩散，跳数越远激活越弱", () => {
    engine.createSynapse("seed", "hop1", { sourceType: "concept", targetType: "skill", weight: 0.5 });
    engine.createSynapse("hop1", "hop2", { sourceType: "concept", targetType: "skill", weight: 0.5 });
    engine.createSynapse("hop2", "hop3", { sourceType: "concept", targetType: "skill", weight: 0.5 });

    const r = engine.spreadActivation(["seed"], "debug flow", { maxHops: 3 });
    expect(r.activated.length).toBe(3);
    const byTarget = new Map(r.activated.map((a) => [a.targetId, a]));
    expect(byTarget.get("hop1")!.hops).toBe(1);
    expect(byTarget.get("hop2")!.hops).toBe(2);
    expect(byTarget.get("hop3")!.hops).toBe(3);
    expect(byTarget.get("hop1")!.activation).toBeGreaterThan(byTarget.get("hop2")!.activation);
    expect(byTarget.get("hop2")!.activation).toBeGreaterThan(byTarget.get("hop3")!.activation);
  });

  test("suggestNextSteps：场景/目标命中 → 确定性排序 + 可追溯 via", async () => {
    engine.createSynapse("scene:code", "skill:write-tests", { sourceType: "scene", targetType: "skill", weight: 0.6 });
    engine.createSynapse("scene:code", "skill:refactor", { sourceType: "scene", targetType: "skill", weight: 0.9 });
    engine.createSynapse("goal:ship", "skill:release", { sourceType: "goal", targetType: "skill", weight: 0.7 });

    const sugs = await engine.suggestNextSteps("writing code for a bug fix", "ship the fix", { limit: 5 });
    expect(sugs.length).toBeGreaterThanOrEqual(2);
    expect(sugs[0].via.length).toBe(2);
    expect(sugs[0].reason).toContain("via");
    // 高分项在前（refactor 0.9 > write-tests 0.6，且都有 scene:code 命中）
    expect(sugs[0].targetId).toBe("skill:refactor");
  });

  test("local model assist：注入增强器生效（确定性回退不启用时无网络）", async () => {
    const assist = async (suggestions: SynapseSuggestion[], scene: string, goal: string) =>
      suggestions.filter((s) => s.targetId !== "skill:refactor").map((s) => ({ ...s, score: 1 }));
    const eng = createSynapseEngine(":memory:", { localModelAssist: assist });
    eng.createSynapse("scene:code", "skill:write-tests", { sourceType: "scene", targetType: "skill", weight: 0.6 });
    eng.createSynapse("scene:code", "skill:refactor", { sourceType: "scene", targetType: "skill", weight: 0.9 });
    const sugs = await eng.suggestNextSteps("writing code", "improve", { limit: 5 });
    expect(sugs.some((s) => s.targetId === "skill:refactor")).toBe(false);
    expect(sugs.some((s) => s.targetId === "skill:write-tests")).toBe(true);
  });
});

describe("SynapseStore — 持久化", () => {
  test("文件库重开数据仍在（WAL 持久化）", () => {
    const dbPath = join(tmpdir(), `synapse-test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.db`);
    try {
      const s1 = new SynapseStore(dbPath);
      const s = makeSynapse("scene:x", "skill:y", "scene", "skill", 0.7);
      s1.upsert(s);
      s1.close();

      const s2 = new SynapseStore(dbPath);
      expect(s2.get(s.id)?.weight).toBe(0.7);
      expect(s2.verify(s.id).valid).toBe(true);
      s2.close();
    } finally {
      if (existsSync(dbPath)) rmSync(dbPath, { force: true });
      if (existsSync(dbPath + "-wal")) rmSync(dbPath + "-wal", { force: true });
      if (existsSync(dbPath + "-shm")) rmSync(dbPath + "-shm", { force: true });
    }
  });
});
