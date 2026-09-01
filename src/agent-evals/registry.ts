/**
 * 评测结果回归基准入库（eval registry）— SQLite 落盘 + 查询。
 *
 * 设计（深模块）：小接口大实现。依 model-eval-service 的 bun:sqlite 先例
 * （参数化 SQL + CREATE TABLE IF NOT EXISTS + 索引）；依 skill-gain 的
 * 容错惯例（持久化失败 try/catch 不阻断评测；脏数据 sanitize 降级）。
 *
 * - eval_runs：一轮评测 = 一行，含 summary 快照 + git_commit + src_doc（手工
 *   基线来源文档，非空即 manual baseline 行，无子表行、exit_code 0）。
 * - eval_task_results：每任务一行，关联 run_id（ON DELETE CASCADE）。
 * - 落盘失败不抛（评测照常 stdout/exit）；查询层 sanitize 损坏行。
 */
import { Database } from "bun:sqlite";
import type {
  FamilySnapshot,
  RunComparison,
  RunFilter,
  RunMetadata,
  RunRow,
  RunSummarySnapshot,
  StoredTaskResult,
  StoredTaskRow,
} from "./metrics-types.js";

/** 默认落盘路径（.gitignore:22 已忽略 data/*.db） */
export const DEFAULT_REGISTRY_PATH = "data/eval-registry.db";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS eval_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_tag TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  model TEXT,
  provider TEXT,
  family_filter TEXT,
  split_filter TEXT,
  rerun_each INTEGER NOT NULL DEFAULT 0,
  evolve_phase TEXT,
  git_commit TEXT,
  src_argv TEXT,
  src_doc TEXT,
  summary_total INTEGER,
  summary_passed INTEGER,
  summary_pass_rate REAL,
  summary_train_rate REAL,
  summary_held_out_rate REAL,
  summary_generalization REAL,
  summary_avg_latency_ms REAL,
  summary_avg_output_len REAL,
  summary_by_family TEXT,
  exit_code INTEGER,
  CONSTRAINT uq_eval_runs_tag UNIQUE(run_tag)
);
CREATE TABLE IF NOT EXISTS eval_task_results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL REFERENCES eval_runs(id) ON DELETE CASCADE,
  task_id TEXT NOT NULL,
  family TEXT NOT NULL,
  split TEXT NOT NULL,
  passed INTEGER NOT NULL,
  reason TEXT,
  latency_ms REAL,
  output_len INTEGER,
  model TEXT,
  injected_skills TEXT,
  CONSTRAINT uq_eval_results_runtask UNIQUE(run_id, task_id)
);
CREATE INDEX IF NOT EXISTS idx_eval_results_run  ON eval_task_results(run_id);
CREATE INDEX IF NOT EXISTS idx_eval_runs_started ON eval_runs(started_at DESC);
CREATE INDEX IF NOT EXISTS idx_eval_runs_family  ON eval_runs(family_filter);
`;

/** 解析 JSON，失败降级为默认值（sanitize，不抛） */
function parseJson<T>(raw: unknown, fallback: T): T {
  if (typeof raw !== "string" || raw.length === 0) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** DB 行 → RunRow（sanitize：类型钳制 + JSON 降级） */
function rowToRun(row: Record<string, unknown>): RunRow {
  const family = parseJson<Record<string, FamilySnapshot>>(row.summary_by_family, {});
  return {
    id: Number(row.id),
    runTag: String(row.run_tag ?? ""),
    startedAt: String(row.started_at ?? ""),
    finishedAt: row.finished_at == null ? null : String(row.finished_at),
    model: row.model == null ? null : String(row.model),
    provider: row.provider == null ? null : String(row.provider),
    familyFilter: row.family_filter == null ? null : String(row.family_filter),
    splitFilter: row.split_filter == null ? null : String(row.split_filter),
    rerunEach: Number(row.rerun_each ?? 0),
    evolvePhase: row.evolve_phase == null ? null : String(row.evolve_phase),
    gitCommit: row.git_commit == null ? null : String(row.git_commit),
    srcArgv: row.src_argv == null ? null : String(row.src_argv),
    srcDoc: row.src_doc == null ? null : String(row.src_doc),
    summaryTotal: Number(row.summary_total ?? 0),
    summaryPassed: Number(row.summary_passed ?? 0),
    summaryPassRate: Number(row.summary_pass_rate ?? 0),
    summaryTrainRate: Number(row.summary_train_rate ?? 0),
    summaryHeldOutRate: Number(row.summary_held_out_rate ?? 0),
    summaryGeneralization: row.summary_generalization == null ? null : Number(row.summary_generalization),
    summaryAvgLatencyMs: Number(row.summary_avg_latency_ms ?? 0),
    summaryAvgOutputLen: Number(row.summary_avg_output_len ?? 0),
    summaryByFamily: family,
    exitCode: row.exit_code == null ? null : Number(row.exit_code),
  };
}

/** DB 行 → StoredTaskRow（sanitize） */
function rowToTask(row: Record<string, unknown>): StoredTaskRow {
  return {
    id: Number(row.id),
    runId: Number(row.run_id),
    taskId: String(row.task_id ?? ""),
    family: String(row.family ?? "") as StoredTaskRow["family"],
    split: String(row.split ?? "") as StoredTaskRow["split"],
    passed: Number(row.passed ?? 0) === 1,
    reason: row.reason == null ? null : String(row.reason),
    latencyMs: Number(row.latency_ms ?? 0),
    outputLen: Number(row.output_len ?? 0),
    model: row.model == null ? null : String(row.model),
    injectedSkills: parseJson<string[]>(row.injected_skills, []),
  };
}

export interface Registry {
  /** 底层 Database（测试注入脏数据用；生产代码不使用） */
  rawDb(): Database;
  /** 写入一轮（summary 快照），返回 run id。UNIQUE(run_tag) 冲突直接抛（retry 由调用方 persistRun 层处理）。 */
  insertRun(meta: RunMetadata, summary: RunSummarySnapshot): number;
  /** 写入一轮的逐任务结果 */
  insertTaskResults(runId: number, tasks: StoredTaskResult[]): void;
  /** 时间降序列出 run（filter 可选 family/model/limit） */
  listRuns(filter?: RunFilter): RunRow[];
  /** 按 id 或 run_tag 取单轮；不存在返回 null */
  getRun(ref: number | string): RunRow | null;
  /** 取一轮的逐任务结果（空返回 []） */
  getTasks(runId: number): StoredTaskRow[];
  /** 两轮并排对比（summaryDiff + familyDiffs）；任一轮缺失返回 null */
  compare(a: number | string, b: number | string): RunComparison | null;
  /** 时间升序趋势（filter 可选 family/model） */
  getTrend(filter?: RunFilter): RunRow[];
  /** 手工基线 seed（src_doc 必填；无子行；summary 由 pass/total 计算） */
  seedBaseline(opts: {
    name: string;
    pass: number;
    total: number;
    family?: string;
    sourceDoc: string;
    date?: string;
    model?: string;
  }): number;
  /** 删除一轮（CASCADE 清子表） */
  deleteRun(runId: number): void;
  close(): void;
}

export function openRegistry(dbPath: string = DEFAULT_REGISTRY_PATH): Registry {
  const db = new Database(dbPath);
  db.exec("PRAGMA foreign_keys = ON"); // ON DELETE CASCADE 生效必需（SQLite 默认关闭）
  db.exec(SCHEMA);

  const insertRunStmt = db.query(`
    INSERT INTO eval_runs (
      run_tag, started_at, finished_at, model, provider, family_filter, split_filter,
      rerun_each, evolve_phase, git_commit, src_argv, src_doc,
      summary_total, summary_passed, summary_pass_rate, summary_train_rate,
      summary_held_out_rate, summary_generalization, summary_avg_latency_ms,
      summary_avg_output_len, summary_by_family, exit_code
    ) VALUES (
      ?, ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?,
      ?, ?, ?, ?,
      ?, ?, ?,
      ?, ?, ?
    )
  `);

  const insertTaskStmt = db.query(`
    INSERT INTO eval_task_results (
      run_id, task_id, family, split, passed, reason, latency_ms, output_len, model, injected_skills
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const listAllStmt = db.query(`SELECT * FROM eval_runs ORDER BY started_at DESC`);
  const listFilteredStmt = db.query(`
    SELECT * FROM eval_runs
    WHERE (? IS NULL OR family_filter = ?) AND (? IS NULL OR model = ?)
    ORDER BY started_at DESC
  `);
  const getByIdStmt = db.query(`SELECT * FROM eval_runs WHERE id = ?`);
  const getByTagStmt = db.query(`SELECT * FROM eval_runs WHERE run_tag = ?`);
  const listTasksStmt = db.query(`SELECT * FROM eval_task_results WHERE run_id = ? ORDER BY task_id`);
  const trendStmt = db.query(`
    SELECT * FROM eval_runs
    WHERE (? IS NULL OR family_filter = ?) AND (? IS NULL OR model = ?)
    ORDER BY started_at ASC
  `);
  const deleteStmt = db.query(`DELETE FROM eval_runs WHERE id = ?`);

  function getRun(ref: number | string): RunRow | null {
    const row =
      typeof ref === "number"
        ? (getByIdStmt.get(ref) as Record<string, unknown> | null)
        : (getByTagStmt.get(ref) as Record<string, unknown> | null);
    return row ? rowToRun(row) : null;
  }

  return {
    rawDb: () => db,

    insertRun(meta, summary) {
      const now = new Date().toISOString();
      const info = insertRunStmt.run(
        meta.runTag,
        meta.startedAt ?? now,
        meta.finishedAt ?? null,
        meta.model ?? null,
        meta.provider ?? null,
        meta.familyFilter ?? null,
        meta.splitFilter ?? null,
        meta.rerunEach ?? 0,
        meta.evolvePhase ?? null,
        meta.gitCommit ?? null,
        meta.srcArgv ?? null,
        meta.srcDoc ?? null,
        summary.total,
        summary.passed,
        round2(summary.passRate),
        round2(summary.trainRate),
        round2(summary.heldOutRate),
        summary.generalizationRatio,
        round2(summary.avgLatencyMs),
        round2(summary.avgOutputLength),
        JSON.stringify(summary.byFamily ?? {}),
        meta.exitCode ?? null,
      );
      return Number(info.lastInsertRowid);
    },

    insertTaskResults(runId, tasks) {
      for (const t of tasks) {
        insertTaskStmt.run(
          runId,
          t.taskId,
          t.family,
          t.split,
          t.passed ? 1 : 0,
          t.reason ?? null,
          t.latencyMs,
          t.outputLength,
          t.model ?? null,
          JSON.stringify(t.injectedSkills ?? []),
        );
      }
    },

    listRuns(filter = {}) {
      const rows =
        filter.family === undefined && filter.model === undefined
          ? (listAllStmt.all() as Record<string, unknown>[])
          : (listFilteredStmt.all(
              filter.family ?? null,
              filter.family ?? null,
              filter.model ?? null,
              filter.model ?? null,
            ) as Record<string, unknown>[]);
      const runs = rows.map(rowToRun);
      return filter.limit !== undefined ? runs.slice(0, filter.limit) : runs;
    },

    getRun,

    getTasks(runId) {
      const rows = listTasksStmt.all(runId) as Record<string, unknown>[];
      return rows.map(rowToTask);
    },

    compare(a, b) {
      const ra = getRun(a);
      const rb = getRun(b);
      if (!ra || !rb) return null;
      const families = new Set([...Object.keys(ra.summaryByFamily), ...Object.keys(rb.summaryByFamily)]);
      const familyDiffs = [...families]
        .sort()
        .map((family) => ({
          family,
          a: ra.summaryByFamily[family] ?? null,
          b: rb.summaryByFamily[family] ?? null,
          passRateDiff:
            ra.summaryByFamily[family] && rb.summaryByFamily[family]
              ? round2(rb.summaryByFamily[family].passRate - ra.summaryByFamily[family].passRate)
              : null,
        }));
      return {
        a: ra,
        b: rb,
        summaryDiff: {
          passRate: round2(rb.summaryPassRate - ra.summaryPassRate),
          totalDiff: rb.summaryTotal - ra.summaryTotal,
          generalizationDiff:
            ra.summaryGeneralization != null && rb.summaryGeneralization != null
              ? round2(rb.summaryGeneralization - ra.summaryGeneralization)
              : null,
          avgLatencyDiff: round2(rb.summaryAvgLatencyMs - ra.summaryAvgLatencyMs),
        },
        familyDiffs,
      };
    },

    getTrend(filter = {}) {
      const rows =
        filter.family === undefined && filter.model === undefined
          ? (trendStmt.all(null, null, null, null) as Record<string, unknown>[])
          : (trendStmt.all(
              filter.family ?? null,
              filter.family ?? null,
              filter.model ?? null,
              filter.model ?? null,
            ) as Record<string, unknown>[]);
      return rows.map(rowToRun);
    },

    seedBaseline(opts) {
      if (!opts.sourceDoc) throw new Error("seed-baseline: sourceDoc 必填（标注来源文档，不造假 claim）");
      if (!(opts.total > 0)) throw new Error("seed-baseline: total 必须为正数");
      const passRate = round2((opts.pass / opts.total) * 100);
      const byFamily: Record<string, FamilySnapshot> = opts.family
        ? { [opts.family]: { total: opts.total, passed: opts.pass, passRate } }
        : {};
      return this.insertRun(
        {
          runTag: opts.name,
          startedAt: opts.date ?? new Date().toISOString(),
          model: opts.model,
          familyFilter: opts.family,
          srcDoc: opts.sourceDoc,
          exitCode: 0,
        },
        {
          total: opts.total,
          passed: opts.pass,
          passRate,
          byFamily,
          trainRate: 0,
          heldOutRate: passRate,
          generalizationRatio: null,
          avgLatencyMs: 0,
          avgOutputLength: 0,
        },
      );
    },

    deleteRun(runId) {
      deleteStmt.run(runId);
    },

    close() {
      try {
        db.close();
      } catch {
        // 已关闭/无关紧要
      }
    },
  };
}
