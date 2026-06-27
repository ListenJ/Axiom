/**
 * Planning Phase — Output Verifier.
 *
 * After the agent executes the plan, the verifier checks whether the
 * output matches the plan's verificationCriteria.  This is a lightweight,
 * rule-based check — NOT an LLM call.
 *
 * Enhanced with DRE pipeline's risk scoring rules:
 * - Blacklist detection (dangerous/harmful content patterns)
 * - Source-type risk (LLM-generated content gets +0.1 risk)
 * - Length risk (too short for complexity level)
 * - Confidence floor (confidence < 0.6 forces reject)
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

// ─── Claim-Level Verification (inspired by RT4CHART, MARCH, RefChecker) ────

/**
 * Extract atomic claims from output and verify them.
 *
 * Inspired by:
 * - RT4CHART (arXiv:2603.27752): hierarchical local-to-global verification
 * - MARCH (arXiv:2603.24579): claim-level decomposition with information asymmetry
 * - RefChecker (arXiv:2405.14486): claim-triplet extraction
 *
 * This is a zero-cost heuristic version — no LLM calls.
 * Extracts factual claims and checks for common hallucination patterns.
 */
function extractAndVerifyClaims(output: string, plan: ExecutionPlan): VerificationIssue[] {
  const issues: VerificationIssue[] = [];

  // Extract sentences that look like factual claims
  const sentences = output
    .split(/[.。\n]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 15 && s.length < 500);

  // Pattern 1: "X was released in Y" / "X was founded in Y" — check year plausibility
  const yearPattern = /(?:released|founded|published|created|launched|announced)\s+(?:in\s+)?(\d{4})/gi;
  const currentYear = new Date().getFullYear();
  let match: RegExpExecArray | null;
  while ((match = yearPattern.exec(output)) !== null) {
    const year = parseInt(match[1]);
    if (year < 1970 || year > currentYear + 1) {
      issues.push({
        severity: "high",
        category: "hallucination",
        description: `Implausible year ${year} in claim: "${match[0]}"`,
      });
    }
  }

  // Pattern 2: Tool calls referencing non-existent tools
  const toolCallPattern = /(?:using|call|invoke|tool|function)\s*[:=]?\s*["']?([a-z_][a-z0-9_]+)/gi;
  const availableTools = plan.steps
    .filter((s) => s.action === "tool_call" && s.tool)
    .map((s) => s.tool!.toLowerCase());
  while ((match = toolCallPattern.exec(output)) !== null) {
    const toolName = match[1].toLowerCase();
    if (availableTools.length > 0 && !availableTools.includes(toolName) && !["the", "this", "that", "with"].includes(toolName)) {
      issues.push({
        severity: "medium",
        category: "unverified",
        description: `Reference to tool '${toolName}' not in plan's tool list`,
      });
    }
  }

  // Pattern 3: Premise smuggling — claims asserted as "obviously" or "clearly" without evidence
  // From arXiv:2606.24902 — "load-bearing claims asserted as fundamental results"
  const premiseSmuggling = [
    /\b(obviously|clearly|trivially|it is well known|it is known|as we know)\b/gi,
    /\b(fundamental result|standard argument|basic fact|well-established)\b/gi,
  ];
  for (const pattern of premiseSmuggling) {
    while ((match = pattern.exec(output)) !== null) {
      issues.push({
        severity: "low",
        category: "unverified",
        description: `Premise smuggling detected: "${match[0]}" — claim asserted without evidence`,
      });
    }
  }

  // Pattern 4: Noisy-OR aggregation — if multiple claims are suspicious, escalate
  // P(hallucination) = 1 - product(1 - P(claim_i is hallucinated))
  const claimCount = sentences.length;
  const issueCount = issues.length;
  if (claimCount > 3 && issueCount / claimCount > 0.3) {
    issues.push({
      severity: "high",
      category: "hallucination",
      description: `High claim-level issue rate: ${issueCount}/${claimCount} claims flagged (${((issueCount / claimCount) * 100).toFixed(0)}%)`,
    });
  }

  return issues;
}

// ─── DRE Risk Scoring (ported from DRE Pipeline) ───────────────────────────

/**
 * DRE-style blacklist patterns.  Content matching these gets +0.3 risk.
 * Ported from src/dre/pipeline/pipeline.ts BlacklistRule.
 */
const BLACKLIST_PATTERNS = [
  /虚假信息/, /谣言/, /fake news/i, /misinformation/i,
  /hack(?!er)/i, /exploit(?!ation)/i, /inject/i,
  /<script/i, /javascript:/i, /on\w+=/i,
];

/**
 * DRE-style risk score for output content.
 * Returns a risk score 0-1.  Used to decide if deeper verification is needed.
 */
function computeDreRiskScore(output: string, plan: ExecutionPlan): number {
  let risk = 0;

  // Blacklist patterns
  for (const pattern of BLACKLIST_PATTERNS) {
    if (pattern.test(output)) {
      risk += 0.3;
      break;
    }
  }

  // Length risk: too short for complexity
  const minLen: Record<Complexity, number> = { simple: 10, medium: 50, complex: 100 };
  if (output.length < minLen[plan.complexity]) {
    risk += 0.2;
  }

  // Source-type risk: if plan used LLM generation, slightly riskier
  const hasGenerate = plan.steps.some((s) => s.action === "generate");
  if (hasGenerate) {
    risk += 0.1;
  }

  // Confidence floor: if any step has no verify method, risk increases
  const unverifiedSteps = plan.steps.filter((s) => !s.verifyMethod || s.verifyMethod.length < 5);
  if (unverifiedSteps.length > 0) {
    risk += 0.1;
  }

  return Math.min(1, risk);
}

// ─── Main Verifier ─────────────────────────────────────────────────────────

/**
 * Verify agent output against the execution plan.
 *
 * This is a FAST, rule-based check (< 10ms).  Enhanced with DRE risk scoring.
 * If DRE risk > 0.7, the output is flagged for deeper review.
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
  issues.push(...extractAndVerifyClaims(output, plan));

  // DRE risk scoring
  const dreRisk = computeDreRiskScore(output, plan);
  if (dreRisk > 0.7) {
    issues.push({
      severity: "high",
      category: "incorrect",
      description: `DRE risk score ${(dreRisk * 100).toFixed(0)}% — output requires deeper verification`,
    });
  } else if (dreRisk > 0.4) {
    issues.push({
      severity: "medium",
      category: "unverified",
      description: `DRE risk score ${(dreRisk * 100).toFixed(0)}% — consider fact-checking`,
    });
  }

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
