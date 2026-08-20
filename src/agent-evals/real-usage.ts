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

export const REAL_USAGE_PATH = process.env.REAL_USAGE_PATH ?? path.join(process.cwd(), "data", "real-usage-traces.jsonl");

function resolvePath(p?: string): string {
  return p ?? process.env.REAL_USAGE_PATH ?? REAL_USAGE_PATH;
}

function ensureDir(filePath: string): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

/**
 * 采集一条真实使用轨迹（原子追加）
 */
export async function captureRealUsageTrace(trace: RealUsageTrace, filePath?: string): Promise<void> {
  const target = resolvePath(filePath);
  ensureDir(target);
  const enriched: RealUsageTrace = {
    ...trace,
    timestamp: trace.timestamp ?? Date.now(),
    source: trace.source ?? "chat",
  };
  const line = JSON.stringify(enriched) + "\n";
  // 原子追加，同步以避免并发交错（小 payload <1KB，同步开销可接受）
  fs.appendFileSync(target, line, "utf8");
  logger.info("[RealUsage] captured", { id: enriched.id, success: enriched.success });
}

/**
 * 加载全部真实轨迹
 */
export async function loadRealUsageTraces(filePath?: string): Promise<RealUsageTrace[]> {
  const target = resolvePath(filePath);
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
  if (fs.existsSync(target)) fs.writeFileSync(target, "", "utf8");
}

/**
 * 从真实轨迹进化（归纳→晋升 skill）
 * 复用 `createDefaultSelfEvolve` 的 selfInduce + promoteInductionsToSkills 链路
 */
export async function evolveFromRealUsage(filePath?: string): Promise<{ traceCount: number; inductionCount: number; created: string[] }> {
  const traces = await loadRealUsageTraces(filePath);
  if (traces.length === 0) {
    logger.info("[RealUsage] no traces to evolve");
    return { traceCount: 0, inductionCount: 0, created: [] };
  }
  // 动态导入避免 cycle
  const { createDefaultSelfEvolve } = await import("../self-evolve/index.js");
  const { promoteInductionsToSkills } = await import("../self-evolve/skill-promotion.js");
  const engine = createDefaultSelfEvolve();
  const inductions = engine.selfInduce(traces as TaskTrace[], Math.min(10, traces.length));
  const created = promoteInductionsToSkills(inductions);
  logger.info("[RealUsage] evolved", { traceCount: traces.length, inductionCount: inductions.length, created: created.length });
  return { traceCount: traces.length, inductionCount: inductions.length, created };
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
    console.log(JSON.stringify(result, null, 2));
  } else {
    const traces = await loadRealUsageTraces(pathArg);
    console.log(`Real usage traces: ${traces.length}`);
    for (const t of traces.slice(-10)) console.log(`- [${t.success ? "OK" : "FAIL"}] ${t.id}: ${t.task.slice(0, 60)}`);
  }
}
