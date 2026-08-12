import { describe, expect, it } from "bun:test";
import { SkillGainTracker, createFileGainStore } from "../../src/agent-evals/skill-gain.js";
import os from "node:os";
import path from "node:path";

function makeTracker(): SkillGainTracker {
  const file = path.join(os.tmpdir(), `skill-gain-test-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  return new SkillGainTracker({ store: createFileGainStore(file) });
}

describe("skill-gain (only inject skills with positive gain)", () => {
  it("allows unknown skills for trial", () => {
    const t = makeTracker();
    expect(t.shouldInject("auto-fix-coding-coding-02", "coding")).toBe(true);
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

  it("allows skills with non-negative gain", () => {
    const t = makeTracker();
    for (let i = 0; i < 10; i++) t.recordBaseline("knowledge", i < 5); // 50%
    for (let i = 0; i < 5; i++) t.recordInjection("auto-fix-knowledge-know-02", i < 4); // 80%
    expect(t.shouldInject("auto-fix-knowledge-know-02", "knowledge")).toBe(true);
  });

  it("persists across instances via file store", () => {
    const file = path.join(os.tmpdir(), `skill-gain-persist-${Date.now()}.json`);
    const a = new SkillGainTracker({ store: createFileGainStore(file) });
    a.recordBaseline("coding", true);
    a.recordInjection("auto-fix-coding-coding-02", true);
    const b = new SkillGainTracker({ store: createFileGainStore(file) });
    expect(b.gainOf("auto-fix-coding-coding-02", "coding")).not.toBeNull();
  });
});
