/**
 * SkillQualityTracker — 技能质量反馈回路（方向乙）。
 *
 * Contract:
 *   - recordSkillOutcome(skillId, success): 累计调用次数/成功次数/最近使用时间；
 *   - getSkillQuality(skillId): 返回质量记录（含 derived deprecated 标记）；
 *   - listSkillQuality(): 全部记录只读快照。
 */
import { describe, test, expect } from "bun:test";
import path from "path";
import fs from "fs";
import os from "os";
import { SkillQualityTracker, createFileQualityStore } from "../../src/self-evolve/skill-quality.js";

describe("SkillQualityTracker", () => {
  test("records outcomes and exposes quality stats per skill", () => {
    const tracker = new SkillQualityTracker();

    tracker.recordSkillOutcome("auto-induce-mcp-timeout", true);
    tracker.recordSkillOutcome("auto-induce-mcp-timeout", false);
    tracker.recordSkillOutcome("auto-induce-redis-cache", true);

    const mcp = tracker.getSkillQuality("auto-induce-mcp-timeout");
    expect(mcp).toBeDefined();
    expect(mcp!.skillId).toBe("auto-induce-mcp-timeout");
    expect(mcp!.calls).toBe(2);
    expect(mcp!.successes).toBe(1);
    expect(mcp!.lastUsedAt).toBeGreaterThan(0);

    const redis = tracker.getSkillQuality("auto-induce-redis-cache");
    expect(redis!.calls).toBe(1);
    expect(redis!.successes).toBe(1);
  });

  test("getSkillQuality returns undefined for unknown skill", () => {
    const tracker = new SkillQualityTracker();
    expect(tracker.getSkillQuality("auto-induce-unknown")).toBeUndefined();
  });

  test("listSkillQuality returns a snapshot of all records", () => {
    const tracker = new SkillQualityTracker();
    tracker.recordSkillOutcome("a", true);
    tracker.recordSkillOutcome("b", false);

    const all = tracker.listSkillQuality();
    expect(all.map((r) => r.skillId).sort()).toEqual(["a", "b"]);
    all[0]!.calls = 999;
    expect(tracker.getSkillQuality("a")!.calls).toBe(1);
  });
});

describe("deprecated gating", () => {
  test("marks skill deprecated when calls >= 3 and successRate < 0.5", () => {
    const tracker = new SkillQualityTracker();
    tracker.recordSkillOutcome("auto-induce-flaky", false);
    tracker.recordSkillOutcome("auto-induce-flaky", false);
    tracker.recordSkillOutcome("auto-induce-flaky", true);

    const quality = tracker.getSkillQuality("auto-induce-flaky");
    expect(quality!.calls).toBe(3);
    expect(quality!.successes).toBe(1);
    expect(quality!.deprecated).toBe(true);
    expect(tracker.deprecatedSkillIds()).toEqual(["auto-induce-flaky"]);
  });

  test("does not deprecate before 3 cumulative calls", () => {
    const tracker = new SkillQualityTracker();
    tracker.recordSkillOutcome("auto-induce-new", false);
    tracker.recordSkillOutcome("auto-induce-new", false);

    expect(tracker.getSkillQuality("auto-induce-new")!.deprecated).toBe(false);
    expect(tracker.deprecatedSkillIds()).toEqual([]);
  });

  test("does not deprecate when successRate is exactly 0.5", () => {
    const tracker = new SkillQualityTracker();
    for (let i = 0; i < 4; i++) {
      tracker.recordSkillOutcome("auto-induce-even", i % 2 === 0);
    }

    expect(tracker.getSkillQuality("auto-induce-even")!.successes).toBe(2);
    expect(tracker.getSkillQuality("auto-induce-even")!.deprecated).toBe(false);
    expect(tracker.deprecatedSkillIds()).toEqual([]);
  });

  test("deprecatedSkillIds only includes deprecated skills", () => {
    const tracker = new SkillQualityTracker();
    tracker.recordSkillOutcome("bad", true);
    tracker.recordSkillOutcome("bad", false);
    tracker.recordSkillOutcome("bad", false);
    tracker.recordSkillOutcome("good", true);
    tracker.recordSkillOutcome("good", true);
    tracker.recordSkillOutcome("good", true);

    expect(tracker.deprecatedSkillIds().sort()).toEqual(["bad"]);
  });
});

describe("persistence", () => {
  test("loads persisted records from store on construction", () => {
    const fake = fakeStore({ "auto-induce-mcp-timeout": { calls: 4, successes: 1, lastUsedAt: 123 } });
    const tracker = new SkillQualityTracker({ store: fake.store });

    const quality = tracker.getSkillQuality("auto-induce-mcp-timeout");
    expect(quality!.calls).toBe(4);
    expect(quality!.successes).toBe(1);
    expect(quality!.deprecated).toBe(true);
  });

  test("saves records to store after each outcome", () => {
    const fake = fakeStore();
    const tracker = new SkillQualityTracker({ store: fake.store });

    tracker.recordSkillOutcome("auto-induce-redis-cache", true);
    tracker.recordSkillOutcome("auto-induce-redis-cache", false);

    expect(fake.saved).toHaveLength(2);
    expect(fake.saved[1]["auto-induce-redis-cache"].calls).toBe(2);
    expect(fake.saved[1]["auto-induce-redis-cache"].successes).toBe(1);
  });

  test("store load returning null starts empty without crashing", () => {
    const tracker = new SkillQualityTracker({ store: { load: () => null, save: () => {} } });
    expect(tracker.listSkillQuality()).toEqual([]);
    tracker.recordSkillOutcome("a", true);
    expect(tracker.getSkillQuality("a")!.calls).toBe(1);
  });

  test("save failure does not block outcome recording", () => {
    const tracker = new SkillQualityTracker({
      store: { load: () => null, save: () => { throw new Error("disk full"); } },
    });

    expect(() => tracker.recordSkillOutcome("a", true)).not.toThrow();
    expect(tracker.getSkillQuality("a")!.calls).toBe(1);
  });

  test("file store roundtrips records through data file", () => {
    const filePath = path.join(os.tmpdir(), `skill-quality-test-${Date.now()}.json`);
    try {
      const store = createFileQualityStore(filePath);
      store.save({ "auto-induce-mcp-timeout": { calls: 3, successes: 1, lastUsedAt: 42 } });

      const loaded = createFileQualityStore(filePath).load();
      expect(loaded).toEqual({ "auto-induce-mcp-timeout": { calls: 3, successes: 1, lastUsedAt: 42 } });
    } finally {
      fs.rmSync(filePath, { force: true });
    }
  });

  test("file store returns null for missing or corrupt files", () => {
    const missing = path.join(os.tmpdir(), `skill-quality-missing-${Date.now()}.json`);
    expect(createFileQualityStore(missing).load()).toBeNull();

    const corrupt = path.join(os.tmpdir(), `skill-quality-corrupt-${Date.now()}.json`);
    fs.writeFileSync(corrupt, "{ not json", "utf-8");
    try {
      expect(createFileQualityStore(corrupt).load()).toBeNull();
    } finally {
      fs.rmSync(corrupt, { force: true });
    }
  });
});

function fakeStore(initial: Record<string, { calls: number; successes: number; lastUsedAt: number }> = {}) {
  let data: Record<string, { calls: number; successes: number; lastUsedAt: number }> = { ...initial };
  const saved: Array<Record<string, { calls: number; successes: number; lastUsedAt: number }>> = [];
  return {
    store: {
      load: () => ({ ...data }),
      save: (records: Record<string, { calls: number; successes: number; lastUsedAt: number }>) => {
        data = { ...records };
        saved.push(records);
      },
    },
    saved,
  };
}


