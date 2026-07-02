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

    eventBus.publish({
      type: "state.changed",
      source: "world-state",
      data: { path, value, oldValue, version: this.version },
      priority: "normal",
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
    this.set("mental.intent", { intent, confidence, timestamp: Date.now() });
  }

  getIntent(): MentalIntent | undefined {
    return this.get("mental.intent");
  }

  setGoal(goalId: string, description: string, status: MentalGoal["status"]): void {
    const goals = this.get<Record<string, MentalGoal>>("mental.goals") ?? {};
    goals[goalId] = { description, status, timestamp: Date.now() };
    this.set("mental.goals", goals);
  }

  getGoals(): Record<string, MentalGoal> {
    return this.get("mental.goals") ?? {};
  }

  setBelief(beliefId: string, statement: string, confidence: number): void {
    const beliefs = this.get<Record<string, MentalBelief>>("mental.beliefs") ?? {};
    beliefs[beliefId] = { statement, confidence, timestamp: Date.now() };
    this.set("mental.beliefs", beliefs);
  }

  getBeliefs(): Record<string, MentalBelief> {
    return this.get("mental.beliefs") ?? {};
  }

  setHypothesis(id: string, statement: string, status: MentalHypothesis["status"]): void {
    const hyps = this.get<Record<string, MentalHypothesis>>("mental.hypotheses") ?? {};
    hyps[id] = { statement, status, timestamp: Date.now() };
    this.set("mental.hypotheses", hyps);
  }

  getHypotheses(): Record<string, MentalHypothesis> {
    return this.get("mental.hypotheses") ?? {};
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
