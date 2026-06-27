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

// ─── EWMA Adaptive Threshold (from arXiv:2602.17431) ────────────────────────

/**
 * Exponentially Weighted Moving Average control chart.
 * Adapts thresholds to the system's recent behavior instead of
 * using fixed magic numbers.
 *
 * Anomaly detected when: |value - EWMA| > k * sqrt(EWMA_variance)
 */
class AdaptiveThreshold {
  private ewma = 0;
  private ewmaVariance = 0;
  private readonly alpha: number;
  private readonly k: number;
  private initialized = false;

  constructor(alpha = 0.2, k = 3) {
    this.alpha = alpha;
    this.k = k;
  }

  update(value: number): boolean {
    if (!this.initialized) {
      this.ewma = value;
      this.ewmaVariance = 0;
      this.initialized = true;
      return false;
    }

    const delta = value - this.ewma;
    this.ewma += this.alpha * delta;
    this.ewmaVariance = (1 - this.alpha) * (this.ewmaVariance + this.alpha * delta * delta);

    const sigma = Math.sqrt(this.ewmaVariance);
    return sigma > 0 && Math.abs(value - this.ewma) > this.k * sigma;
  }

  getEwma(): number { return this.ewma; }
  getSigma(): number { return Math.sqrt(this.ewmaVariance); }
}

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

// ─── EWMA Thresholds (per-step-type) ───────────────────────────────────────

const failureRateThreshold = new AdaptiveThreshold(0.2, 2.5);
const uniquenessThreshold = new AdaptiveThreshold(0.2, 2.5);
const confidenceThresholds = new Map<string, AdaptiveThreshold>();

function getConfidenceThreshold(stepType: string): AdaptiveThreshold {
  let t = confidenceThresholds.get(stepType);
  if (!t) {
    t = new AdaptiveThreshold(0.15, 2.0);
    confidenceThresholds.set(stepType, t);
  }
  return t;
}

// ─── Analysis Functions ────────────────────────────────────────────────────

/**
 * Detect consecutive failures using EWMA on failure rate.
 * Instead of fixed ">= 3", tracks the running failure rate and
 * flags when the current rate deviates significantly from baseline.
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

  // Use EWMA on failure rate (0-1)
  const failureRate = recent.filter((e) => !e.success).length / recent.length;
  const isAnomaly = failureRateThreshold.update(failureRate);

  // Also check hard streak threshold (3+ consecutive is always bad)
  if (maxStreak >= 3 || (isAnomaly && failureRate > 0.5)) {
    return {
      type: "consecutive-failures",
      severity: Math.min(1, Math.max(maxStreak / 5, failureRate)),
      description: `${maxStreak} consecutive failures, ${(failureRate * 100).toFixed(0)}% failure rate in last ${recent.length} steps`,
    };
  }
  return null;
}

/**
 * Detect output inconsistency using EWMA on uniqueness ratio.
 * Tracks the running uniqueness baseline instead of fixed 70%.
 */
function detectOutputInconsistency(window: number = 10): TraceAnomaly | null {
  const thinkSteps = entries
    .filter((e) => e.stepType === "think")
    .slice(-window);

  if (thinkSteps.length < 4) return null;

  const uniqueOutputs = new Set(thinkSteps.map((e) => e.outputHash));
  const uniqueRatio = uniqueOutputs.size / thinkSteps.length;

  // EWMA tracks the normal uniqueness ratio; anomaly when current is far below
  const isAnomaly = uniquenessThreshold.update(uniqueRatio);

  if (uniqueRatio < 0.5 || (isAnomaly && uniqueRatio < 0.7)) {
    return {
      type: "output-inconsistency",
      severity: 1 - uniqueRatio,
      description: `Only ${(uniqueRatio * 100).toFixed(0)}% unique outputs in last ${thinkSteps.length} think steps`,
    };
  }
  return null;
}

/**
 * Detect confidence variance using per-step-type EWMA tracking.
 * Instead of a global threshold, tracks normal variance per step type
 * and flags when variance exceeds the adaptive baseline.
 */
function detectConfidenceVariance(window: number = 10): TraceAnomaly | null {
  const recent = entries.slice(-window);
  if (recent.length < 4) return null;

  // Track variance per step type
  const byType = new Map<string, number[]>();
  for (const entry of recent) {
    const arr = byType.get(entry.stepType) ?? [];
    arr.push(entry.confidence);
    byType.set(entry.stepType, arr);
  }

  for (const [stepType, confidences] of byType) {
    if (confidences.length < 2) continue;
    const mean = confidences.reduce((a, b) => a + b, 0) / confidences.length;
    const variance = confidences.reduce((sum, c) => sum + (c - mean) ** 2, 0) / confidences.length;
    const stdDev = Math.sqrt(variance);

    const threshold = getConfidenceThreshold(stepType);
    const isAnomaly = threshold.update(stdDev);

    if (isAnomaly && stdDev > 0.1) {
      return {
        type: "confidence-variance",
        severity: Math.min(1, stdDev * 2),
        description: `Confidence std-dev ${(stdDev * 100).toFixed(1)}% in '${stepType}' steps (adaptive threshold)`,
      };
    }
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
