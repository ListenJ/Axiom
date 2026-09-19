/**
 * Real Usage 采集与进化闭环 — 最小深模块实现
 *
 * 设计：小接口 `capture/load/evolve/clear`，大量行为藏于内部（文件追加、去重、归纳、晋升）。
 * 依赖注入：文件路径可配（env `REAL_USAGE_PATH`），便于测试隔离；进化引擎通过 `createDefaultSelfEvolve` 注入。
 * 确定性：`capture` 追加写为原子 `appendFileSync`；`load` 按行解析；`evolve` 归纳结果排序稳定。
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { logger } from "../utils/logger.js";
import { readNumber, readString } from "../utils/env.js";
import type { TaskTrace } from "../self-evolve/types.js";
import type { AgentTrace } from "../utils/agent-trace.js";
import type { InductionPromotionDeps } from "../self-evolve/skill-promotion.js";
import {
  COMPACTION_TRIGGER_DEFAULTS,
  decideCompaction,
  resolvePolicy,
  selectRetained,
  type CompactionDecision,
  type RetentionPolicy,
  type RetentionRecord,
  type RetentionSignals,
} from "./trace-retention.js";

export interface RealUsageTrace extends TaskTrace {
  /** 使用的模型 */
  model?: string;
  /** 延迟 ms */
  latencyMs?: number;
  /** 时间戳 */
  timestamp?: number;
  /** 来源：chat / agent-chat / manual */
  source?: string;
  /** 反馈：显式 thumbsUp/thumbsDown 或隐式 success */
  feedback?: string;
  /** 该任务的 token 总量（计划切片 A） */
  totalTokens?: number;
  /** 按显式分类的 token 用量，如 { main: 1200, embedding: 300 }（决策 Q3） */
  tokensByCategory?: Record<string, number>;
  /**
   * 会话标识（切片 A3c）。用于保留策略的**会话原子**分组与活跃豁免。
   * 仅在调用方确有"被持久化的会话"时才应带上 —— 不要为无会话的端点伪造 UUID，
   * 否则每次请求都会变成一个独立会话，反而让分组失去意义（见 chat.ts 站点 2 注释）。
   */
  sessionId?: string;
}

export const REAL_USAGE_PATH = readString("REAL_USAGE_PATH", path.join(process.cwd(), "data", "real-usage-traces.jsonl"));

function resolvePath(p?: string): string {
  return p ?? (readString("REAL_USAGE_PATH") || REAL_USAGE_PATH);
}

function ensureDir(filePath: string): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// 批处理队列：高并发下聚合 10 条或 50ms 刷新，减少同步 I/O 阻塞（优化）
const pendingWrites = new Map<string, string[]>();
const flushTimers = new Map<string, ReturnType<typeof setTimeout>>();
// per-target 串行写链：保证同一 target 的 appendFile 严格按序执行、不并发交错，
// flush 期间新入队的批也会被后续链段取走，不丢批（并发 flush 依次排队）。
const flushChains = new Map<string, Promise<void>>();

/**
 * 单次 flush 一个批次（取走当前队列）。返回是否还有更多待写（append 期间可能新入队）。
 */
async function flushOneBatch(target: string): Promise<void> {
  const batch = pendingWrites.get(target);
  if (!batch || batch.length === 0) return;
  pendingWrites.set(target, []);
  const timer = flushTimers.get(target);
  if (timer) {
    clearTimeout(timer);
    flushTimers.delete(target);
  }
  const payload = batch.join("");
  // 异步追加，不阻塞事件循环；失败仅日志
  try {
    await fs.promises.appendFile(target, payload, "utf8");
  } catch (e) {
    logger.warn("[RealUsage] flush failed", { error: (e as Error).message });
  }
}

async function flushPending(target: string): Promise<void> {
  // 串行化：同一 target 的多次 flush 排队执行；每条链段执行后检查是否又积压，积压则继续
  const prev = flushChains.get(target) ?? Promise.resolve();
  const next = prev.then(async () => {
    for (;;) {
      const batch = pendingWrites.get(target);
      if (!batch || batch.length === 0) break; // 队列空 → 链段结束
      await flushOneBatch(target);
    }
  });
  flushChains.set(target, next.catch(() => {})); // 链尾吞错，避免断链（flush 无返回值语义）
  await next;
}

/**
 * 测试流量守卫：bun test 设 NODE_ENV=test，chat 路由测试（mock model m1 驱动真实
 * handleChat）若不隔离 REAL_USAGE_PATH 会往生产 JSONL 追加测试噪声，毒化学习信号。
 * 生产默认落点（省略 filePath）在测试环境跳过；显式 filePath（单元测试/自定义落点）不受影响。
 */
/**
 * AgentTrace → RealUsageTrace 的**映射层**（计划切片 A2）。
 *
 * 为什么必须有它：`loadRealUsageTraces()` 的收行条件是
 *   `typeof obj.id === "string" && typeof obj.task === "string"`（见下方 load 实现）
 * 而 `AgentTrace` 只有 `{ agentName, taskId, startTime, steps, status, result? }`。
 * 直接把 AgentTrace 写进 JSONL，加载时会被**静默跳过**（文件有行、读出来为空、不报错）。
 * 因此这里显式做形状映射，并由测试
 * `tests/agent-evals/agent-trace-capture.test.ts` 的负向对照用例钉死该陷阱。
 */
export interface AgentTraceCaptureOptions {
  /** 落点（测试隔离用；缺省走 REAL_USAGE_PATH） */
  filePath?: string;
  /** 任务描述。AgentTrace 只有 taskId、没有任务描述，故需调用方补。缺省回落 agentName。 */
  task?: string;
  model?: string;
  latencyMs?: number;
  totalTokens?: number;
  tokensByCategory?: Record<string, number>;
  /** 会话标识；缺省则该轨迹作为独立单元参与保留判定 */
  sessionId?: string;
}

export async function captureAgentTrace(
  trace: AgentTrace,
  opts: AgentTraceCaptureOptions = {},
): Promise<void> {
  const mapped: RealUsageTrace = {
    id: trace.taskId,                        // ← 满足 loader 的 id 条件
    task: opts.task ?? trace.agentName,      // ← 满足 loader 的 task 条件
    success: trace.status === "completed",   // running/failed 均视为未成功
    timestamp: trace.startTime,
    source: "agent-trace",
    ...(opts.model !== undefined ? { model: opts.model } : {}),
    ...(opts.latencyMs !== undefined ? { latencyMs: opts.latencyMs } : {}),
    ...(opts.totalTokens !== undefined ? { totalTokens: opts.totalTokens } : {}),
    ...(opts.tokensByCategory !== undefined ? { tokensByCategory: opts.tokensByCategory } : {}),
    ...(opts.sessionId !== undefined ? { sessionId: opts.sessionId } : {}),
  };
  await captureRealUsageTrace(mapped, opts.filePath);
}

function shouldSkipCapture(filePath?: string): boolean {
  if (filePath !== undefined) return false; // 显式路径（单元测试/自定义落点）不跳过
  // 生产默认落点：测试环境跳过。大小写鲁棒（validateEnv 接受 Test/TEST，需与之一致，防 CI 设大写绕过守卫）
  return readString("NODE_ENV", "").toLowerCase() === "test";
}

/**
 * 采集一条真实使用轨迹（批处理异步追加，保序且高并发友好）
 */
export async function captureRealUsageTrace(trace: RealUsageTrace, filePath?: string): Promise<void> {
  if (shouldSkipCapture(filePath)) {
    logger.debug("[RealUsage] skip capture in test env", { id: trace.id });
    return;
  }
  const target = resolvePath(filePath);
  ensureDir(target);
  const enriched: RealUsageTrace = {
    ...trace,
    timestamp: trace.timestamp ?? Date.now(),
    source: trace.source ?? "chat",
  };
  const line = JSON.stringify(enriched) + "\n";
  const queue = pendingWrites.get(target) ?? [];
  queue.push(line);
  pendingWrites.set(target, queue);
  logger.info("[RealUsage] captured", { id: enriched.id, success: enriched.success });
  // 批大小≥10 立即刷新，否则 50ms 防抖
  if (queue.length >= 10) {
    await flushPending(target);
  } else if (!flushTimers.has(target)) {
    const t = setTimeout(() => { void flushPending(target); }, 50);
    flushTimers.set(target, t as unknown as ReturnType<typeof setTimeout>);
  }

  // 精细化触发：廉价探测（stat + statfs）→ 仅在超阈值且过冷却时才排队重写。
  // fire-and-forget：压实是维护行为，失败**不得**影响采集主流程。
  void maybeCompactRealUsageTraces(target).catch((e) =>
    logger.warn("[RealUsage] compaction trigger failed", {
      error: e instanceof Error ? e.message : String(e),
    }),
  );
}

/**
 * 强制刷新指定路径的挂起写入（供 load/evolve 前调用以保证一致性）
 */
export async function flushRealUsageTraces(filePath?: string): Promise<void> {
  const target = resolvePath(filePath);
  await flushPending(target);
}

/**
 * 加载全部真实轨迹（先刷新挂起批次以保证读一致性）
 */
export async function loadRealUsageTraces(filePath?: string): Promise<RealUsageTrace[]> {
  const target = resolvePath(filePath);
  await flushPending(target);
  if (!fs.existsSync(target)) return [];
  const content = fs.readFileSync(target, "utf8");
  const lines = content.split("\n").filter(l => l.trim().length > 0);
  const traces: RealUsageTrace[] = [];
  for (const line of lines) {
    try {
      const obj = JSON.parse(line);
      if (obj && typeof obj.id === "string" && typeof obj.task === "string") {
        traces.push(obj as RealUsageTrace);
      }
    } catch {
      logger.warn("[RealUsage] skip malformed line", { line: line.slice(0, 80) });
    }
  }
  return traces;
}

/** 压实结果（含 signals 与策略，便于复现一次裁剪决策） */
export interface CompactionResult {
  /** true = 未重写文件（无可淘汰项 / 文件不存在） */
  skipped: boolean;
  reason?: "no-file" | "nothing-to-drop";
  policy: RetentionPolicy;
  signals: RetentionSignals;
  bytesBefore: number;
  bytesAfter: number;
  kept: number;
  dropped: number;
  droppedByTime: number;
  droppedBySize: number;
  /** 解析失败/形状不合规而被丢弃的行数（显式上报，不静默） */
  malformedDropped: number;
}

/**
 * 压实轨迹文件：按「体积 × 时间 × 会话」策略裁剪并**原子重写**（切片 A3b）。
 *
 * 为什么需要：A3a/A3d 只交付了纯函数，**磁盘仍是无上限纯追加** ——
 * 只落盘不设限，等于把 B3-Medium 修掉的内存无界增长搬到磁盘。
 *
 * 关键实现约束（均有据可查）：
 *  1. **先 flush 挂起批次**：否则刚采集但尚未落盘的记录会在重写时被抹掉。
 *  2. **tmp + renameSync 原子重写**：镜像同目录 `auto-evolve.ts:71` 的既有范式；
 *     失败清理临时文件后原样抛出，由调用方容错。
 *  3. **不用流式读句柄**：`logger.ts:95` 记录过 Windows 上"句柄未释放即 renameSync
 *     导致 EPERM/EBUSY"的坑；此处用 `readFileSync`（读完即关），规避该路径。
 *  4. **策略可注入**：`opts.policy` 供测试构造"体积超限"（真实磁盘有 300+ GiB 空闲，
 *     不注入就无法构造该场景，等于没测）。缺省则由 `resolvePolicy(signals)` 按场景推导。
 */
export async function compactRealUsageTraces(
  filePath?: string,
  opts?: { policy?: RetentionPolicy; now?: number },
): Promise<CompactionResult> {
  const target = resolvePath(filePath);
  await flushPending(target); // 约束 1
  return rewriteTraceFile(target, opts?.policy, opts?.now);
}

/**
 * 核心重写（不做 flush、不排队）——调用方负责保证"队列已空且无并发追加"。
 * 拆分出来的原因：`maybeCompactRealUsageTraces` 需要把重写**排进 per-target 写链**
 * （避免与 appendFile 赛跑），若在链内再调 `flushPending` 会自锁。
 */
async function rewriteTraceFile(
  target: string,
  policyIn?: RetentionPolicy,
  nowIn?: number,
  /** 回收目标（低水位）。给出时用它覆盖 policy.maxBytes，使压实真正收敛到低水位 */
  reclaimToBytes?: number,
): Promise<CompactionResult> {

  const emptySignals: RetentionSignals = {
    fileBytes: 0, recordCount: 0, sessionCount: 0, freeDiskBytes: 0,
  };

  if (!fs.existsSync(target)) {
    return {
      skipped: true, reason: "no-file",
      policy: policyIn ?? resolvePolicy(emptySignals),
      signals: emptySignals,
      bytesBefore: 0, bytesAfter: 0,
      kept: 0, dropped: 0, droppedByTime: 0, droppedBySize: 0, malformedDropped: 0,
    };
  }

  const content = fs.readFileSync(target, "utf-8"); // 约束 3：读完即关，不留句柄
  const lines = content.split("\n").filter((l) => l.trim().length > 0);
  const records: RetentionRecord[] = [];
  let malformedDropped = 0;
  for (const line of lines) {
    try {
      // 形状校验后才入列：与 loadRealUsageTraces 的收行条件保持一致，避免"写了读不到"
      const obj = JSON.parse(line) as RetentionRecord;
      if (obj && typeof obj.id === "string" && typeof obj.task === "string") records.push(obj);
      else malformedDropped++;
    } catch {
      malformedDropped++;
    }
  }

  const fileBytes = fs.statSync(target).size;
  const sessionCount = new Set(
    records.map((r) => r.sessionId).filter((v): v is string => typeof v === "string" && v.length > 0),
  ).size;

  let freeDiskBytes = 0;
  try {
    const st = fs.statfsSync(path.dirname(target));
    freeDiskBytes = Number(st.bavail) * Number(st.bsize);
  } catch (e) {
    // 平台不支持时保守取 0（→ resolvePolicy 落到最严档），并如实记日志，不假装成功
    logger.warn("[RealUsage] statfsSync unavailable; fallback to 0", {
      error: e instanceof Error ? e.message : String(e),
    });
  }

  const signals: RetentionSignals = { fileBytes, recordCount: records.length, sessionCount, freeDiskBytes };
  const policy = policyIn ?? resolvePolicy(signals);
  const now = nowIn ?? Date.now();
  // 低水位回收：只覆盖 maxBytes，其余策略（时间窗口/活跃豁免/下限）保持不变
  const selectionPolicy = reclaimToBytes !== undefined
    ? { ...policy, maxBytes: reclaimToBytes }
    : policy;
  const outcome = selectRetained(records, selectionPolicy, now);

  if (outcome.drop.length === 0 && malformedDropped === 0) {
    return {
      skipped: true, reason: "nothing-to-drop",
      policy, signals,
      bytesBefore: outcome.bytesBefore, bytesAfter: outcome.bytesBefore,
      kept: outcome.keep.length, dropped: 0,
      droppedByTime: 0, droppedBySize: 0, malformedDropped: 0,
    };
  }

  // 约束 2：原子重写
  const payload = outcome.keep.length > 0
    ? outcome.keep.map((r) => JSON.stringify(r)).join("\n") + "\n"
    : "";
  const tmpPath = `${target}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tmpPath, payload, "utf-8");
    fs.renameSync(tmpPath, target);
  } catch (e) {
    try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
    throw e;
  }

  logger.info("[RealUsage] compacted trace file", {
    kept: outcome.keep.length,
    dropped: outcome.drop.length,
    malformedDropped,
    bytesBefore: outcome.bytesBefore,
    bytesAfter: outcome.bytesAfter,
  });

  return {
    skipped: false,
    policy, signals,
    bytesBefore: outcome.bytesBefore,
    bytesAfter: outcome.bytesAfter,
    kept: outcome.keep.length,
    dropped: outcome.drop.length,
    droppedByTime: outcome.droppedByTime,
    droppedBySize: outcome.droppedBySize,
    malformedDropped,
  };
}

/**
 * 清空轨迹（测试/维护用）
 */
export async function clearRealUsageTraces(filePath?: string): Promise<void> {
  const target = resolvePath(filePath);
  // 清理挂起批次与定时器，避免清空后旧批次被 flush 写回（测试合规性）。
  // 刻意先清 pendingWrites 再等写链排空：排空期间新 capture 由自己的链段追加，
  // 不受本清空影响（不丢新数据）；代价是与"立即 flush 的新批"存在极窄竞态，
  // 可能丢该批（trade-off：维护/测试清空优先于丢失新批概率）。
  pendingWrites.delete(target);
  const t = flushTimers.get(target);
  if (t) {
    clearTimeout(t);
    flushTimers.delete(target);
  }
  // 等待进行中的串行写链排空（此时其队列已空，排空即结束），再清空文件
  await flushChains.get(target)?.catch(() => {});
  flushChains.delete(target);
  if (fs.existsSync(target)) fs.writeFileSync(target, "", "utf8");
}

/**
 * 轨迹文件健康评估（数据质量 sentinel，2026-09-01）：
 * 统计非空行总数、畸形行数（JSON 解析失败或缺 id/task 字段）与畸形率。
 * 只读，不改动文件。供 evolve 前做拒卷门，防脏数据/损坏文件被误归纳产生垃圾 skill。
 */
export interface TraceHealth {
  /** 非空行总数 */
  total: number;
  /** 畸形行数（JSON 解析失败或缺 id/task） */
  malformed: number;
  /** 畸形率 = malformed / total（total=0 时为 0） */
  malformedRate: number;
}

export async function assessTraceHealth(filePath?: string): Promise<TraceHealth> {
  const target = resolvePath(filePath);
  await flushPending(target);
  if (!fs.existsSync(target)) return { total: 0, malformed: 0, malformedRate: 0 };
  const content = fs.readFileSync(target, "utf8");
  const lines = content.split("\n").filter((l) => l.trim().length > 0);
  let malformed = 0;
  for (const line of lines) {
    try {
      const obj = JSON.parse(line);
      if (!obj || typeof obj.id !== "string" || typeof obj.task !== "string") malformed++;
    } catch {
      malformed++;
    }
  }
  const total = lines.length;
  return { total, malformed, malformedRate: total === 0 ? 0 : malformed / total };
}

/**
 * 从真实轨迹进化（归纳→晋升 skill）
 * 优化：大文件增量采样（近 N 条 + 按 task 去重），避免 10k+ 历史膨胀导致归纳噪声与延迟
 * 复用 `createDefaultSelfEvolve` 的 selfInduce + promoteInductionsToSkills 链路
 *
 * 数据质量 sentinel：归纳前先评估健康度，畸形率 ≥ 阈值（默认 0.2，env
 * `AXIOM_EVOLVE_MAX_MALFORMED_RATE` 可调，clamp [0,1]）时**拒卷**（refused 字段），
 * 不删除、不改动轨迹文件——只阻止脏数据上归纳产生误差。
 */
export async function evolveFromRealUsage(
  filePath?: string,
  opts?: {
    maxTraces?: number;
    dedupByTask?: boolean;
    /** 归纳晋升依赖注入：默认写真实技能目录（axiom-memory/03-Resources/skills），
     *  测试/巡检可注入 fake deps 隔离，避免每次 evolve 污染真实 skill 库。 */
    promotionDeps?: InductionPromotionDeps;
  }
): Promise<{ traceCount: number; inductionCount: number; created: string[]; sampled: number; refused?: string; health?: TraceHealth }> {
  // sentinel：畸形率拒卷门。traceCount 语义与正常路径一致 = 合法轨迹数（total - malformed）。
  const health = await assessTraceHealth(filePath);
  const validCount = health.total - health.malformed;
  if (health.total > 0) {
    const maxRate = readNumber("AXIOM_EVOLVE_MAX_MALFORMED_RATE", 0.2, { min: 0, max: 1 });
    if (health.malformedRate >= maxRate) {
      logger.warn("[RealUsage] evolve refused: malformed rate too high (sentinel)", {
        total: health.total,
        malformed: health.malformed,
        malformedRate: health.malformedRate,
        threshold: maxRate,
      });
      return { traceCount: validCount, inductionCount: 0, created: [], sampled: 0, refused: "malformed-rate", health };
    }
  }
  const allTraces = await loadRealUsageTraces(filePath);
  if (allTraces.length === 0) {
    logger.info("[RealUsage] no traces to evolve");
    return { traceCount: 0, inductionCount: 0, created: [], sampled: 0 };
  }
  const maxTraces = opts?.maxTraces ?? 200;
  const dedup = opts?.dedupByTask ?? true;
  // 增量采样：取最近 maxTraces 条
  let sampled = allTraces.slice(-maxTraces);
  const beforeDedup = sampled.length;
  if (dedup) {
    const seen = new Set<string>();
    const deduped: RealUsageTrace[] = [];
    // 逆序保留最新，按 task 去重
    for (let i = sampled.length - 1; i >= 0; i--) {
      const t = sampled[i];
      const key = `${t.task.slice(0, 80)}|${t.success}`;
      if (!seen.has(key)) {
        seen.add(key);
        deduped.push(t);
      }
    }
    sampled = deduped.reverse();
    logger.info("[RealUsage] dedup", { before: beforeDedup, after: sampled.length });
  }
  // 动态导入避免 cycle
  const { createDefaultSelfEvolve } = await import("../self-evolve/index.js");
  const { promoteInductionsToSkills } = await import("../self-evolve/skill-promotion.js");
  const engine = createDefaultSelfEvolve();
  const inductions = engine.selfInduce(sampled as TaskTrace[], Math.min(10, sampled.length));
  // promotionDeps 可注入（测试隔离用）；缺省走 defaultDeps 写真实技能目录（生产行为不变）
  const created = promoteInductionsToSkills(inductions, opts?.promotionDeps);
  logger.info("[RealUsage] evolved", { traceCount: allTraces.length, sampled: sampled.length, inductionCount: inductions.length, created: created.length });
  return { traceCount: allTraces.length, inductionCount: inductions.length, created, sampled: sampled.length };
}

/**
 * CLI 入口：`bun run src/agent-evals/real-usage.ts --evolve [--path=...]`
 */
if (import.meta.main) {
  const args = Bun.argv.slice(2);
  const wantsEvolve = args.includes("--evolve");
  const pathArg = args.find(a => a.startsWith("--path="))?.split("=")[1];
  if (wantsEvolve) {
    const result = await evolveFromRealUsage(pathArg);
    logger.info(JSON.stringify(result, null, 2));
  } else {
    const traces = await loadRealUsageTraces(pathArg);
    logger.info(`Real usage traces: ${traces.length}`);
    for (const t of traces.slice(-10)) logger.info(`- [${t.success ? "OK" : "FAIL"}] ${t.id}: ${t.task.slice(0, 60)}`);
  }
}

// ============================================================================
// 精细化触发：廉价探测 → 纯决策 → 排队重写
// ============================================================================

export interface MaybeCompactionOutcome {
  /** true = 本次真的执行了重写 */
  ran: boolean;
  decision: CompactionDecision;
  result?: CompactionResult;
  /** true = 复用了进行中的压实（single-flight 去重） */
  deduped?: boolean;
  /** 被他进程的跨进程锁挡住（本次未压实） */
  blockedBy?: "other-process";
}

let _compactionInFlight: Promise<MaybeCompactionOutcome> | null = null;
let _lastCompactionAt: number | null = null;

/** 诊断/测试用：上次压实时间（毫秒）；null = 从未压实 */
export function getLastCompactionAt(): number | null {
  return _lastCompactionAt;
}

/** 测试用：重置模块级压实状态（避免用例间串扰） */
export function resetCompactionStateForTest(): void {
  _compactionInFlight = null;
  _lastCompactionAt = null;
}

/**
 * 精细化触发入口：**廉价探测 → 决策 → 仅在值得时排队重写**。
 *
 * 分层理由：
 *  - 全量压实要读+解析+重写整个文件，代价与文件大小同阶；
 *    故先用**两次系统调用**（`statSync` 体积 / `statfsSync` 可用空间）判断是否值得扫。
 *  - 判断本身是纯函数 `decideCompaction`（冷却优先于阈值，防止高压下反复重写）。
 *  - 真正重写时**排进 per-target 写链**（复用既有 `flushChains`）⇒ 不会与 `appendFile`
 *    赛跑：此时新到的采集只会入队，其 flush 排在本次重写之后，追加落在**新文件**上，不丢数据。
 *
 * 并发边界（如实标注）：single-flight 只覆盖**进程内**；
 * 多进程同时压实同一文件**未加跨进程锁**（仓库无既有锁工具，见 ops log）。
 */
export function maybeCompactRealUsageTraces(
  filePath?: string,
  opts?: {
    policy?: RetentionPolicy;
    now?: number;
    /** true = 跳过阈值/冷却判断，直接压实（供显式命令/维护用） */
    force?: boolean;
    trigger?: { triggerRatio?: number; cooldownMs?: number; reclaimRatio?: number };
    /** 显式指定回收目标（测试/维护用）；缺省在自行推导策略时取 decision.reclaimTargetBytes */
    reclaimToBytes?: number;
  },
): Promise<MaybeCompactionOutcome> {
  // single-flight：本函数**非 async**，赋值前无 await ⇒ 同步发布，无交错窗口
  if (_compactionInFlight) {
    // 语义：`ran` = **本次调用是否执行了重写**。被去重者复用了别人的结果，
    // 故 ran=false + deduped=true，避免调用方误以为自己也跑了一次。
    return _compactionInFlight.then((r) => ({ ...r, ran: false, deduped: true }));
  }
  const target = resolvePath(filePath);
  const run = runMaybeCompact(target, opts);
  const tracked = run.then(
    (r) => { _compactionInFlight = null; return r; },
    (e) => { _compactionInFlight = null; throw e; },
  );
  _compactionInFlight = tracked;
  return tracked;
}

async function runMaybeCompact(
  target: string,
  opts?: {
    policy?: RetentionPolicy;
    now?: number;
    force?: boolean;
    trigger?: { triggerRatio?: number; cooldownMs?: number; reclaimRatio?: number };
    reclaimToBytes?: number;
  },
): Promise<MaybeCompactionOutcome> {
  const now = opts?.now ?? Date.now();

  // —— 廉价探测（两次系统调用；不解析文件）——
  let fileBytes = 0;
  let freeDiskBytes = 0;
  if (fs.existsSync(target)) {
    try { fileBytes = fs.statSync(target).size; } catch { fileBytes = 0; }
    try {
      const st = fs.statfsSync(path.dirname(target));
      freeDiskBytes = Number(st.bavail) * Number(st.bsize);
    } catch (e) {
      // 平台不支持时保守取 0（→ 最严档），并如实记日志
      logger.warn("[RealUsage] statfsSync unavailable during compaction probe", {
        error: e instanceof Error ? e.message : String(e),
      });
      freeDiskBytes = 0;
    }
  }

  const decision = decideCompaction(
    { fileBytes, freeDiskBytes, now, lastCompactionAt: _lastCompactionAt },
    opts?.trigger,
  );

  if (!decision.compact && !opts?.force) {
    return { ran: false, decision };
  }

  // —— 排队重写：先 flush（把自己接到当前链尾），再把重写挂到链上 ——
  await flushPending(target);

  // 跨进程互斥：拿不到锁说明他进程正在压实，本次直接让路（不覆盖对方结果）
  const lock = tryAcquireCompactionLock(target, { now });
  if (!lock) {
    return { ran: false, decision, blockedBy: "other-process" };
  }

  let work: Promise<CompactionResult>;
  try {
    sweepStaleTempFiles(target, { now }); // 顺手清理崩溃残留（在锁保护下）
    const prev = flushChains.get(target) ?? Promise.resolve();
    // 语义：仅当**由本函数自行推导策略**时才施加低水位；调用方显式注入 policy 时尊重其语义
    // （除非另给了 reclaimToBytes）。
    const reclaimTo = opts?.reclaimToBytes ?? (opts?.policy ? undefined : decision.reclaimTargetBytes);
    work = prev.then(() => rewriteTraceFile(target, opts?.policy, opts?.now, reclaimTo));
    flushChains.set(target, work.then(() => undefined, () => undefined));
  } catch (e) {
    lock.release();
    throw e;
  }

  let result: CompactionResult;
  try {
    result = await work;
  } finally {
    lock.release();
  }

  _lastCompactionAt = opts?.now ?? Date.now();
  return { ran: true, decision, result };
}

// ============================================================================
// 跨进程压实锁 + 陈旧 .tmp 清理（补 A3b 的两处未解决项）
// ============================================================================

export interface CompactionLockHandle {
  path: string;
  token: string;
  release: () => void;
}

/**
 * 尝试获取**跨进程**压实锁（`${target}.lock`，`O_EXCL` 独占创建）。
 *
 * 为什么需要：此前的 single-flight 只覆盖**进程内**；两个进程同时压实同一 JSONL 时，
 * 会各自读到旧内容再各自重写，后写者覆盖先写者。
 *
 * 陈旧锁接管：持锁进程崩溃会留下锁文件。若 `now - startedAt > staleMs` 则视为陈旧并接管
 * （**否则该文件会被永久锁死、再也无法压实**）。锁内容不可读/格式坏同样按陈旧处理。
 *
 * 边界：接管存在极小的竞态窗口（两个进程可能同时判定陈旧）。这属于"崩溃恢复"与
 * "严格互斥"之间不可避免的取舍；正常路径（未崩溃）下互斥是严格的。
 */
export function tryAcquireCompactionLock(
  filePath: string,
  opts: { now?: number; staleMs?: number } = {},
): CompactionLockHandle | null {
  const now = opts.now ?? Date.now();
  const staleMs = opts.staleMs ?? 5 * 60 * 1000;
  const lockPath = `${filePath}.lock`;
  ensureDir(filePath);

  const tryCreate = (): CompactionLockHandle | null => {
    const token = `${process.pid}-${now}-${Math.random().toString(36).slice(2, 8)}`;
    try {
      const fd = fs.openSync(lockPath, "wx"); // O_EXCL：已存在即失败，不会覆盖
      fs.writeSync(fd, JSON.stringify({ token, pid: process.pid, startedAt: now }));
      fs.closeSync(fd);
      return {
        path: lockPath,
        token,
        release: () => {
          try {
            const cur = JSON.parse(fs.readFileSync(lockPath, "utf-8")) as { token?: string };
            if (cur?.token === token) fs.unlinkSync(lockPath); // 只释放自己的锁
          } catch { /* 已被接管或已删除 */ }
        },
      };
    } catch (e) {
      if ((e as { code?: string }).code === "EEXIST") return null;
      throw e;
    }
  };

  const first = tryCreate();
  if (first) return first;

  try {
    const info = JSON.parse(fs.readFileSync(lockPath, "utf-8")) as { startedAt?: number };
    const startedAt = typeof info?.startedAt === "number" ? info.startedAt : 0;
    if (now - startedAt > staleMs) {
      fs.unlinkSync(lockPath);
      return tryCreate();
    }
    return null;
  } catch {
    // 读不了/格式坏 → 按陈旧处理，避免永久锁死
    try { fs.unlinkSync(lockPath); } catch { /* ignore */ }
    return tryCreate();
  }
}

/**
 * 清理**陈旧**的 `.tmp` 残留（压实期间进程崩溃所留）。
 *
 * 判定依据是 **mtime**（文件真实年龄），而非文件名里的时间戳 ——
 * 文件名格式可能来自别的写入者，mtime 才是可靠依据。
 * **新鲜 `.tmp` 一律不动**：它可能属于另一次正在进行的写入，误删会丢数据。
 */
export function sweepStaleTempFiles(
  filePath: string,
  opts: { now?: number; staleMs?: number } = {},
): number {
  const now = opts.now ?? Date.now();
  const staleMs = opts.staleMs ?? 60 * 60 * 1000;
  const dir = path.dirname(filePath);
  const base = path.basename(filePath);
  if (!fs.existsSync(dir)) return 0;

  let removed = 0;
  for (const name of fs.readdirSync(dir)) {
    if (!name.startsWith(`${base}.`) || !name.endsWith(".tmp")) continue;
    const full = path.join(dir, name);
    try {
      const st = fs.statSync(full);
      if (now - st.mtimeMs > staleMs) {
        fs.unlinkSync(full);
        removed++;
      }
    } catch { /* 竞争删除等，忽略 */ }
  }
  return removed;
}

/**
 * 带**跨进程锁**的压实。返回 `null` 表示**未取得锁**（他进程正在压实），本次跳过。
 */
export async function compactRealUsageTracesLocked(
  filePath: string,
  policy?: RetentionPolicy,
  now?: number,
  opts?: { staleMs?: number; tempStaleMs?: number },
): Promise<CompactionResult | null> {
  const lock = tryAcquireCompactionLock(filePath, { now, staleMs: opts?.staleMs });
  if (!lock) return null;
  try {
    sweepStaleTempFiles(filePath, { now, staleMs: opts?.tempStaleMs });
    await flushPending(filePath);
    return await rewriteTraceFile(filePath, policy, now);
  } finally {
    lock.release();
  }
}
