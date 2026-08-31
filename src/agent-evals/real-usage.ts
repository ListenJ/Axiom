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
import { readString } from "../utils/env.js";
import type { TaskTrace } from "../self-evolve/types.js";

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

/**
 * 清空轨迹（测试/维护用）
 */
export async function clearRealUsageTraces(filePath?: string): Promise<void> {
  const target = resolvePath(filePath);
  // 清理挂起批次避免脏写
  pendingWrites.delete(target);
  const t = flushTimers.get(target);
  if (t) {
    clearTimeout(t);
    flushTimers.delete(target);
  }
  // 等待进行中的串行写链排空再清空文件，避免清空后链段又把旧批次写回（测试合规性）
  await flushChains.get(target)?.catch(() => {});
  flushChains.delete(target);
  if (fs.existsSync(target)) fs.writeFileSync(target, "", "utf8");
}

/**
 * 从真实轨迹进化（归纳→晋升 skill）
 * 优化：大文件增量采样（近 N 条 + 按 task 去重），避免 10k+ 历史膨胀导致归纳噪声与延迟
 * 复用 `createDefaultSelfEvolve` 的 selfInduce + promoteInductionsToSkills 链路
 */
export async function evolveFromRealUsage(
  filePath?: string,
  opts?: { maxTraces?: number; dedupByTask?: boolean }
): Promise<{ traceCount: number; inductionCount: number; created: string[]; sampled: number }> {
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
  const created = promoteInductionsToSkills(inductions);
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
