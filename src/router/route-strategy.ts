/**
 * Route Strategy — Consciousness-aware routing strategy engine.
 *
 * The strategy engine sits between the context scorer and the model router.
 * It takes the scored candidates and applies higher-level strategies:
 *
 * 1. Circuit-breaker strategy: avoid models that recently failed
 * 2. Load-balancing strategy: distribute across providers
 * 3. Cost-optimization strategy: prefer cheaper models for simple tasks
 * 4. Drift-recovery strategy: when topic changes, suggest model switch
 * 5. Fatigue-mitigation strategy: when context is long, use larger models
 */

import { logger } from "../utils/logger.js";
import type { TaskRole } from "./model-capability-registry.js";
import type { ModelScore, RoutingContext, RoutingSignal } from "./context-scorer.js";

// ─── Strategy Result ───────────────────────────────────────────────────────

export interface StrategyResult {
  /** Selected role */
  role: TaskRole;
  /** Strategy that made the decision */
  strategy: string;
  /** Confidence in the decision (0-1) */
  confidence: number;
  /** Human-readable reason */
  reason: string;
  /** Whether to force a model switch (even if same role) */
  forceSwitch: boolean;
  /** Suggested thinking intensity */
  thinkingIntensity: "none" | "low" | "medium" | "high";
}

// ─── Circuit Breaker Strategy ──────────────────────────────────────────────

interface CircuitState {
  failures: number;
  lastFailure: number;
  isOpen: boolean;
}

const circuits = new Map<string, CircuitState>();
const CIRCUIT_COOLDOWN_MS = 60_000; // 1 minute
const CIRCUIT_THRESHOLD = 3;

function isCircuitOpen(model: string): boolean {
  const state = circuits.get(model);
  if (!state) return false;

  if (state.isOpen && Date.now() - state.lastFailure > CIRCUIT_COOLDOWN_MS) {
    // Half-open: allow one attempt
    state.isOpen = false;
    state.failures = 0;
    return false;
  }

  return state.isOpen;
}

function recordCircuitFailure(model: string): void {
  const state = circuits.get(model) ?? { failures: 0, lastFailure: 0, isOpen: false };
  state.failures++;
  state.lastFailure = Date.now();
  if (state.failures >= CIRCUIT_THRESHOLD) {
    state.isOpen = true;
    logger.warn("[RouteStrategy] Circuit breaker opened", { model, failures: state.failures });
  }
  circuits.set(model, state);
}

function recordCircuitSuccess(model: string): void {
  const state = circuits.get(model);
  if (state) {
    state.failures = 0;
    state.isOpen = false;
  }
}

// ─── Strategy: Circuit Breaker ─────────────────────────────────────────────

function applyCircuitBreaker(
  scores: ModelScore[],
  _context: RoutingContext,
): { filtered: ModelScore[]; applied: boolean } {
  const filtered = scores.filter((s) => !isCircuitOpen(s.model));
  const removed = scores.length - filtered.length;

  if (removed > 0) {
    logger.info("[RouteStrategy] Circuit breaker filtered models", {
      removed,
      remaining: filtered.length,
    });
  }

  return { filtered: filtered.length > 0 ? filtered : scores, applied: removed > 0 };
}

// ─── Strategy: Fatigue Mitigation ──────────────────────────────────────────

function applyFatigueMitigation(
  scores: ModelScore[],
  context: RoutingContext,
): { thinkingIntensity: StrategyResult["thinkingIntensity"]; applied: boolean } {
  const tokens = context.cumulativeContextTokens;

  // Long context: increase thinking intensity
  if (tokens > 16000) {
    return { thinkingIntensity: "high", applied: true };
  }
  if (tokens > 8000) {
    return { thinkingIntensity: "medium", applied: true };
  }
  if (tokens > 4000) {
    return { thinkingIntensity: "low", applied: true };
  }

  return { thinkingIntensity: "none", applied: false };
}

// ─── Strategy: Drift Recovery ──────────────────────────────────────────────

function applyDriftRecovery(
  scores: ModelScore[],
  context: RoutingContext,
  signal?: RoutingSignal,
): { role: TaskRole | null; applied: boolean } {
  if (!signal?.patternDrift) return { role: null, applied: false };

  // When user switches topics, prefer the role that best matches the new topic
  // rather than continuing with the previous role
  const topScore = scores[0];
  if (!topScore) return { role: null, applied: false };

  // If the top score's role was heavily used in the previous topic,
  // check if there's a better match
  const previousRoles = context.recentMessages
    .filter((m) => m.role === "assistant")
    .length;

  if (previousRoles > 3) {
    // User has been in a conversation — drift detected
    logger.info("[RouteStrategy] Drift detected, may switch role", {
      currentTopRole: topScore.role,
      previousMessages: previousRoles,
    });
    return { role: topScore.role, applied: true };
  }

  return { role: null, applied: false };
}

// ─── Strategy: Cost Optimization ───────────────────────────────────────────

function applyCostOptimization(
  scores: ModelScore[],
  context: RoutingContext,
): { adjusted: ModelScore[]; applied: boolean } {
  // For simple tasks at night, boost cheaper model scores
  if (context.taskComplexity !== "simple") return { adjusted: scores, applied: false };
  if (context.timeOfDay !== "night" && context.timeOfDay !== "evening") {
    return { adjusted: scores, applied: false };
  }

  // Boost general-chat and general-tool roles (cheaper)
  const adjusted = scores.map((s) => {
    if (s.role === "general-chat" || s.role === "general-tool") {
      return {
        ...s,
        totalScore: s.totalScore + 15,
        breakdown: { ...s.breakdown, timePreference: s.breakdown.timePreference + 15 },
      };
    }
    return s;
  });

  adjusted.sort((a, b) => b.totalScore - a.totalScore);
  return { adjusted, applied: true };
}

// ─── Main Strategy Engine ──────────────────────────────────────────────────

/**
 * Apply all routing strategies and select the best model.
 *
 * This is the main entry point for the strategy engine.
 * Called by UnifiedRouter after scoring.
 */
export function applyStrategies(
  scores: ModelScore[],
  context: RoutingContext,
  signal?: RoutingSignal,
): StrategyResult {
  if (scores.length === 0) {
    return {
      role: "general-chat",
      strategy: "fallback",
      confidence: 0.3,
      reason: "No candidates available, using default role",
      forceSwitch: false,
      thinkingIntensity: "none",
    };
  }

  // 1. Circuit breaker: remove recently failed models
  const { filtered, applied: circuitApplied } = applyCircuitBreaker(scores, context);

  // 2. Cost optimization: boost cheap models for simple tasks at night
  const { adjusted, applied: costApplied } = applyCostOptimization(filtered, context);

  // 3. Fatigue mitigation: adjust thinking intensity
  const { thinkingIntensity, applied: fatigueApplied } = applyFatigueMitigation(adjusted, context);

  // 4. Drift recovery: check if topic changed
  const { role: driftRole, applied: driftApplied } = applyDriftRecovery(adjusted, context, signal);

  // Select the top-scoring model
  const selected = adjusted[0];

  // Build strategy description
  const strategies: string[] = [];
  if (circuitApplied) strategies.push("circuit-breaker");
  if (costApplied) strategies.push("cost-optimize");
  if (fatigueApplied) strategies.push("fatigue-mitigate");
  if (driftApplied) strategies.push("drift-recovery");

  const strategyName = strategies.length > 0 ? strategies.join("+") : "default";

  // Calculate confidence based on score gap
  const secondScore = adjusted[1]?.totalScore ?? 0;
  const scoreGap = selected.totalScore - secondScore;
  const confidence = Math.min(1, 0.5 + scoreGap / 50);

  return {
    role: driftRole ?? selected.role,
    strategy: strategyName,
    confidence,
    reason: buildReason(selected, context, strategies),
    forceSwitch: driftApplied,
    thinkingIntensity,
  };
}

function buildReason(
  selected: ModelScore,
  context: RoutingContext,
  strategies: string[],
): string {
  const parts: string[] = [];

  parts.push(`Selected role '${selected.role}' (score: ${selected.totalScore})`);

  if (context.taskComplexity !== "simple") {
    parts.push(`complexity: ${context.taskComplexity}`);
  }
  if (context.cumulativeContextTokens > 4000) {
    parts.push(`context: ${context.cumulativeContextTokens} tokens`);
  }
  if (strategies.length > 0) {
    parts.push(`strategies: ${strategies.join(", ")}`);
  }

  return parts.join(" | ");
}

export { recordCircuitFailure, recordCircuitSuccess, isCircuitOpen };
