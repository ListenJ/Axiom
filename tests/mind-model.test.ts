/**
 * 心智模型综合测试集 — 边界、语义、可追溯性与性能
 *
 * 覆盖：tokenize（中英文）、创建幂等/权重钳制、激活（无操作/衰减下限/decay=false）、
 * 扩散（跳数边界/空种子）、建议（中文命中/贡献突触追溯/limit/空态）、store 校验链。
 */
import { describe, it, expect } from "bun:test";
import { createSynapseEngine, tokenize } from "../src/dre/synapse/index.js";
import { SynapseStore } from "../src/dre/synapse/index.js";

describe("tokenize — 中文 bigram + 英文", () => {
  it("英文按词切分、去重、小写", () => {
    expect(tokenize("SQLite Database lock")).toEqual(["sqlite", "database", "lock"]);
    expect(tokenize("a a b")).toEqual(["a", "b"]);
  });
  it("中文整段做 bigram（可被突触 sourceId 命中）", () => {
    expect(tokenize("数据库锁")).toEqual(["数据", "据库", "库锁"]);
    expect(tokenize("没有视觉模型")).toEqual(["没有", "有视", "视觉", "觉模", "模型"]);
  });
  it("中英混合", () => {
    const toks = tokenize("sqlite 数据库锁问题");
    expect(toks).toContain("sqlite");
    expect(toks).toContain("数据");
    expect(toks).toContain("据库");
    expect(toks).toContain("库锁");
  });
  it("空/边界输入", () => {
    expect(tokenize("")).toEqual([]);
    expect(tokenize(null as unknown as string)).toEqual([]);
  });
});

describe("createSynapse — 幂等与权重钳制", () => {
  it("同源目标幂等返回既有突触", () => {
    const engine = createSynapseEngine(":memory:");
    const s1 = engine.createSynapse("a", "b", { weight: 0.5 });
    const s2 = engine.createSynapse("a", "b", { weight: 0.9 });
    expect(s2.id).toBe(s1.id);
    expect(s2.weight).toBe(0.5); // 幂等不改写
    expect(engine.storeSnapshot().length).toBe(1);
  });
  it("权重钳制到 [0,1]", () => {
    const engine = createSynapseEngine(":memory:");
    const low = engine.createSynapse("a", "c", { weight: -3 });
    const high = engine.createSynapse("a", "d", { weight: 7 });
    expect(low.weight).toBe(0);
    expect(high.weight).toBe(1);
  });
});

describe("activate — 边界与语义", () => {
  it("未知源节点：无增强、无衰减、不抛错", () => {
    const engine = createSynapseEngine(":memory:");
    engine.createSynapse("known", "skill:x", { weight: 0.9 });
    const enhanced = engine.activate("unknown", "noop");
    expect(enhanced).toEqual([]);
    // known 未被衰减（无激活 → 无全局衰减）
    expect(engine.storeSnapshot()[0].weight).toBe(0.9);
  });

  it("衰减下限 minWeight：权重不会低于下限", () => {
    const engine = createSynapseEngine(":memory:", { minWeight: 0.1, decayPerActivation: 0.2 });
    engine.createSynapse("s1", "t1", { weight: 0.5 });
    engine.createSynapse("s2", "t2", { weight: 0.15 });
    engine.activate("s1", "decay-floor");
    const t2 = engine.storeSnapshot().find((s) => s.targetId === "t2")!;
    expect(t2.weight).toBe(0.1); // 0.15 - 0.2 → 下限 0.1
  });

  it("decay:false 跳过全局衰减（学习性激活不遗忘他人）", () => {
    const engine = createSynapseEngine(":memory:");
    engine.createSynapse("s1", "t1", { weight: 0.5 });
    engine.createSynapse("s2", "t2", { weight: 0.9 });
    engine.activate("s1", "learn", { delta: 0.2, decay: false });
    const t2 = engine.storeSnapshot().find((s) => s.targetId === "t2")!;
    expect(t2.weight).toBe(0.9); // 未衰减
  });
});

describe("spreadActivation — 边界", () => {
  it("maxHops=1 只激活直接邻居", () => {
    const engine = createSynapseEngine(":memory:");
    engine.createSynapse("seed", "hop1", { sourceType: "concept", targetType: "skill", weight: 0.5 });
    engine.createSynapse("hop1", "hop2", { sourceType: "concept", targetType: "skill", weight: 0.5 });
    const r = engine.spreadActivation(["seed"], "e", { maxHops: 1 });
    expect(r.activated.length).toBe(1);
    expect(r.activated[0].targetId).toBe("hop1");
    expect(r.activated[0].hops).toBe(1);
  });
  it("空种子：不崩溃、零激活", () => {
    const engine = createSynapseEngine(":memory:");
    engine.createSynapse("seed", "hop1", { sourceType: "concept", targetType: "skill", weight: 0.5 });
    const r = engine.spreadActivation([], "e");
    expect(r.activated).toEqual([]);
    expect(r.totalActivation).toBe(0);
  });
});

describe("suggestNextSteps — 中文命中与追溯准确性", () => {
  it("中文场景可命中（bigram 对齐修复）", async () => {
    const engine = createSynapseEngine(":memory:");
    engine.createSynapse("scene:数据", "skill:数据清洗", { sourceType: "scene", targetType: "skill", weight: 0.7 });
    const sugs = await engine.suggestNextSteps("处理数据库的脏数据", "清洗数据", { limit: 5 });
    expect(sugs.some((s) => s.targetId === "skill:数据清洗")).toBe(true);
  });

  it("suggest trace 记在贡献该建议的突触上（而非任意同目标突触）", async () => {
    const engine = createSynapseEngine(":memory:");
    const contributor = engine.createSynapse("scene:code", "skill:write-tests", { sourceType: "scene", targetType: "skill", weight: 0.9 });
    // 同目标但低权重、非命中的突触
    engine.createSynapse("other", "skill:write-tests", { sourceType: "scene", targetType: "skill", weight: 0.1 });
    await engine.suggestNextSteps("writing code", "improve", { limit: 5 });
    const contributorOps = engine.trace(contributor.id).map((x) => x.operation);
    expect(contributorOps).toContain("suggest");
  });

  it("limit 生效且空态不抛错", async () => {
    const engine = createSynapseEngine(":memory:");
    for (let i = 0; i < 10; i++) {
      engine.createSynapse(`scene:${i}`, `skill:s${i}`, { sourceType: "scene", targetType: "skill", weight: 0.5 });
    }
    const all = await engine.suggestNextSteps("x y z", "goal", { limit: 3 });
    expect(all.length).toBeLessThanOrEqual(3);
    // 空态：无任何突触 → 返回空数组（不抛错）
    const emptyEngine = createSynapseEngine(":memory:");
    const empty = await emptyEngine.suggestNextSteps("完全无关", "也无关");
    expect(empty).toEqual([]);
  });
});

describe("store.nextSeq 与验证链", () => {
  it("nextSeq 连续递增（不依赖全量加载）", () => {
    const store = new SynapseStore(":memory:");
    store.upsert({ id: "x", sourceId: "a", targetId: "b", sourceType: "scene", targetType: "skill", weight: 0.5, activationCount: 0, lastActivatedAt: 0, createdAt: 1, verifyHash: "h" });
    expect(store.nextSeq("x")).toBe(1);
    store.appendTrace({ id: "t1", synapseId: "x", seq: 1, operation: "create", activation: 0.5, sourceEvent: "e", timestamp: 1, prevHash: "g", hash: "h1" });
    expect(store.nextSeq("x")).toBe(2);
    store.close();
  });
});
