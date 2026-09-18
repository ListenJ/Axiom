/**
 * WorldState — 统一状态树 (from cognitive-runtime kernel)
 *
 * 系统的唯一真相源。所有模块从此读写, 其它存储 (Vault/KG/SQLite) 均为投影。
 *
 * 特性:
 * - 键值对状态存储, 版本追踪
 * - watch() 订阅路径变更
 * - 认知维度: intent / goals / beliefs / hypotheses
 * - query() 前缀查询
 * - snapshot() 序列化
 */

import { logger } from "../../utils/logger.js";
import { eventBus, type RuntimeEvent } from "./event-bus.js";

// ─── Types ─────────────────────────────────────────────────────────────────

export interface MentalIntent {
  intent: string;
  confidence: number;
  timestamp: number;
}

export interface MentalGoal {
  description: string;
  status: "active" | "completed" | "abandoned";
  timestamp: number;
}

export interface MentalBelief {
  statement: string;
  confidence: number;
  timestamp: number;
  /**
   * 第几次写入（从 1 开始）。
   * 审计修复：此前同一 beliefId 再次写入会**静默覆盖**，下游无法区分
   * "这个信念一直很稳" 与 "它刚刚被翻转过"。revision 让"变过没有"可观测。
   */
  revision?: number;
}

/** 信念变更记录（追加式，有界） */
export interface BeliefTransition {
  beliefId: string;
  from?: { statement: string; confidence: number };
  to: { statement: string; confidence: number };
  at: number;
  revision: number;
}

/** 信念变更历史上限（防止无界增长） */
export const BELIEF_HISTORY_MAX = 500;

/** confidence 合法区间由调用方约定为 [0,1]；越界不静默接受 */
function assertConfidence(confidence: number, where: string): number {
  if (typeof confidence !== "number" || !Number.isFinite(confidence)) {
    throw new Error(`[WorldState] ${where}: confidence 必须是有限数值，收到 ${String(confidence)}`);
  }
  if (confidence < 0 || confidence > 1) {
    throw new Error(`[WorldState] ${where}: confidence 必须落在 [0,1]，收到 ${confidence}`);
  }
  return confidence;
}

/** ID / 文本非空校验（空 key 会让"按 id 取回"彻底失去意义） */
function assertNonEmpty(value: string, where: string, field: string): string {
  const v = typeof value === "string" ? value.trim() : "";
  if (!v) throw new Error(`[WorldState] ${where}: ${field} 不能为空`);
  return v;
}

export interface MentalHypothesis {
  statement: string;
  status: "proposed" | "testing" | "confirmed" | "rejected";
  timestamp: number;
}

// ─── WorldState ────────────────────────────────────────────────────────────

class WorldStateImpl {
  private state = new Map<string, unknown>();
  private version = 0;
  private listeners = new Map<string, Array<(value: unknown, oldValue: unknown) => void>>();

  get<T = unknown>(path: string): T | undefined {
    return this.state.get(path) as T | undefined;
  }

  set<T = unknown>(path: string, value: T): void {
    const oldValue = this.state.get(path);
    this.state.set(path, value);
    this.version++;

    for (const listener of this.listeners.get(path) ?? []) {
      try { listener(value, oldValue); } catch (err) {
        logger.error(`[WorldState] Listener failed for ${path}`, err instanceof Error ? err : new Error(String(err)));
      }
    }

    // L6：publish 返回的 Promise 吸收兜底，避免未来监听器路径产生未处理 rejection
    void eventBus.publish({
      type: "state.changed",
      source: "world-state",
      data: { path, value, oldValue, version: this.version },
      priority: "normal",
    }).catch((err) => {
      logger.error("[WorldState] state.changed publish failed", err instanceof Error ? err : new Error(String(err)));
    });
  }

  update<T = unknown>(path: string, updater: (current: T | undefined) => T): void {
    this.set(path, updater(this.get<T>(path)));
  }

  watch(path: string, listener: (value: unknown, oldValue: unknown) => void): () => void {
    this.listeners.has(path) || this.listeners.set(path, []);
    this.listeners.get(path)!.push(listener);
    return () => {
      const listeners = this.listeners.get(path);
      if (listeners) {
        const idx = listeners.indexOf(listener);
        if (idx !== -1) listeners.splice(idx, 1);
      }
    };
  }

  query(prefix: string): Map<string, unknown> {
    const result = new Map<string, unknown>();
    for (const [key, value] of this.state) {
      if (key.startsWith(prefix)) result.set(key, value);
    }
    return result;
  }

  // ── 认知维度 ──

  setIntent(intent: string, confidence: number): void {
    this.set("mental.intent", {
      intent: assertNonEmpty(intent, "setIntent", "intent"),
      confidence: assertConfidence(confidence, "setIntent"),
      timestamp: Date.now(),
    });
  }

  getIntent(): MentalIntent | undefined {
    return this.get("mental.intent");
  }

  setGoal(goalId: string, description: string, status: MentalGoal["status"]): void {
    const id = assertNonEmpty(goalId, "setGoal", "goalId");
    if (!["active", "completed", "abandoned"].includes(status)) {
      throw new Error(`[WorldState] setGoal: 非法 status "${String(status)}"`);
    }
    const goals = { ...(this.get<Record<string, MentalGoal>>("mental.goals") ?? {}) };
    goals[id] = {
      description: assertNonEmpty(description, "setGoal", "description"),
      status,
      timestamp: Date.now(),
    };
    this.set("mental.goals", goals);
  }

  getGoals(): Record<string, MentalGoal> {
    return { ...this.get("mental.goals") ?? {} };
  }

  /**
   * 写入/更新一条信念。
   *
   * 审计修复（WorldState 一致性）：
   *   1. **不再静默覆盖**：同一 beliefId 再次写入会递增 `revision`，并把一次
   *      `BeliefTransition`（from → to）追加到有界的 `mental.beliefHistory`。
   *      此前下游无法区分"这个信念一直很稳"与"它刚被翻转过" —— 而一个会悄悄翻转的
   *      外部状态比没有外部状态更危险，因为下游会无条件信任它。
   *   2. **入参校验**：id/statement 非空、confidence 必须是 [0,1] 内的有限数。
   *      此前 NaN / 越界值会被照单全收，读出来就是"错误的确定性"。
   */
  setBelief(beliefId: string, statement: string, confidence: number): void {
    const id = assertNonEmpty(beliefId, "setBelief", "beliefId");
    const text = assertNonEmpty(statement, "setBelief", "statement");
    const conf = assertConfidence(confidence, "setBelief");

    const beliefs = { ...(this.get<Record<string, MentalBelief>>("mental.beliefs") ?? {}) };
    const prev = beliefs[id];
    const revision = (prev?.revision ?? 0) + 1;

    beliefs[id] = { statement: text, confidence: conf, timestamp: Date.now(), revision };
    this.set("mental.beliefs", beliefs);

    // 仅当确有变化时记一条 transition，避免重复写入刷爆历史
    if (!prev || prev.statement !== text || prev.confidence !== conf) {
      const history = [...(this.get<BeliefTransition[]>("mental.beliefHistory") ?? [])];
      history.push({
        beliefId: id,
        from: prev ? { statement: prev.statement, confidence: prev.confidence } : undefined,
        to: { statement: text, confidence: conf },
        at: Date.now(),
        revision,
      });
      // 有界：只保留最近 N 条
      this.set(
        "mental.beliefHistory",
        history.length > BELIEF_HISTORY_MAX ? history.slice(-BELIEF_HISTORY_MAX) : history,
      );
    }
  }

  getBeliefs(): Record<string, MentalBelief> {
    return { ...(this.get("mental.beliefs") ?? {}) };
  }

  /**
   * **稳定排序**的信念列表 —— 供"挑最可信信念"这类决策使用。
   *
   * 审计修复：此前消费方直接遍历 `getBeliefs()` 的对象，顺序取决于插入顺序，
   * 信念被更新后顺序会变，导致**同一份状态两次读取可能给出不同结论**（无稳定 tie-breaker）。
   * 现按 confidence 降序、其次 beliefId 升序 —— 完全确定，与插入顺序无关。
   */
  getBeliefsSorted(): Array<{ beliefId: string } & MentalBelief> {
    const beliefs = this.getBeliefs();
    return Object.entries(beliefs)
      .map(([beliefId, b]) => ({ beliefId, ...b }))
      .sort((a, b) => b.confidence - a.confidence || a.beliefId.localeCompare(b.beliefId));
  }

  /** 某条信念的变更历史（最近在后），用于判断它是否稳定 */
  getBeliefHistory(beliefId?: string): BeliefTransition[] {
    const all = this.get<BeliefTransition[]>("mental.beliefHistory") ?? [];
    return beliefId ? all.filter((t) => t.beliefId === beliefId) : [...all];
  }

  setHypothesis(id: string, statement: string, status: MentalHypothesis["status"]): void {
    const hid = assertNonEmpty(id, "setHypothesis", "id");
    if (!["proposed", "testing", "confirmed", "rejected"].includes(status)) {
      throw new Error(`[WorldState] setHypothesis: 非法 status "${String(status)}"`);
    }
    const hyps = { ...(this.get<Record<string, MentalHypothesis>>("mental.hypotheses") ?? {}) };
    hyps[hid] = {
      statement: assertNonEmpty(statement, "setHypothesis", "statement"),
      status,
      timestamp: Date.now(),
    };
    this.set("mental.hypotheses", hyps);
  }

  getHypotheses(): Record<string, MentalHypothesis> {
    return { ...this.get("mental.hypotheses") ?? {} };
  }

  getVersion(): number {
    return this.version;
  }

  snapshot(): Record<string, unknown> {
    const obj: Record<string, unknown> = {};
    for (const [key, value] of this.state) obj[key] = value;
    return obj;
  }
}

export const worldState = new WorldStateImpl();
