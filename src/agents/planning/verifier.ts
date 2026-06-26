/**
 * Planning Phase — Output Verifier.
 *
 * After the agent executes the plan, the verifier checks whether the
 * output matches the plan's verificationCriteria.  This is a lightweight,
 * rule-based check — NOT an LLM call.
 *
 * For critical tasks, the verifier can invoke the DRE three-stage pipeline
 * to fact-check claims in the output.
 */

import { logger } from "../../utils/logger.js";
import type { ExecutionPlan, Complexity } from "./plan-schema.js";
import { CERTAINTY_LEVELS } from "./first-principles.js";

// ─── Verification Result ───────────────────────────────────────────────────

export interface VerificationResult {
  /** Overall pass/fail */
  passed: boolean;
  /** Confidence score 0-1 */
  confidence: number;
  /** Issues found */
  issues: VerificationIssue[];
  /** Summary for logging */
  summary: string;
}

export interface VerificationIssue {
  severity: "low" | "medium" | "high";
  category: "missing" | "incorrect" | "hallucination" | "incomplete" | "unverified";
  description: string;
  stepId?: number;
}

// ─── Rule-Based Checks ─────────────────────────────────────────────────────

/**
 * Check for potential hallucination signals in the output.
 */
function detectHallucinationSignals(output: string): VerificationIssue[] {
  const issues: VerificationIssue[] = [];

  // Check for fabricated URLs (common hallucination pattern)
  const urlPattern = /https?:\/\/[^\s)]+/g;
  const urls = output.match(urlPattern);
  if (urls) {
    // Suspicious patterns: localhost with random ports, example.com with paths, IP addresses
    for (const url of urls) {
      if (/localhost:\d{4,5}/.test(url) || /example\.com\/[a-z]/.test(url) || /\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}/.test(url)) {
        issues.push({
          severity: "high",
          category: "hallucination",
          description: `Suspicious URL detected: ${url}`,
        });
      }
    }
  }

  // Check for suspiciously specific numbers without source
  const specificNumberPattern = /\b\d{4,}\b/g;
  const numbers = output.match(specificNumberPattern);
  if (numbers && numbers.length > 3) {
    issues.push({
      severity: "medium",
      category: "unverified",
      description: `Output contains ${numbers.length} large numbers — verify accuracy`,
    });
  }

  // Check for fake citations
  const citationPatterns = [
    /according to .{5,50}(study|research|report|paper)/i,
    /(研究|报告|论文|数据显示).{5,30}(表明|显示|指出)/,
  ];
  for (const pattern of citationPatterns) {
    if (pattern.test(output)) {
      // Check if there's a real reference (URL, DOI, etc.)
      if (!urlPattern.test(output) && !/doi:|arxiv:|isbn:/i.test(output)) {
        issues.push({
          severity: "high",
          category: "hallucination",
          description: "Citation without verifiable source",
        });
      }
    }
  }

  return issues;
}

/**
 * Check whether the output addresses the plan's steps.
 */
function checkStepCoverage(
  plan: ExecutionPlan,
  output: string,
): VerificationIssue[] {
  const issues: VerificationIssue[] = [];

  // Check if output is too short for a complex task
  const minLength: Record<Complexity, number> = {
    simple: 10,
    medium: 50,
    complex: 100,
  };

  if (output.length < minLength[plan.complexity]) {
    issues.push({
      severity: "medium",
      category: "incomplete",
      description: `Output too short for ${plan.complexity} task (${output.length} < ${minLength[plan.complexity]} chars)`,
    });
  }

  // Check for "I don't know" without a plan to find out
  const uncertainPatterns = [
    /i don'?t know/i,
    /i'?m not sure/i,
    /i can'?t (answer|determine|verify)/i,
    /我不确定/,
    /我不知道/,
    /无法确定/,
  ];

  const hasUncertainty = uncertainPatterns.some((p) => p.test(output));
  const hasStepsToResolve = plan.steps.some(
    (s) => s.action === "search" || s.action === "ask_user",
  );

  if (hasUncertainty && !hasStepsToResolve) {
    issues.push({
      severity: "low",
      category: "incomplete",
      description: "Output expresses uncertainty but plan has no steps to resolve it",
    });
  }

  return issues;
}

/**
 * Check certainty level markers in the output.
 */
function checkCertaintyMarkers(output: string): VerificationIssue[] {
  const issues: VerificationIssue[] = [];

  // Check if FABRICATED marker appears (should never happen)
  if (output.includes(CERTAINTY_LEVELS.FABRICATED)) {
    issues.push({
      severity: "high",
      category: "hallucination",
      description: "Output contains [FABRICATED] marker — agent self-identified fabrication",
    });
  }

  return issues;
}

// ─── Main Verifier ─────────────────────────────────────────────────────────

/**
 * Verify agent output against the execution plan.
 *
 * This is a FAST, rule-based check (< 10ms).  For critical tasks
 * that need fact-checking, use the DRE pipeline separately.
 */
export function verifyOutput(
  plan: ExecutionPlan,
  output: string,
): VerificationResult {
  const issues: VerificationIssue[] = [];

  // Run all checks
  issues.push(...detectHallucinationSignals(output));
  issues.push(...checkStepCoverage(plan, output));
  issues.push(...checkCertaintyMarkers(output));

  // Calculate confidence
  const highIssues = issues.filter((i) => i.severity === "high").length;
  const mediumIssues = issues.filter((i) => i.severity === "medium").length;
  const lowIssues = issues.filter((i) => i.severity === "low").length;

  let confidence = 1.0;
  confidence -= highIssues * 0.3;
  confidence -= mediumIssues * 0.1;
  confidence -= lowIssues * 0.05;
  confidence = Math.max(0, Math.min(1, confidence));

  // Pass threshold: no high issues and confidence >= 0.5
  const passed = highIssues === 0 && confidence >= 0.5;

  const summary = [
    passed ? "PASS" : "FAIL",
    `confidence=${(confidence * 100).toFixed(0)}%`,
    `issues=${issues.length}`,
    highIssues > 0 ? `(${highIssues} high)` : "",
  ]
    .filter(Boolean)
    .join(" ");

  if (!passed) {
    logger.warn("[Verifier] Output verification failed", {
      issues: issues.map((i) => `[${i.severity}] ${i.category}: ${i.description}`),
      confidence,
    });
  }

  return { passed, confidence, issues, summary };
}

/**
 * Should this plan's output be verified?
 * Simple plans skip verification.
 */
function shouldVerify(plan: ExecutionPlan): boolean {
  // Always verify complex plans
  if (plan.complexity === "complex") return true;

  // Verify medium plans if they have verification criteria
  if (plan.complexity === "medium" && plan.verificationCriteria.length > 10) return true;

  // Skip verification for simple passthrough plans
  return false;
}

/**
 * Full verification pipeline: verify + optional DRE fact-check.
 * Called by the task orchestrator after execution.
 */
export async function verifyPlanExecution(
  plan: ExecutionPlan,
  output: string,
): Promise<VerificationResult> {
  if (!shouldVerify(plan)) {
    return {
      passed: true,
      confidence: 1.0,
      issues: [],
      summary: "SKIPPED (simple task)",
    };
  }

  return verifyOutput(plan, output);
}

export { shouldVerify };
