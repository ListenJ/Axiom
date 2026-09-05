/**
 * S5 回归自动检测闭环 — run-check.autoCheckRegression 分支面测试。
 * 定位：run.ts 是带顶层副作用的 CLI（不可 import 单测），可测判定逻辑剥离到
 * run-check.ts 纯函数；此处用 :memory: registry 覆盖 real-run / 显式 baseline /
 * 不可比基准 / 无候选 / runId null 三类跳过分支。规则 11：无网络、无密钥。
 */
import { describe, expect, it } from "bun:test";
import { autoCheckRegression, autoCheckEvolve } from "../../src/agent-evals/run-check.js";
import { openRegistry } from "../../src/agent-evals/registry.js";
import type { RunMetadata, RunSummarySnapshot } from "../../src/agent-evals/metrics-types.js";

function makeSummary(overrides: Partial<RunSummarySnapshot> = {}): RunSummarySnapshot {
  return {
    total: 4,
    passed: 4,
    passRate: 100,
    byFamily: { coding: { total: 4, passed: 4, passRate: 100 } },
    trainRate: 100,
    heldOutRate: 100,
    generalizationRatio: 1,
    avgLatencyMs: 42,
    avgOutputLength: 512,
    ...overrides,
  };
}

function makeMeta(overrides: Partial<RunMetadata> = {}): RunMetadata {
  return {
    runTag: "base",
    startedAt: "2026-09-01T00:00:00.000Z",
    model: "test-model",
    familyFilter: "coding",
    splitFilter: "held-out",
    ...overrides,
  };
}

/** 帮手：同一作用域插入两轮（基准 100% → 候选 50%） */
function seedRegression(reg: ReturnType<typeof openRegistry>, baselineTag = "base") {
  const baseId = reg.insertRun(makeMeta({ runTag: baselineTag }), makeSummary());
  const candId = reg.insertRun(
    makeMeta({ runTag: "candidate" }),
    makeSummary({ passed: 2, passRate: 50, byFamily: { coding: { total: 4, passed: 2, passRate: 50 } } }),
  );
  return { baseId, candId };
}

describe("run-check.autoCheckRegression（S5 回归自动检测）", () => {
  it("同作用域历史最优回落超阈值 → checked + regressed", () => {
    const reg = openRegistry(":memory:");
    try {
      const { candId } = seedRegression(reg);
      const outcome = autoCheckRegression(reg, { runId: candId });
      expect(outcome.checked).toBe(true);
      expect(outcome.regressed).toBe(true);
      expect(outcome.skipped).toBeNull();
      expect(outcome.check).not.toBeNull();
      expect(outcome.check!.dropPp).toBe(50);
      expect(outcome.check!.maxDropPp).toBe(10);
      expect(outcome.check!.baseline.runTag).toBe("base");
    } finally {
      reg.close();
    }
  });

  it("回落等于阈值不判回归（dropPp === maxDropPp 允许）", () => {
    const reg = openRegistry(":memory:");
    try {
      reg.insertRun(makeMeta(), makeSummary()); // 基准 100%
      // 用候选 90% vs 基准 100%，maxDropPp=10 → dropPp=10，不回归
      const candId = reg.insertRun(
        makeMeta({ runTag: "candidate" }),
        makeSummary({ passed: 3, passRate: 90, byFamily: { coding: { total: 4, passed: 3, passRate: 90 } } }),
      );
      const outcome = autoCheckRegression(reg, { runId: candId, maxDropPp: 10 });
      expect(outcome.checked).toBe(true);
      expect(outcome.regressed).toBe(false);
      expect(outcome.check!.dropPp).toBe(10);
    } finally {
      reg.close();
    }
  });

  it("显式 --baseline=<tag> 优先于自动基准", () => {
    const reg = openRegistry(":memory:");
    try {
      // 插入更高通过率的无关轮（不应被自动选中）
      reg.insertRun(makeMeta({ runTag: "hot" }), makeSummary());
      const { candId } = seedRegression(reg, "base");
      const outcome = autoCheckRegression(reg, { runId: candId, baseline: "base" });
      expect(outcome.regressed).toBe(true);
      expect(outcome.check!.baseline.runTag).toBe("base");
    } finally {
      reg.close();
    }
  });

  it("唯一一轮（无可比基准）→ checked=false，skipped=no-baseline", () => {
    const reg = openRegistry(":memory:");
    try {
      const candId = reg.insertRun(makeMeta({ runTag: "solo" }), makeSummary());
      const outcome = autoCheckRegression(reg, { runId: candId });
      expect(outcome.checked).toBe(false);
      expect(outcome.regressed).toBe(false);
      expect(outcome.check).toBeNull();
      expect(outcome.skipped).toBe("no-baseline");
    } finally {
      reg.close();
    }
  });

  it("候选 runId 不存在 → skipped=no-candidate（不抛）", () => {
    const reg = openRegistry(":memory:");
    try {
      const outcome = autoCheckRegression(reg, { runId: 999 });
      expect(outcome.checked).toBe(false);
      expect(outcome.skipped).toBe("no-candidate");
    } finally {
      reg.close();
    }
  });

  it("runId null（--no-persist）→ 纯无操作，不查库不抛", () => {
    const reg = openRegistry(":memory:");
    try {
      const outcome = autoCheckRegression(reg, { runId: null });
      expect(outcome).toEqual({ checked: false, regressed: false, check: null, skipped: null });
    } finally {
      reg.close();
    }
  });
});

describe("run-check.autoCheckEvolve（S5 evolve 回归检测）", () => {
  it("无显式 --baseline 时采用本轮回 baseline 阶段 runId（evolved vs baseline 判回归）", () => {
    const reg = openRegistry(":memory:");
    try {
      const { baseId, candId } = seedRegression(reg);
      const outcome = autoCheckEvolve(reg, { evolvedRunId: candId, baselineRunId: baseId });
      expect(outcome.checked).toBe(true);
      expect(outcome.regressed).toBe(true);
      expect(outcome.skipped).toBeNull();
      expect(outcome.check!.baseline.runTag).toBe("base");
      expect(outcome.check!.dropPp).toBe(50);
    } finally {
      reg.close();
    }
  });

  it("显式 baselineSpec 覆盖 baselineRunId（双形态：tag 与纯数字 id）", () => {
    const reg = openRegistry(":memory:");
    try {
      // 无关低通过率轮「spec-target」（80%），用 tag 指定它
      const specId = reg.insertRun(
        makeMeta({ runTag: "spec-target" }),
        makeSummary({ passed: 3, passRate: 80, byFamily: { coding: { total: 4, passed: 3, passRate: 80 } } }),
      );
      const { baseId, candId } = seedRegression(reg);
      void baseId;
      // tag 形态
      let outcome = autoCheckEvolve(reg, { evolvedRunId: candId, baselineRunId: specId, baselineSpec: "spec-target" });
      expect(outcome.check!.baseline.runTag).toBe("spec-target");
      expect(outcome.check!.dropPp).toBe(30);
      // 纯数字 id 形态
      outcome = autoCheckEvolve(reg, { evolvedRunId: candId, baselineRunId: specId, baselineSpec: String(specId) });
      expect(outcome.check!.baseline.runTag).toBe("spec-target");
    } finally {
      reg.close();
    }
  });

  it("evolvedRunId null（--no-persist）→ 纯无操作，不查库不抛", () => {
    const reg = openRegistry(":memory:");
    try {
      const outcome = autoCheckEvolve(reg, { evolvedRunId: null, baselineRunId: null });
      expect(outcome).toEqual({ checked: false, regressed: false, check: null, skipped: null });
    } finally {
      reg.close();
    }
  });

  it("baselineRunId null 且无 spec → 回落自动历史最优（同作用域最高通过率）", () => {
    const reg = openRegistry(":memory:");
    try {
      const { baseId, candId } = seedRegression(reg);
      void baseId;
      const outcome = autoCheckEvolve(reg, { evolvedRunId: candId, baselineRunId: null });
      expect(outcome.checked).toBe(true);
      expect(outcome.regressed).toBe(true);
      expect(outcome.check!.baseline.runTag).toBe("base");
    } finally {
      reg.close();
    }
  });
});