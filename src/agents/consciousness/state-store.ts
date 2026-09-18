/**
 * StateStore — Blackboard-backed self-state persistence.
 *
 * The consciousness module persists its own state (mood, focus, counters)
 * into the existing SharedBlackboard instead of inventing a new store.
 * This makes the state observable to other agents via the same projection
 * API (blackboard.read, queryByTag, etc.).
 *
 * Convention:
 *   key  = "consciousness:self_state"
 *   tags = ["consciousness", "self"]
 *   confidence is 1.0 (self-authored, no semantic ambiguity)
 *   sourceId  = "consciousness"
 */

import { getGlobalBlackboard, type BlackboardEntry } from "../../memory/blackboard.js";
import { logger } from "../../utils/logger.js";
import { EMPTY_SELF_STATE, type SelfState } from "./types.js";

const SELF_STATE_KEY = "consciousness:self_state";
const SOURCE_ID = "consciousness";
const SELF_STATE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days — refresh on every write

export class StateStore {
  private bb = getGlobalBlackboard();

  /** Read the current self-state, or return EMPTY_SELF_STATE if absent. */
  read(): SelfState {
    const result = this.bb.read(SELF_STATE_KEY, { minConfidence: 0.5 });
    if (!result.hit || !result.entry) return { ...EMPTY_SELF_STATE };
    const value = result.entry.value;
    if (typeof value !== "object" || value === null) return { ...EMPTY_SELF_STATE };
    // Shallow merge so missing fields default.
    return { ...EMPTY_SELF_STATE, ...(value as Partial<SelfState>) };
  }

  /** Persist a new self-state, refreshing TTL. */
  write(state: SelfState): BlackboardEntry {
    return this.bb.write(SELF_STATE_KEY, state, SOURCE_ID, {
      confidence: 1.0,
      status: "verified",
      expireMs: SELF_STATE_TTL_MS,
      tags: ["consciousness", "self"],
    });
  }

  /** Merge a partial update (e.g. just bump a counter). */
  patch(partial: Partial<SelfState>): SelfState {
    const current = this.read();
    const next: SelfState = { ...current, ...partial };
    this.write(next);
    return next;
  }

  /** Increment a pattern counter; auto-evict cold keys beyond 200 entries. */
  bumpPattern(key: string, by = 1): SelfState {
    const s = this.read();
    const counts = { ...s.patternCounts };
    counts[key] = (counts[key] ?? 0) + by;
    // Simple LRU-ish: keep the 200 most-frequent keys.
    if (Object.keys(counts).length > 200) {
      const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 200);
      const trimmed: Record<string, number> = Object.fromEntries(sorted);
      return this.patch({ patternCounts: trimmed });
    }
    return this.patch({ patternCounts: counts });
  }

  /** Reset per-session counters (call at reflection start). */
  resetSessionCounters(): SelfState {
    return this.patch({
      tokensSpentThisSession: 0,
      recentInsights: [],
    });
  }

  /** Quick health check. */
  stats(): { exists: boolean; lastUpdated: number | null; version: number | null } {
    const result = this.bb.read(SELF_STATE_KEY);
    if (!result.entry) return { exists: false, lastUpdated: null, version: null };
    return {
      exists: true,
      lastUpdated: result.entry.updatedAt,
      version: result.entry.version,
    };
  }

  /** Clear (used by tests). */
  clear(): void {
    this.bb.delete(SELF_STATE_KEY);
    logger.debug("[Consciousness/StateStore] cleared self-state");
  }
}

let _instance: StateStore | null = null;
export function getStateStore(): StateStore {
  if (!_instance) _instance = new StateStore();
  return _instance;
}
