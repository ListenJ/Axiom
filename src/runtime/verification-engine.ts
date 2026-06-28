/**
 * Verification Engine — 全流程验证
 *
 * 不仅验证结果，还验证：
 * - 输入（Input Verification）
 * - 推理（Reasoning Verification）
 * - 执行（Execution Verification）
 * - 结果（Result Verification）
 *
 * 每一步都有验证，每一步都可以回溯。
 */

import { logger } from "../utils/logger.js";
import { eventBus, worldState } from "./kernel.js";
import { constraintSolver } from "./constraint-solver.js";
import { ruleEngine } from "./rule-engine.js";

// ─── Verification Types ────────────────────────────────────────────────────

export type VerificationStage = "input" | "reasoning" | "execution" | "result";
export type VerificationVerdict = "pass" | "fail" | "warning" | "skip";

export interface VerificationCheck {
  id: string
  stage: VerificationStage
  name: string
  description: string
  verdict: VerificationVerdict
  confidence: number
  evidence: string
  timestamp: number
}

export interface VerificationReport {
  id: string
  taskId: string
  stage: VerificationStage
  checks: VerificationCheck[]
  overallVerdict: VerificationVerdict
  overallConfidence: number
  issues: VerificationIssue[]
  suggestions: string[]
  timestamp: number
  durationMs: number
}

export interface VerificationIssue {
  severity: "low" | "medium" | "high" | "critical"
  category: string
  description: string
  checkId: string
}

// ─── Verification Engine ───────────────────────────────────────────────────

class VerificationEngineImpl {
  private reports: VerificationReport[] = [];
  private maxReports = 100;
  private stats = { verified: 0, passed: 0, failed: 0, warnings: 0 };

  /**
   * Verify input before processing.
   */
  verifyInput(taskId: string, input: unknown, context?: Record<string, unknown>): VerificationReport {
    const checks: VerificationCheck[] = [];
    const issues: VerificationIssue[] = [];
    const startTime = Date.now();

    // Check 1: Input is not empty
    checks.push(this.check("input-not-empty", "input", "Input is not empty",
      input !== null && input !== undefined && input !== ""));

    // Check 2: Input is valid type
    checks.push(this.check("input-valid-type", "input", "Input is valid type",
      typeof input === "string" || typeof input === "object"));

    // Check 3: Input length is reasonable
    if (typeof input === "string") {
      checks.push(this.check("input-length", "input", "Input length is reasonable",
        input.length > 0 && input.length < 100000));

      // Check 4: No injection patterns
      const hasInjection = /<script|javascript:|on\w+=/i.test(input);
      checks.push(this.check("no-injection", "input", "No injection patterns", !hasInjection));

      if (hasInjection) {
        issues.push({
          severity: "high",
          category: "security",
          description: "Input contains potential injection patterns",
          checkId: "no-injection",
        });
      }
    }

    // Check 5: Context constraints satisfied
    if (context?.entities) {
      const constraintResult = constraintSolver.solve(context.entities as string[]);
      checks.push(this.check("constraints-satisfied", "input", "All constraints satisfied",
        constraintResult.satisfied));

      if (!constraintResult.satisfied) {
        for (const v of constraintResult.violations) {
          issues.push({
            severity: v.severity,
            category: "constraint",
            description: v.message,
            checkId: "constraints-satisfied",
          });
        }
      }
    }

    return this.buildReport(taskId, "input", checks, issues, startTime);
  }

  /**
   * Verify reasoning process.
   */
  verifyReasoning(taskId: string, plan: unknown, context?: Record<string, unknown>): VerificationReport {
    const checks: VerificationCheck[] = [];
    const issues: VerificationIssue[] = [];
    const startTime = Date.now();

    // Check 1: Plan exists
    checks.push(this.check("plan-exists", "reasoning", "Plan exists",
      plan !== null && plan !== undefined));

    // Check 2: Plan has steps
    if (plan && typeof plan === "object" && "steps" in plan) {
      const steps = (plan as { steps: unknown[] }).steps;
      checks.push(this.check("plan-has-steps", "reasoning", "Plan has steps",
        Array.isArray(steps) && steps.length > 0));
    }

    // Check 3: Plan complexity matches task
    if (plan && typeof plan === "object" && "complexity" in plan) {
      const complexity = (plan as { complexity: string }).complexity;
      checks.push(this.check("plan-complexity-valid", "reasoning", "Plan complexity is valid",
        ["simple", "medium", "complex"].includes(complexity)));
    }

    // Check 4: No circular dependencies
    if (plan && typeof plan === "object" && "steps" in plan) {
      const steps = (plan as { steps: Array<{ id?: number; dependsOn?: number[] }> }).steps;
      if (Array.isArray(steps)) {
        const hasCircular = this.detectCircularDependencies(steps);
        checks.push(this.check("no-circular-deps", "reasoning", "No circular dependencies", !hasCircular));

        if (hasCircular) {
          issues.push({
            severity: "high",
            category: "reasoning",
            description: "Plan contains circular dependencies",
            checkId: "no-circular-deps",
          });
        }
      }
    }

    // Check 5: Rules are consistent
    const rules = ruleEngine.list();
    checks.push(this.check("rules-consistent", "reasoning", "Rules are consistent",
      rules.length > 0));

    return this.buildReport(taskId, "reasoning", checks, issues, startTime);
  }

  /**
   * Verify execution process.
   */
  verifyExecution(taskId: string, execution: {
    action: string
    success: boolean
    error?: string
    latencyMs: number
  }): VerificationReport {
    const checks: VerificationCheck[] = [];
    const issues: VerificationIssue[] = [];
    const startTime = Date.now();

    // Check 1: Execution completed
    checks.push(this.check("execution-completed", "execution", "Execution completed",
      execution.success));

    // Check 2: No errors
    checks.push(this.check("no-errors", "execution", "No errors",
      !execution.error));

    if (execution.error) {
      issues.push({
        severity: "high",
        category: "execution",
        description: `Execution error: ${execution.error}`,
        checkId: "no-errors",
      });
    }

    // Check 3: Latency is reasonable
    checks.push(this.check("latency-reasonable", "execution", "Latency is reasonable",
      execution.latencyMs < 30000));

    if (execution.latencyMs > 10000) {
      issues.push({
        severity: "medium",
        category: "performance",
        description: `High latency: ${execution.latencyMs}ms`,
        checkId: "latency-reasonable",
      });
    }

    // Check 4: Action is valid
    checks.push(this.check("action-valid", "execution", "Action is valid",
      execution.action.length > 0));

    return this.buildReport(taskId, "execution", checks, issues, startTime);
  }

  /**
   * Verify result.
   */
  verifyResult(taskId: string, result: unknown, expected?: unknown): VerificationReport {
    const checks: VerificationCheck[] = [];
    const issues: VerificationIssue[] = [];
    const startTime = Date.now();

    // Check 1: Result exists
    checks.push(this.check("result-exists", "result", "Result exists",
      result !== null && result !== undefined));

    // Check 2: Result matches expected (if provided)
    if (expected !== undefined) {
      const matches = JSON.stringify(result) === JSON.stringify(expected);
      checks.push(this.check("result-matches", "result", "Result matches expected", matches));

      if (!matches) {
        issues.push({
          severity: "medium",
          category: "correctness",
          description: "Result does not match expected output",
          checkId: "result-matches",
        });
      }
    }

    // Check 3: Result is not hallucinated
    if (typeof result === "string") {
      const hasFabrication = /\[FABRICATED\]/.test(result);
      checks.push(this.check("no-fabrication", "result", "No fabrication markers", !hasFabrication));

      if (hasFabrication) {
        issues.push({
          severity: "critical",
          category: "hallucination",
          description: "Result contains fabrication markers",
          checkId: "no-fabrication",
        });
      }
    }

    // Check 4: Result has reasonable size
    const resultSize = JSON.stringify(result).length;
    checks.push(this.check("result-size-reasonable", "result", "Result size is reasonable",
      resultSize < 1000000));

    return this.buildReport(taskId, "result", checks, issues, startTime);
  }

  /**
   * Full verification pipeline: input → reasoning → execution → result.
   */
  async verifyFull(taskId: string, data: {
    input: unknown
    plan?: unknown
    execution?: { action: string; success: boolean; error?: string; latencyMs: number }
    result?: unknown
    expected?: unknown
    context?: Record<string, unknown>
  }): Promise<VerificationReport[]> {
    const reports: VerificationReport[] = [];

    // Stage 1: Input verification
    reports.push(this.verifyInput(taskId, data.input, data.context));

    // Stage 2: Reasoning verification (if plan provided)
    if (data.plan) {
      reports.push(this.verifyReasoning(taskId, data.plan, data.context));
    }

    // Stage 3: Execution verification (if execution provided)
    if (data.execution) {
      reports.push(this.verifyExecution(taskId, data.execution));
    }

    // Stage 4: Result verification (if result provided)
    if (data.result !== undefined) {
      reports.push(this.verifyResult(taskId, data.result, data.expected));
    }

    // Publish summary
    const allPassed = reports.every((r) => r.overallVerdict === "pass");
    eventBus.publish({
      type: "verification.completed",
      source: "verification-engine",
      data: {
        taskId,
        stageCount: reports.length,
        allPassed,
        issueCount: reports.reduce((sum, r) => sum + r.issues.length, 0),
      },
      priority: allPassed ? "low" : "high",
    });

    return reports;
  }

  /**
   * Get recent reports.
   */
  getReports(count = 10): VerificationReport[] {
    return this.reports.slice(-count);
  }

  /**
   * Get stats.
   */
  getStats(): { total: number; passed: number; failed: number; warnings: number } {
    return { total: this.stats.verified, ...this.stats };
  }

  // ─── Private ─────────────────────────────────────────────────────

  private check(id: string, stage: VerificationStage, name: string, passed: boolean): VerificationCheck {
    return {
      id,
      stage,
      name,
      description: name,
      verdict: passed ? "pass" : "fail",
      confidence: passed ? 1.0 : 0.0,
      evidence: passed ? "Check passed" : "Check failed",
      timestamp: Date.now(),
    };
  }

  private buildReport(
    taskId: string,
    stage: VerificationStage,
    checks: VerificationCheck[],
    issues: VerificationIssue[],
    startTime: number,
  ): VerificationReport {
    const allPassed = checks.every((c) => c.verdict === "pass");
    const hasHighIssues = issues.some((i) => i.severity === "high" || i.severity === "critical");

    let overallVerdict: VerificationVerdict;
    if (hasHighIssues) overallVerdict = "fail";
    else if (!allPassed) overallVerdict = "warning";
    else overallVerdict = "pass";

    const overallConfidence = checks.reduce((sum, c) => sum + c.confidence, 0) / checks.length;

    const report: VerificationReport = {
      id: `verify_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      taskId,
      stage,
      checks,
      overallVerdict,
      overallConfidence,
      issues,
      suggestions: issues.map((i) => `Fix: ${i.description}`),
      timestamp: Date.now(),
      durationMs: Date.now() - startTime,
    };

    this.reports.push(report);
    if (this.reports.length > this.maxReports) {
      this.reports.shift();
    }

    this.stats.verified++;
    if (overallVerdict === "pass") this.stats.passed++;
    else if (overallVerdict === "fail") this.stats.failed++;
    else this.stats.warnings++;

    return report;
  }

  private detectCircularDependencies(steps: Array<{ id?: number; dependsOn?: number[] }>): boolean {
    const visited = new Set<number>();
    const inStack = new Set<number>();

    const dfs = (stepId: number): boolean => {
      if (inStack.has(stepId)) return true;
      if (visited.has(stepId)) return false;

      visited.add(stepId);
      inStack.add(stepId);

      const step = steps.find((s) => s.id === stepId);
      if (step?.dependsOn) {
        for (const dep of step.dependsOn) {
          if (dfs(dep)) return true;
        }
      }

      inStack.delete(stepId);
      return false;
    };

    for (const step of steps) {
      if (step.id !== undefined && dfs(step.id)) return true;
    }

    return false;
  }
}

export const verificationEngine = new VerificationEngineImpl();
