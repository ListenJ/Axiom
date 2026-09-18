import { describe, expect, it } from "bun:test";
import { SkillGainTracker, createFileGainStore } from "../../src/agent-evals/skill-gain.js";
import type { TaskResult } from "../../src/agent-evals/metrics.js";
import type { TaskFamily } from "../../src/agent-evals/tasks.js";
import os from "node:os";
import path from "node:path";

function makeTracker(): SkillGainTracker {
  const file = path.join(os.tmpdir(), `skill-gain-test-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  return new SkillGainTracker({ store: createFileGainStore(file) });
}

function mkResult(
  family: string,
  passed: boolean,
  opts: { executionError?: boolean; injectedSkills?: string[] } = {},
): TaskResult {
  return {
    taskId: `${family}-${Math.random().toString(36).slice(2)}`,
    family: family as TaskFamily,
    split: "held-out",
    passed,
    latencyMs: 1,
    outputLength: 1,
    executionError: opts.executionError,
    injectedSkills: opts.injectedSkills,
  };
}

describe("skill-gain (only inject skills with positive gain)", () => {
  it("allows unknown auto-fix skills for trial, blocks unknown auto-induce", () => {
    const t = makeTracker();
    expect(t.shouldInject("auto-fix-coding-coding-02", "coding")).toBe(true);
    expect(t.shouldInject("auto-induce-js", "coding")).toBe(false);
    expect(t.gainOf("auto-fix-coding-coding-02", "coding")).toBeNull();
  });

  it("blocks skills with negative gain vs family baseline", () => {
    const t = makeTracker();
    // baseline: coding 10 次 8 过 = 80%
    for (let i = 0; i < 10; i++) t.recordBaseline("coding", i < 8);
    // injection: skill 5 次 1 过 = 20% < 80% → negative gain
    for (let i = 0; i < 5; i++) t.recordInjection("auto-fix-coding-coding-02", i === 0);
    const gain = t.gainOf("auto-fix-coding-coding-02", "coding");
    expect(gain).not.toBeNull();
    expect(gain!).toBeLessThan(-10);
    expect(t.shouldInject("auto-fix-coding-coding-02", "coding")).toBe(false);
  });

  it("allows skills with strict positive gain, blocks neutral gain", () => {
    const t = makeTracker();
    for (let i = 0; i < 10; i++) t.recordBaseline("knowledge", i < 5); // 50%
    for (let i = 0; i < 5; i++) t.recordInjection("auto-fix-knowledge-know-02", i < 4); // 80% > 50%
    expect(t.shouldInject("auto-fix-knowledge-know-02", "knowledge")).toBe(true);
    // neutral: 80% vs 80% → not strictly positive
    const t2 = makeTracker();
    for (let i = 0; i < 10; i++) t2.recordBaseline("coding", i < 8); // 80%
    for (let i = 0; i < 5; i++) t2.recordInjection("auto-fix-coding-coding-02", i < 4); // 80%
    expect(t2.shouldInject("auto-fix-coding-coding-02", "coding")).toBe(false);
  });

  it("requires auto-induce very strong gain >=10pp and >=20 samples", () => {
    const t = makeTracker();
    for (let i = 0; i < 52; i++) t.recordBaseline("coding", i < 26); // 50%
    for (let i = 0; i < 52; i++) t.recordInjection("auto-induce-js", i < 32); // 61.5% -> +11.5pp
    expect(t.shouldInject("auto-induce-js", "coding")).toBe(true);
    const t2 = makeTracker();
    for (let i = 0; i < 52; i++) t2.recordBaseline("knowledge", i < 26); // 50%
    for (let i = 0; i < 52; i++) t2.recordInjection("auto-induce-api", i < 27); // 51.9% -> +1.9pp
    expect(t2.shouldInject("auto-induce-api", "knowledge")).toBe(false);
  });

  it("sanitizes corrupted persisted data", () => {
    const file = path.join(os.tmpdir(), `skill-gain-corrupt-${Date.now()}.json`);
    require("node:fs").writeFileSync(file, JSON.stringify({
      baseline: { coding: { count: "5", pass: 3 } },
      injection: { "auto-induce-js": { count: 2, pass: 9 } },
    }), "utf8");
    const t = new SkillGainTracker({ store: createFileGainStore(file) });
    expect(t.gainOf("auto-induce-js", "coding")).toBeNull();
    t.recordBaseline("coding", true);
    expect(t.gainOf("auto-induce-js", "coding")).toBeNull();
  });

  it("persists across instances via file store", () => {
    const file = path.join(os.tmpdir(), `skill-gain-persist-${Date.now()}.json`);
    const a = new SkillGainTracker({ store: createFileGainStore(file) });
    a.recordBaseline("coding", true);
    a.recordInjection("auto-fix-coding-coding-02", true);
    const b = new SkillGainTracker({ store: createFileGainStore(file) });
    expect(b.gainOf("auto-fix-coding-coding-02", "coding")).not.toBeNull();
  });

  it("returns null gain when no family baseline exists (not degenerate self-rate 0)", () => {
    const t = makeTracker();
    // 5/5 注入、该族从未记录基线：自引用回退 baselineRate=injectedRate 会把增益压成 0；
    // 契约「无基线返回 null」（增益未知），非伪造的 0。
    for (let i = 0; i < 5; i++) t.recordInjection("auto-fix-coding-coding-02", true);
    expect(t.gainOf("auto-fix-coding-coding-02", "coding")).toBeNull();
  });

  it("allows passing auto-fix skill with >=3 samples when no baseline exists (allow trial)", () => {
    const t = makeTracker();
    // 契约「无记录 → 允许试用」：5/5 通过、无基线 → 注入不被退化逻辑拒绝
    for (let i = 0; i < 5; i++) t.recordInjection("auto-fix-coding-coding-02", true);
    expect(t.shouldInject("auto-fix-coding-coding-02", "coding")).toBe(true);
  });

  it("blocks auto-fix skill with all-fail samples when no baseline exists", () => {
    const t = makeTracker();
    // 0/5 全败 → 无基线也允许试用不等于注入全败技能
    for (let i = 0; i < 5; i++) t.recordInjection("auto-fix-coding-coding-02", false);
    expect(t.shouldInject("auto-fix-coding-coding-02", "coding")).toBe(false);
  });

  it("keeps auto-induce conservative when no baseline exists (cannot prove >=10pp gain)", () => {
    const t = makeTracker();
    // auto-induce 严格口径：无基线无法证明极强正增益 → 不注入（宁缺毋滥）
    for (let i = 0; i < 30; i++) t.recordInjection("auto-induce-js", i < 20);
    expect(t.shouldInject("auto-induce-js", "coding")).toBe(false);
  });

  it("recordFromResults excludes execution errors from baseline/injection samples (capability-denominated)", () => {
    const t = makeTracker();
    const base: TaskResult[] = [
      mkResult("coding", true),
      mkResult("coding", false),
      mkResult("coding", false, { executionError: true }), // 执行错误不计入基线样本
    ];
    const evolved: TaskResult[] = [
      mkResult("coding", true, { injectedSkills: ["auto-fix-coding-coding-02"] }),
      mkResult("coding", true, { executionError: true, injectedSkills: ["auto-fix-coding-coding-02"] }), // 不计入注入样本
    ];
    t.recordFromResults(base, evolved);
    // 基线 2 样本 1 过（50%）；注入 1 样本 1 过（100%）→ 严格正增益 → 注入
    expect(t.gainOf("auto-fix-coding-coding-02", "coding")).toBe(50);
    expect(t.shouldInject("auto-fix-coding-coding-02", "coding")).toBe(true);
    expect(t.listGain("coding")[0]!.samples).toBe(1); // 执行错误的注入样本未被计数
  });
});
