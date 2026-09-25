/**
 * 压实触发决策（切法 A3b 后半：精细化触发）
 *
 * 分层（与 A3a/A3d 同一思路：把纯决策与副作用分开）：
 *   decideCompaction(signals)  纯函数 → 该不该压、为什么
 *   maybeCompactRealUsageTraces(...)  → 廉价探测 → 决策 → 排队重写
 *
 * 为什么要"廉价探测"：全量压实要读+解析+重写整个文件。若每次写入都做，
 * 代价与文件大小同阶。故先用**两次系统调用**（statSync 体积 / statfsSync 可用空间）
 * 判断"值不值得扫"，不值得就直接返回。
 *
 * 为什么要有冷却：持续高压下若每批都压实，会把 CPU/IO 打满而收益递减。
 */
import { describe, it, expect } from "bun:test";
import {
  decideCompaction,
  COMPACTION_TRIGGER_DEFAULTS,
  type CompactionTriggerSignals,
} from "../../src/agent-evals/trace-retention.js";

const GIB = 1024 ** 3;
const MIB = 1024 ** 2;

function sig(over: Partial<CompactionTriggerSignals> = {}): CompactionTriggerSignals {
  return {
    fileBytes: 0,
    freeDiskBytes: 50 * GIB,
    now: 1_800_000_000_000,
    lastCompactionAt: null,
    ...over,
  };
}

describe("压实触发决策", () => {
  it("远小于阈值 → 不压（below-threshold），且给出有效上限与阈值", () => {
    const d = decideCompaction(sig({ fileBytes: 1024 }));
    expect(d.compact).toBe(false);
    expect(d.reason).toBe("below-threshold");
    expect(d.effectiveMaxBytes).toBeGreaterThan(0);
    expect(d.thresholdBytes).toBe(Math.floor(d.effectiveMaxBytes * COMPACTION_TRIGGER_DEFAULTS.triggerRatio));
  });

  it("达到阈值 → 触发（trigger）", () => {
    // 先取一次上限，再按上限比例构造体积
    const probe = decideCompaction(sig());
    const d = decideCompaction(sig({ fileBytes: probe.thresholdBytes }));
    expect(d.compact).toBe(true);
    expect(d.reason).toBe("trigger");
  });

  it("冷却期内不压（cooldown），优先于阈值判断", () => {
    const base = sig();
    const probe = decideCompaction(base);
    const d = decideCompaction(sig({
      fileBytes: probe.thresholdBytes,
      lastCompactionAt: base.now - 1000, // 刚压过
    }));
    expect(d.compact).toBe(false);
    expect(d.reason).toBe("cooldown");
  });

  it("冷却过后可再次触发", () => {
    const base = sig();
    const probe = decideCompaction(base);
    const d = decideCompaction(sig({
      fileBytes: probe.thresholdBytes,
      lastCompactionAt: base.now - COMPACTION_TRIGGER_DEFAULTS.cooldownMs - 1,
    }));
    expect(d.compact).toBe(true);
  });

  it("磁盘越紧 → 阈值越低（更早触发），与 resolvePolicy 一致", () => {
    const loose = decideCompaction(sig({ freeDiskBytes: 50 * GIB }));
    const tight = decideCompaction(sig({ freeDiskBytes: 3 * GIB }));
    expect(tight.effectiveMaxBytes).toBeLessThanOrEqual(loose.effectiveMaxBytes);
    expect(tight.thresholdBytes).toBeLessThanOrEqual(loose.thresholdBytes);
  });

  it("确定性：同 signals 多次决策完全一致", () => {
    const s = sig({ fileBytes: 1024 * 1024 });
    const runs = Array.from({ length: 5 }, () => decideCompaction(s));
    for (const r of runs) expect(r).toEqual(runs[0]);
  });

  it("边界：0 体积 / 0 磁盘 / lastCompactionAt=0 不产出非法值", () => {
    const d = decideCompaction(sig({ fileBytes: 0, freeDiskBytes: 0, lastCompactionAt: 0 }));
    expect(d.effectiveMaxBytes).toBeGreaterThan(0);
    expect(Number.isInteger(d.thresholdBytes)).toBe(true);
    expect(typeof d.compact).toBe("boolean");
  });

  it("可覆盖阈值比例与冷却时长（精细化调节）", () => {
    const s = sig({ fileBytes: 5 * MIB });
    const strict = decideCompaction(s, { triggerRatio: 0.9 });
    const eager = decideCompaction(s, { triggerRatio: 0.001 });
    expect(eager.compact).toBe(true);
    expect(strict.thresholdBytes).toBeGreaterThan(eager.thresholdBytes);
  });
});
