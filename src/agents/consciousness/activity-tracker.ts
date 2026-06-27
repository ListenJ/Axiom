/**
 * ActivityTracker — Lightweight metrics of recent user/system activity.
 *
 * Tracks, in-memory only:
 *   - lastUserActivityAt: timestamp of last /chat, /agent-chat, or chat-stream
 *   - lastVaultWriteAt:   timestamp of last vault write (from VaultFileWatcher if available)
 *   - perIntentCounts:    counters over a sliding window
 *   - recentUserInputs:   capped ring buffer of the last 20 user messages (used for skill promotion)
 *
 * Why in-memory and not Blackboard? Volume and churn.
 * Pattern counters are written to Blackboard only when a reflection cycle runs
 * (via StateStore.bumpPattern). The hot path is just a counter bump.
 *
 * The singleton registers with the chat route via a setter; the route file
 * (src/routes/chat.ts) calls bumpUserActivity() in a single line edit.
 *
 * This module does NOT touch SQLite, the router, or any persistent store.
 * It exists to answer two questions cheaply:
 *   "How long has the user been idle?"          → getIdleMs()
 *   "What patterns are emerging from input?"    → snapshot()
 */

import { logger } from "../../utils/logger.js";

interface IntentHit {
  intent: string;
  agentName: string;
  input: string;
  at: number;
}

export class ActivityTracker {
  private lastUserActivityAt = 0;
  private lastVaultWriteAt = 0;
  private perIntentCounts = new Map<string, number>();  // key: `${intent}|${agentName}`
  private sampleInputs = new Map<string, string[]>();   // key: patternKey, value: first 3 inputs
  private recentInputs: string[] = [];                  // ring buffer, cap 20
  private recentIntents: string[] = [];                 // last 10 intents for topic-shift detection
  private conversationTurnCount = 0;                    // total turns in this session

  /** Called by chat route on each user message. */
  bumpUserActivity(input: string, intent: { intent: string; agentName: string }): void {
    this.lastUserActivityAt = Date.now();
    this.conversationTurnCount++;
    const key = `${intent.intent}|${intent.agentName}`;
    this.perIntentCounts.set(key, (this.perIntentCounts.get(key) ?? 0) + 1);

    // Track recent intents for topic-shift detection
    this.recentIntents.push(intent.intent);
    if (this.recentIntents.length > 10) this.recentIntents.shift();

    // Keep a small sample of inputs per pattern (max 3) for skill-promotion prompts.
    const sample = this.sampleInputs.get(key) ?? [];
    if (sample.length < 3 && input.length > 0 && input.length < 500) {
      sample.push(input);
      this.sampleInputs.set(key, sample);
    }

    this.recentInputs.push(input.slice(0, 200));
    if (this.recentInputs.length > 20) this.recentInputs.shift();

    logger.debug("[Consciousness/ActivityTracker] bump", { key, count: this.perIntentCounts.get(key) });
  }

  /**
   * Detect topic shift — returns true if the last 3 intents differ from the previous 3.
   * Used by getRoutingSignal() to signal drift to the UnifiedRouter.
   */
  detectTopicShift(): boolean {
    if (this.recentIntents.length < 6) return false;
    const recent = this.recentIntents.slice(-3);
    const previous = this.recentIntents.slice(-6, -3);
    const recentSet = new Set(recent);
    const previousSet = new Set(previous);
    // If no overlap between recent and previous intents, it's a shift
    for (const r of recentSet) {
      if (previousSet.has(r)) return false;
    }
    return true;
  }

  /** Get conversation turn count. */
  getTurnCount(): number {
    return this.conversationTurnCount;
  }

  /** Get the dominant intent in recent history. */
  getDominantIntent(): string | null {
    if (this.recentIntents.length === 0) return null;
    const counts = new Map<string, number>();
    for (const intent of this.recentIntents) {
      counts.set(intent, (counts.get(intent) ?? 0) + 1);
    }
    let maxCount = 0;
    let dominant: string | null = null;
    for (const [intent, count] of counts) {
      if (count > maxCount) {
        maxCount = count;
        dominant = intent;
      }
    }
    return dominant;
  }

  /** Called by VaultFileWatcher (or the VaultManager.write* methods) when a note is written. */
  bumpVaultWrite(): void {
    this.lastVaultWriteAt = Date.now();
  }

  /** Idle time in ms. Returns Infinity if no activity yet. */
  getIdleMs(): number {
    if (this.lastUserActivityAt === 0) return Number.POSITIVE_INFINITY;
    return Date.now() - this.lastUserActivityAt;
  }

  /** Snapshot the current pattern counts + samples. */
  snapshot(): Array<{
    key: string;
    intent: string;
    agentName: string;
    count: number;
    sampleInputs: string[];
  }> {
    const out: Array<{ key: string; intent: string; agentName: string; count: number; sampleInputs: string[] }> = [];
    for (const [key, count] of this.perIntentCounts) {
      const [intent, agentName] = key.split("|");
      out.push({ key, intent, agentName, count, sampleInputs: this.sampleInputs.get(key) ?? [] });
    }
    return out.sort((a, b) => b.count - a.count);
  }

  /** Recent user inputs (most recent last). */
  recent(): string[] {
    return [...this.recentInputs];
  }

  /** Reset hot counters (keep lastUserActivityAt). Called after a reflection pass. */
  resetCounters(): void {
    this.perIntentCounts.clear();
    this.sampleInputs.clear();
    this.recentInputs = [];
    logger.debug("[Consciousness/ActivityTracker] counters reset");
  }

  /** Stats for /consciousness/status endpoint. */
  stats(): {
    lastUserActivityAt: number;
    lastVaultWriteAt: number;
    idleMs: number;
    uniquePatterns: number;
    recentInputCount: number;
  } {
    return {
      lastUserActivityAt: this.lastUserActivityAt,
      lastVaultWriteAt: this.lastVaultWriteAt,
      idleMs: this.getIdleMs(),
      uniquePatterns: this.perIntentCounts.size,
      recentInputCount: this.recentInputs.length,
    };
  }
}

let _instance: ActivityTracker | null = null;
export function getActivityTracker(): ActivityTracker {
  if (!_instance) _instance = new ActivityTracker();
  return _instance;
}

/** Test seam: reset singleton and all counters. */
export function resetActivityTrackerForTest(): void {
  _instance = null;
}
