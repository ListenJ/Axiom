/**
 * Trigger — Decides whether a reflection cycle should run *now*.
 *
 * Four trigger sources, all converging into one decision:
 *   1. idle      — user has been quiet for TriggerConfig.idleThresholdMs
 *   2. schedule  — Bun.cron tick (passed in as cron: string)
 *   3. token-budget — cumulative reflection tokens exceed TriggerConfig.tokenBudget
 *   4. manual    — explicit API call, returns true unconditionally
 *
 * `evaluate()` is pure: it inspects the StateStore + ActivityTracker and
 * returns the trigger that fired (or null). The ReflectionLoop then
 * dispatches on the trigger.kind.
 *
 * `isWithinQuietHours(startHour, endHour)` is exposed to suppress reflection
 * between configured hours (e.g. 23:00-07:00 local time) so the agent does
 * not interrupt user focus periods.
 */

import type { TriggerConfig } from "./types.js";
import { getActivityTracker } from "./activity-tracker.js";
import { getStateStore } from "./state-store.js";

export function evaluate(config: TriggerConfig, now: number = Date.now()): {
  fired: import("./types.js").ReflectionTrigger;
  withinQuietHours: boolean;
} | null {
  if (!config.enabled) return null;

  const activity = getActivityTracker();
  const state = getStateStore().read();
  const idleMs = activity.getIdleMs();

  // Token-budget trigger — cheap to check.
  if (state.tokensSpentThisSession >= config.tokenBudget) {
    return { fired: { kind: "token-budget", tokensUsed: state.tokensSpentThisSession, budget: config.tokenBudget }, withinQuietHours: false };
  }

  // Idle trigger — only if we've actually seen a user.
  if (Number.isFinite(idleMs) && idleMs >= config.idleThresholdMs) {
    return { fired: { kind: "idle", idleMs }, withinQuietHours: false };
  }

  return null;
}

/**
 * Schedule tick: caller (Bun.cron handler) invokes this with the cron string
 * to fire a scheduled reflection regardless of idle state.
 */
export function buildScheduleTrigger(cron: string): import("./types.js").ReflectionTrigger {
  return { kind: "schedule", cron };
}

/**
 * Manual trigger: caller (HTTP /consciousness/reflect handler) invokes this
 * with an optional reason string.
 */
export function buildManualTrigger(reason?: string): import("./types.js").ReflectionTrigger {
  return { kind: "manual", reason };
}

/**
 * Quiet-hours check. startHour and endHour are 0-23 local time.
 * Supports windows that wrap midnight (e.g. startHour=23, endHour=7).
 */
export function isWithinQuietHours(
  startHour: number,
  endHour: number,
  now: Date = new Date()
): boolean {
  const h = now.getHours();
  if (startHour === endHour) return false;
  if (startHour < endHour) return h >= startHour && h < endHour;
  // Wrap-around (e.g. 23 → 7)
  return h >= startHour || h < endHour;
}
