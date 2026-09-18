/**
 * 自动 evolve 触发器 — 闭合 self-evolve 回路的学习侧。
 *
 * 定位：既有采集侧（captureRealUsageTrace 已接线 chat 三处 → data/real-usage-traces.jsonl）是
 * 自动的，但学习侧（evolveFromRealUsage → selfInduce → promoteInductionsToSkills）仅 CLI 手动触发。
 * 本模块提供 `maybeAutoEvolve`：每次 chat 交换后 fire-and-forget 一次廉价检查，当
 * "距上次运行 ≥ 冷却" 且 "新增轨迹 ≥ 阈值" 时自动执行既有 evolve 链路（复用，不改其内部行为）。
 *
 * 默认 OFF（用户确认）：`AXIOM_SELF_EVOLVE_AUTO=1` 才激活；未显式开启时不做任何读/写。
 * 并发安全：模块级 `running` 布尔在首个 await 前置位，阻止同进程重入。
 * 可降级（W3）：state 缺失/损坏降级全 0；evolve 抛错吞掉并推进 state（防下一轮 turn 热重试同一失败）。
 * 状态文件：`data/auto-evolve-state.json`（data/*.json 已 gitignore，不入库）。
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { logger } from "../utils/logger.js";
import { readBool, readInt, readString } from "../utils/env.js";
import { loadRealUsageTraces, evolveFromRealUsage } from "./real-usage.js";

export type AutoEvolveResult = {
  ran: boolean;
  reason: "disabled" | "busy" | "cooldown" | "insufficient-new" | "ok" | "error";
  result?: Awaited<ReturnType<typeof evolveFromRealUsage>>;
};

export interface AutoEvolveDeps {
  now?: () => number;                   // 时钟（默认 Date.now），便于冷却测试
  enabled?: () => boolean;              // 总开关（默认 AXIOM_SELF_EVOLVE_AUTO，默认 false）
  minNewTraces?: () => number;          // 新增轨迹阈值（默认 AXIOM_SELF_EVOLVE_MIN_NEW_TRACES=30, clamp min 1）
  cooldownMs?: () => number;            // 冷却窗口（默认 AXIOM_SELF_EVOLVE_COOLDOWN_MS=30min, clamp min 1s）
  statePath?: () => string;             // 状态文件（默认 data/auto-evolve-state.json）
  getNewTraces?: () => Promise<number>; // 当前轨迹总数（默认 loadRealUsageTraces，先 flush 保证一致）
  evolve?: typeof evolveFromRealUsage;  // 进化执行体（默认 evolveFromRealUsage）
}

interface AutoEvolveState {
  lastRunAt: number;
  lastNewTraces: number;
}

/** 模块级并发门闩：单进程内防止重入（跨进程由冷却 + state 双保险，本地单进程不引入分布式锁）。 */
let running = false;

const EMPTY_STATE: AutoEvolveState = { lastRunAt: 0, lastNewTraces: 0 };

function resolveDeps(deps?: AutoEvolveDeps): Required<AutoEvolveDeps> {
  return {
    now: deps?.now ?? Date.now,
    enabled: deps?.enabled ?? (() => readBool("AXIOM_SELF_EVOLVE_AUTO", false)),
    minNewTraces: deps?.minNewTraces ?? (() => readInt("AXIOM_SELF_EVOLVE_MIN_NEW_TRACES", 30, { min: 1 })),
    cooldownMs: deps?.cooldownMs ?? (() => readInt("AXIOM_SELF_EVOLVE_COOLDOWN_MS", 30 * 60_000, { min: 1_000 })),
    statePath: deps?.statePath ?? (() => path.join(process.cwd(), "data", "auto-evolve-state.json")),
    getNewTraces: deps?.getNewTraces ?? (() => loadRealUsageTraces().then((t) => t.length)),
    evolve: deps?.evolve ?? evolveFromRealUsage,
  };
}

/** 读状态：缺失/损坏降级全 0（W3），不抛。 */
function readState(filePath: string): AutoEvolveState {
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw) as Partial<AutoEvolveState>;
    if (typeof parsed.lastRunAt !== "number" || typeof parsed.lastNewTraces !== "number") return EMPTY_STATE;
    return { lastRunAt: parsed.lastRunAt, lastNewTraces: parsed.lastNewTraces };
  } catch {
    return EMPTY_STATE;
  }
}

/** 原子写（tmp + renameSync，镜像 skill-quality.ts）：失败清理临时文件后原样抛出，由调用方容错。 */
function writeState(filePath: string, state: AutoEvolveState): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(state, null, 2), "utf-8");
    fs.renameSync(tmpPath, filePath);
  } catch (e) {
    try { fs.unlinkSync(tmpPath); } catch {}
    throw e;
  }
}

/**
 * 安全写 state：吞掉写入异常仅记日志。fire-and-forget 触发器的主职责是"evolve 是否跑"，
 * state 持久化失败不应把错误抛给 chat 交换主流程（W3 可降级：本次不持久化，下次轮照常判定）。
 */
function safeWriteState(filePath: string, state: AutoEvolveState): void {
  try {
    writeState(filePath, state);
  } catch (e) {
    logger.warn("[auto-evolve] state write failed (degraded: skip persist)", {
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

/**
 * 自动 evolve 检查（每次 chat 交换后 fire-and-forget 调用）。
 * 廉价检查先行：默认 OFF 时不读任何文件；冷却窗口内只付一次小 JSON 读，
 * 不做 expensive 的全量轨迹读。通过全部闸门才执行 evolve。
 */
export async function maybeAutoEvolve(deps?: AutoEvolveDeps): Promise<AutoEvolveResult> {
  const d = resolveDeps(deps);
  if (!d.enabled()) return { ran: false, reason: "disabled" };
  if (running) return { ran: false, reason: "busy" };
  running = true;
  try {
    const state = readState(d.statePath());
    const now = d.now();
    // 冷却短路：窗口内不做昂贵全量读
    if (now - state.lastRunAt < d.cooldownMs()) {
      return { ran: false, reason: "cooldown" };
    }
    const newTraces = await d.getNewTraces();
    // 水位回退（轨迹文件被清空/归档，newTraces < lastNewTraces）：以当前数为新水位并持久化。
    // 否则 lastNewTraces 停在旧高水位，增量恒为负，自动 evolve 会长期卡 insufficient-new。
    if (newTraces < state.lastNewTraces) {
      safeWriteState(d.statePath(), { lastRunAt: state.lastRunAt, lastNewTraces: newTraces });
      state.lastNewTraces = newTraces;
    }
    const pending = newTraces - state.lastNewTraces;
    if (pending < d.minNewTraces()) {
      return { ran: false, reason: "insufficient-new" };
    }
    try {
      const result = await d.evolve();
      safeWriteState(d.statePath(), { lastRunAt: d.now(), lastNewTraces: newTraces });
      return { ran: true, reason: "ok", result };
    } catch (err) {
      // evolve 失败不阻断 chat 响应；仍推进 state 防下一轮 turn 热重试同一失败
      logger.warn("[auto-evolve] evolve failed; state advanced to avoid hot-retry", {
        error: err instanceof Error ? err.message : String(err),
      });
      safeWriteState(d.statePath(), { lastRunAt: d.now(), lastNewTraces: newTraces });
      return { ran: false, reason: "error" };
    }
  } finally {
    running = false;
  }
}