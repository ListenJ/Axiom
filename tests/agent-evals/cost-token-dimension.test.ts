/**
 * S1 成本/Token 维度 — 测试先行（红）。
 * 覆盖：
 *  1. summarize 聚合 avgCostUsd / totalCostUsd / avgPromptTokens / avgCompletionTokens
 *     （无成本数据时返回 null，不破坏既有调用方）
 *  2. registry 落库 roundtrip：task 级 token/cost 列 + run 级 summary 成本列
 *  3. runner 直连 provider 响应 usage 解析（注入 fake body，不连真实网络）
 */
import { describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { summarize, type TaskResult } from "../../src/agent-evals/metrics.js";
import { openRegistry } from "../../src/agent-evals/registry.js";
import type { RunSummarySnapshot, StoredTaskResult } from "../../src/agent-evals/metrics-types.js";
import { parseProviderUsage } from "../../src/agent-evals/runner.js";

// ===== metrics 聚合 =====
function result(overrides: Partial<TaskResult> = {}): TaskResult {
  return { taskId: "T-01", family: "coding", split: "held-out", passed: true, latencyMs: 100, outputLength: 50, ...overrides };
}

describe("metrics summarize 成本/Token 聚合", () => {
  it("有 costUsd 时聚合 avgCostUsd / totalCostUsd", () => {
    const s = summarize([
      result({ taskId: "a", costUsd: 0.001 }),
      result({ taskId: "b", costUsd: 0.003 }),
      result({ taskId: "c", costUsd: 0.002 }),
    ]);
    expect(s.totalCostUsd).toBeCloseTo(0.006, 6);
    expect(s.avgCostUsd).toBeCloseTo(0.002, 6);
  });

  it("无 costUsd 数据时 avgCostUsd / totalCostUsd 为 null（不破坏既有调用方）", () => {
    const s = summarize([result({ taskId: "a" }), result({ taskId: "b" })]);
    expect(s.totalCostUsd).toBeNull();
    expect(s.avgCostUsd).toBeNull();
  });

  it("有 tokenUsage 时聚合 avgPromptTokens / avgCompletionTokens", () => {
    const s = summarize([
      result({ taskId: "a", tokenUsage: { promptTokens: 100, completionTokens: 20, totalTokens: 120 } }),
      result({ taskId: "b", tokenUsage: { promptTokens: 300, completionTokens: 60, totalTokens: 360 } }),
    ]);
    expect(s.avgPromptTokens).toBe(200);
    expect(s.avgCompletionTokens).toBe(40);
  });

  it("无 tokenUsage 时 avgPromptTokens / avgCompletionTokens 为 null", () => {
    const s = summarize([result({ taskId: "a" })]);
    expect(s.avgPromptTokens).toBeNull();
    expect(s.avgCompletionTokens).toBeNull();
  });

  it("部分任务有成本时只对有效样本求均值（分母为有成本样本数）", () => {
    const s = summarize([
      result({ taskId: "a", costUsd: 0.001 }),
      result({ taskId: "b" }), // 无成本
      result({ taskId: "c", costUsd: 0.005 }),
    ]);
    expect(s.totalCostUsd).toBeCloseTo(0.006, 6);
    expect(s.avgCostUsd).toBeCloseTo(0.003, 6);
  });
});

// ===== registry roundtrip =====
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
  return path.join(os.tmpdir(), `eval-registry-cost-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

describe("eval registry 成本/Token 列 roundtrip", () => {
  it("task 级 prompt_tokens / completion_tokens / cost_usd 落库并读回", () => {
    const reg = openRegistry(":memory:");
    try {
      const runId = reg.insertRun(
        { runTag: "cost-run", model: "m", familyFilter: "coding" },
        makeSummary({ avgCostUsd: 0.002, totalCostUsd: 0.006, avgPromptTokens: 200, avgCompletionTokens: 40 }),
      );
      reg.insertTaskResults(runId, [
        makeTask({ taskId: "CODING-01", promptTokens: 100, completionTokens: 20, costUsd: 0.001 }),
        makeTask({ taskId: "CODING-02", promptTokens: 300, completionTokens: 60, costUsd: 0.005 }),
      ]);

      const run = reg.getRun(runId);
      expect(run!.summaryAvgCostUsd).toBeCloseTo(0.002, 6);
      expect(run!.summaryTotalCostUsd).toBeCloseTo(0.006, 6);

      const tasks = reg.getTasks(runId);
      const t1 = tasks.find((t) => t.taskId === "CODING-01")!;
      expect(t1.promptTokens).toBe(100);
      expect(t1.completionTokens).toBe(20);
      expect(t1.costUsd).toBeCloseTo(0.001, 6);
      const t2 = tasks.find((t) => t.taskId === "CODING-02")!;
      expect(t2.promptTokens).toBe(300);
      expect(t2.completionTokens).toBe(60);
      expect(t2.costUsd).toBeCloseTo(0.005, 6);
    } finally {
      reg.close();
    }
  });

  it("无成本数据时新列默认 null（老调用方不传新字段仍绿）", () => {
    const reg = openRegistry(":memory:");
    try {
      const runId = reg.insertRun({ runTag: "plain-run" }, makeSummary());
      reg.insertTaskResults(runId, [makeTask()]);
      const run = reg.getRun(runId);
      expect(run!.summaryAvgCostUsd).toBeNull();
      expect(run!.summaryTotalCostUsd).toBeNull();
      const tasks = reg.getTasks(runId);
      expect(tasks[0].promptTokens).toBeNull();
      expect(tasks[0].completionTokens).toBeNull();
      expect(tasks[0].costUsd).toBeNull();
    } finally {
      reg.close();
    }
  });

  it("老库（无成本列）打开时 ensureColumn 迁移补列，roundtrip 正常", () => {
    const dbPath = tmpDbFile("legacy");
    // 先用旧 schema 建库：模拟老库只有 executionError 列
    const { Database } = require("bun:sqlite") as typeof import("bun:sqlite");
    const legacy = new Database(dbPath);
    legacy.exec(`
      CREATE TABLE eval_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_tag TEXT NOT NULL, started_at TEXT NOT NULL, finished_at TEXT,
        model TEXT, provider TEXT, family_filter TEXT, split_filter TEXT,
        rerun_each INTEGER NOT NULL DEFAULT 0, evolve_phase TEXT,
        git_commit TEXT, src_argv TEXT, src_doc TEXT,
        summary_total INTEGER, summary_passed INTEGER, summary_pass_rate REAL,
        summary_train_rate REAL, summary_held_out_rate REAL, summary_generalization REAL,
        summary_avg_latency_ms REAL, summary_avg_output_len REAL,
        summary_by_family TEXT, summary_execution_errors INTEGER NOT NULL DEFAULT 0,
        exit_code INTEGER, CONSTRAINT uq_eval_runs_tag UNIQUE(run_tag)
      );
      CREATE TABLE eval_task_results (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id INTEGER NOT NULL REFERENCES eval_runs(id) ON DELETE CASCADE,
        task_id TEXT NOT NULL, family TEXT NOT NULL, split TEXT NOT NULL,
        passed INTEGER NOT NULL, reason TEXT, latency_ms REAL, output_len INTEGER,
        model TEXT, injected_skills TEXT, execution_error INTEGER NOT NULL DEFAULT 0,
        CONSTRAINT uq_eval_results_runtask UNIQUE(run_id, task_id)
      );
    `);
    legacy.close();

    try {
      const reg = openRegistry(dbPath); // 触发 ensureColumn 迁移
      try {
        const runId = reg.insertRun({ runTag: "migrated-run" }, makeSummary({ avgCostUsd: 0.001 }));
        reg.insertTaskResults(runId, [makeTask({ promptTokens: 50, costUsd: 0.0005 })]);
        const run = reg.getRun(runId);
        expect(run!.summaryAvgCostUsd).toBeCloseTo(0.001, 6);
        // 未提供 total 时落 null（与「无成本数据默认 null」口径一致，不臆造 0）
        expect(run!.summaryTotalCostUsd).toBeNull();
        const tasks = reg.getTasks(runId);
        expect(tasks[0].promptTokens).toBe(50);
        expect(tasks[0].completionTokens).toBeNull();
        expect(tasks[0].costUsd).toBeCloseTo(0.0005, 6);
      } finally {
        reg.close();
      }
    } finally {
      fs.rmSync(dbPath, { force: true });
    }
  });
});

// ===== runner usage 解析 =====
describe("parseProviderUsage（OpenAI 兼容 /chat/completions 响应体 usage 解析）", () => {
  it("解析 usage.prompt_tokens / completion_tokens / total_tokens", () => {
    const body = JSON.stringify({
      choices: [{ message: { content: "hello" } }],
      usage: { prompt_tokens: 128, completion_tokens: 32, total_tokens: 160 },
    });
    expect(parseProviderUsage(body)).toEqual({ promptTokens: 128, completionTokens: 32, totalTokens: 160 });
  });

  it("无 usage 字段返回 undefined（不阻断评测）", () => {
    const body = JSON.stringify({ choices: [{ message: { content: "hello" } }] });
    expect(parseProviderUsage(body)).toBeUndefined();
  });

  it("非法 JSON 返回 undefined", () => {
    expect(parseProviderUsage("not-json")).toBeUndefined();
  });

  it("usage 部分缺字段时保留可用字段", () => {
    const body = JSON.stringify({ usage: { prompt_tokens: 10 } });
    expect(parseProviderUsage(body)).toEqual({ promptTokens: 10 });
  });
});
