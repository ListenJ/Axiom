/**
 * Trace Analyzer — Deterministic reflection triggers (ported from DRE).
 *
 * Zero-cost, zero-LLM heuristics that detect anomalies in the
 * reasoning trace.  Used as a pre-filter before the LLM-based
 * reflection loop, or as a fallback when LLM is unavailable.
 *
 * Detects:
 * 1. Consecutive failures (3+ failures in last 10 steps)
 * 2. Output inconsistency (<70% unique outputs in recent think steps)
 * 3. Confidence variance (std-dev > 0.15 in recent confidences)
 */

import { logger } from "../../utils/logger.js";
import type { TraceAnomaly } from "./types.js";

// ─── Trace Entry ───────────────────────────────────────────────────────────

export interface TraceEntry {
  timestamp: number;
  stepType: "think" | "act" | "observe" | "reflect";
  inputHash: string;
  outputHash: string;
  confidence: number;
  success: boolean;
  model?: string;
}

// ─── Ring Buffer ───────────────────────────────────────────────────────────

const MAX_ENTRIES = 100;
const entries: TraceEntry[] = [];

export function recordTraceEntry(entry: TraceEntry): void {
  entries.push(entry);
  if (entries.length > MAX_ENTRIES) {
    entries.splice(0, entries.length - MAX_ENTRIES);
  }
}

export function getTraceEntries(): readonly TraceEntry[] {
  return entries;
}

export function clearTrace(): void {
  entries.length = 0;
}

// ─── Analysis Functions ────────────────────────────────────────────────────

/**
 * Detect 3+ consecutive failures in last N entries.
 */
function detectConsecutiveFailures(window: number = 10): TraceAnomaly | null {
  const recent = entries.slice(-window);
  if (recent.length < 3) return null;

  let maxStreak = 0;
  let currentStreak = 0;
  for (const entry of recent) {
    if (!entry.success) {
      currentStreak++;
      maxStreak = Math.max(maxStreak, currentStreak);
    } else {
      currentStreak = 0;
    }
  }

  if (maxStreak >= 3) {
    return {
      type: "consecutive-failures",
      severity: Math.min(1, maxStreak / 5),
      description: `${maxStreak} consecutive failures in last ${recent.length} steps`,
    };
  }
  return null;
}

/**
 * Detect output inconsistency in think steps.
 * If <70% of recent think outputs are unique, the model may be looping.
 */
function detectOutputInconsistency(window: number = 10): TraceAnomaly | null {
  const thinkSteps = entries
    .filter((e) => e.stepType === "think")
    .slice(-window);

  if (thinkSteps.length < 4) return null;

  const uniqueOutputs = new Set(thinkSteps.map((e) => e.outputHash));
  const uniqueRatio = uniqueOutputs.size / thinkSteps.length;

  if (uniqueRatio < 0.7) {
    return {
      type: "output-inconsistency",
      severity: 1 - uniqueRatio,
      description: `Only ${(uniqueRatio * 100).toFixed(0)}% unique outputs in last ${thinkSteps.length} think steps (expected ≥70%)`,
    };
  }
  return null;
}

/**
 * Detect confidence variance in recent entries.
 * High variance (std-dev > 0.15) suggests the model is uncertain.
 */
function detectConfidenceVariance(window: number = 10): TraceAnomaly | null {
  const recent = entries.slice(-window);
  if (recent.length < 4) return null;

  const confidences = recent.map((e) => e.confidence);
  const mean = confidences.reduce((a, b) => a + b, 0) / confidences.length;
  const variance = confidences.reduce((sum, c) => sum + (c - mean) ** 2, 0) / confidences.length;
  const stdDev = Math.sqrt(variance);

  if (stdDev > 0.15) {
    return {
      type: "confidence-variance",
      severity: Math.min(1, stdDev),
      description: `Confidence std-dev ${(stdDev * 100).toFixed(1)}% (threshold 15%) across ${recent.length} entries`,
    };
  }
  return null;
}

// ─── Main Analyzer ─────────────────────────────────────────────────────────

/**
 * Run all deterministic trace checks.
 * Returns the most severe anomaly, or null if everything looks healthy.
 */
export function analyzeTrace(): TraceAnomaly | null {
  if (entries.length < 4) return null;

  const anomalies: TraceAnomaly[] = [];

  const failure = detectConsecutiveFailures();
  if (failure) anomalies.push(failure);

  const inconsistency = detectOutputInconsistency();
  if (inconsistency) anomalies.push(inconsistency);

  const variance = detectConfidenceVariance();
  if (variance) anomalies.push(variance);

  if (anomalies.length === 0) return null;

  // Return the most severe
  anomalies.sort((a, b) => b.severity - a.severity);
  const worst = anomalies[0];

  logger.info("[TraceAnalyzer] Anomaly detected", {
    type: worst.type,
    severity: worst.severity.toFixed(2),
    description: worst.description,
  });

  return worst;
}
