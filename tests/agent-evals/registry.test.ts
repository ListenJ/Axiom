import { describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openRegistry } from "../../src/agent-evals/registry.js";
import type { RunMetadata, RunSummarySnapshot, StoredTaskResult } from "../../src/agent-evals/metrics-types.js";

function makeSummary(overrides: Partial<RunSummarySnapshot> = {}): RunSummarySnapshot {
  return {
    total: 2,
    passed: 2,
    passRate: 100,
    byFamily: { coding: { total: 2, passed: 2, passRate: 100 } },
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
    runTag: "test-run-1",
    startedAt: "2026-09-01T00:00:00.000Z",
    model: "test-model",
    familyFilter: "coding",
    splitFilter: "held-out",
    rerunEach: 2,
    gitCommit: "abc123",
    ...overrides,
  };
}

function makeTask(overrides: Partial<StoredTaskResult> = {}): StoredTaskResult {
  return {
    taskId: "CODING-01",
    family: "coding",
    split: "held-out",
    passed: true,
    latencyMs: 100,
    outputLength: 64,
    model: "test-model",
    ...overrides,
  };
}

function tmpDbFile(label: string): string {
  return path.join(os.tmpdir(), `eval-registry-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

describe("eval registry (回归基准入库)", () => {
  it("roundtrip: insertRun + insertTaskResults → getRun/listRuns 读回同量数据, run_id 关联正确", () => {
    const reg = openRegistry(":memory:");
    try {
      const runId = reg.insertRun(makeMeta(), makeSummary());
      reg.insertTaskResults(runId, [makeTask({ taskId: "CODING-01" }), makeTask({ taskId: "CODING-02", passed: false })]);

      const run = reg.getRun(runId);
      expect(run).not.toBeNull();
      expect(run!.runTag).toBe("test-run-1");
      expect(run!.summaryTotal).toBe(2);
      expect(run!.summaryPassed).toBe(2);
      expect(run!.gitCommit).toBe("abc123");

      const tasks = reg.getTasks(runId);
      expect(tasks.length).toBe(2);
      expect(tasks.every((t) => t.runId === runId)).toBe(true);
      expect(tasks.find((t) => t.taskId === "CODING-01")!.passed).toBe(true);
      expect(tasks.find((t) => t.taskId === "CODING-02")!.passed).toBe(false);

      const runs = reg.listRuns();
      expect(runs.length).toBe(1);
      expect(runs[0].id).toBe(runId);
    } finally {
      reg.close();
    }
  });

  it("roundtrip: executionError / summaryExecutionErrors 落库并读回 (执行错误非能力失败)", () => {
    const reg = openRegistry(":memory:");
    try {
      const runId = reg.insertRun(
        makeMeta(),
        makeSummary({ passed: 1, passRate: 50, executionErrors: 1 }),
      );
      reg.insertTaskResults(runId, [
        makeTask({ taskId: "CODING-01", passed: true, executionError: false }),
        makeTask({ taskId: "CODING-02", passed: false, executionError: true }),
      ]);

      const run = reg.getRun(runId);
      expect(run).not.toBeNull();
      expect(run!.summaryExecutionErrors).toBe(1);

      const tasks = reg.getTasks(runId);
      expect(tasks.length).toBe(2);
      expect(tasks.find((t) => t.taskId === "CODING-01")!.executionError).toBe(false);
      expect(tasks.find((t) => t.taskId === "CODING-02")!.executionError).toBe(true);
    } finally {
      reg.close();
    }
  });

  it("getRun 支持按 tag 解析, 空库 listRuns 返回 []", () => {
    const reg = openRegistry(":memory:");
    try {
      expect(reg.listRuns()).toEqual([]);
      const runId = reg.insertRun(makeMeta({ runTag: "tag-by-name" }), makeSummary());
      const byTag = reg.getRun("tag-by-name");
      expect(byTag).not.toBeNull();
      expect(byTag!.id).toBe(runId);
    } finally {
      reg.close();
    }
  });

  it("UNIQUE 冲突: 同 run_tag 二次 insertRun → 捕获 constraint 抛错, DB 不 corrupt", () => {
    const reg = openRegistry(":memory:");
    try {
      reg.insertRun(makeMeta(), makeSummary());
      expect(() => reg.insertRun(makeMeta(), makeSummary())).toThrow();
      // 库仍可用, 且只有 1 行
      expect(reg.listRuns().length).toBe(1);
      expect(reg.getRun("test-run-1")).not.toBeNull();
    } finally {
      reg.close();
    }
  });

  it("compare: 两 run 不同 passRate/分族分布 → summaryDiff/familyDiffs 正确", () => {
    const reg = openRegistry(":memory:");
    try {
      const aId = reg.insertRun(
        makeMeta({ runTag: "run-a", startedAt: "2026-09-01T00:00:00.000Z" }),
        makeSummary({ passed: 2, passRate: 100, byFamily: { coding: { total: 2, passed: 2, passRate: 100 } } }),
      );
      const bId = reg.insertRun(
        makeMeta({ runTag: "run-b", startedAt: "2026-09-02T00:00:00.000Z" }),
        makeSummary({
          passed: 1,
          passRate: 50,
          byFamily: { coding: { total: 2, passed: 1, passRate: 50 } },
        }),
      );

      const cmp = reg.compare(aId, bId);
      expect(cmp).not.toBeNull();
      expect(cmp!.summaryDiff.passRate).toBe(-50);
      expect(cmp!.familyDiffs.length).toBe(1);
      expect(cmp!.familyDiffs[0].family).toBe("coding");
      expect(cmp!.familyDiffs[0].passRateDiff).toBe(-50);
    } finally {
      reg.close();
    }
  });

  it("trend 排序: 乱序插入 → 返回按 started_at 升序", () => {
    const reg = openRegistry(":memory:");
    try {
      reg.insertRun(makeMeta({ runTag: "t2", startedAt: "2026-09-02T00:00:00.000Z" }), makeSummary());
      reg.insertRun(makeMeta({ runTag: "t1", startedAt: "2026-09-01T00:00:00.000Z" }), makeSummary());
      reg.insertRun(makeMeta({ runTag: "t3", startedAt: "2026-09-03T00:00:00.000Z" }), makeSummary());
      const trend = reg.getTrend();
      expect(trend.map((r) => r.runTag)).toEqual(["t1", "t2", "t3"]);
    } finally {
      reg.close();
    }
  });

  it("seed-baseline → getRun 读回含 src_doc + summary 字段", () => {
    const reg = openRegistry(":memory:");
    try {
      const id = reg.seedBaseline({
        name: "2026-08-13-42loop-baseline",
        pass: 23,
        total: 24,
        family: "coding",
        sourceDoc: "eval-results/agent-evals-2026-08-13-42loop.md",
        model: "deepseek-v4-flash",
      });
      const run = reg.getRun(id);
      expect(run).not.toBeNull();
      expect(run!.srcDoc).toBe("eval-results/agent-evals-2026-08-13-42loop.md");
      expect(run!.summaryTotal).toBe(24);
      expect(run!.summaryPassed).toBe(23);
      expect(run!.summaryPassRate).toBeCloseTo(95.8, 1);
      expect(reg.getTasks(id)).toEqual([]); // seed 无子行
    } finally {
      reg.close();
    }
  });

  it("容错: 损坏 summary JSON → sanitize 降级不抛", () => {
    const reg = openRegistry(":memory:");
    try {
      // 直接写一条 summary_by_family 损坏的行（绕过 API, 模拟历史脏数据）
      const db = reg.rawDb();
      db.query(
        `INSERT INTO eval_runs (run_tag, started_at, summary_total, summary_by_family)
         VALUES (?, ?, ?, ?)`,
      ).run("dirty-row", "2026-09-01T00:00:00.000Z", 1, "{not-json");
      const runs = reg.listRuns();
      expect(runs.length).toBe(1);
      expect(runs[0].summaryByFamily).toEqual({}); // 降级为空对象
    } finally {
      reg.close();
    }
  });

  it("双注入: os.tmpdir() 临时文件持久化 → 重开库读回", () => {
    const file = tmpDbFile("persist");
    try {
      const a = openRegistry(file);
      const runId = a.insertRun(makeMeta({ runTag: "persist-run" }), makeSummary());
      a.insertTaskResults(runId, [makeTask()]);
      a.close();

      const b = openRegistry(file);
      const run = b.getRun("persist-run");
      expect(run).not.toBeNull();
      expect(b.getTasks(runId).length).toBe(1);
      b.close();
    } finally {
      try { fs.rmSync(file, { force: true }); } catch { /* ignore */ }
    }
  });

  it("deleteRun 级联清子表", () => {
    const reg = openRegistry(":memory:");
    try {
      const runId = reg.insertRun(makeMeta(), makeSummary());
      reg.insertTaskResults(runId, [makeTask()]);
      expect(reg.getTasks(runId).length).toBe(1);
      reg.deleteRun(runId);
      expect(reg.getRun(runId)).toBeNull();
      expect(reg.getTasks(runId).length).toBe(0);
      expect(reg.listRuns()).toEqual([]);
    } finally {
      reg.close();
    }
  });
});
