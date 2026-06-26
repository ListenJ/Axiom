/**
 * Planning Phase Module — Public API.
 *
 * Usage:
 *   import { planExecution, verifyPlanExecution } from "./agents/planning/index.js";
 *
 *   // Before execution
 *   const { plan, classification } = await planExecution(userInput, history);
 *
 *   // ... execute the plan ...
 *
 *   // After execution
 *   const verification = await verifyPlanExecution(plan, output);
 */

export { planExecution, assessComplexity } from "./planner.js";
export type { PlanningResult, ClassificationResult } from "./planner.js";

export { verifyOutput, verifyPlanExecution, shouldVerify } from "./verifier.js";
export type { VerificationResult, VerificationIssue } from "./verifier.js";

export type { ExecutionPlan, PlanStep, Complexity, StepAction } from "./plan-schema.js";
export { EXECUTION_PLAN_SCHEMA, buildPlanningPrompt } from "./plan-schema.js";

export {
  FIRST_PRINCIPLES_DIRECTIVE,
  CERTAINTY_LEVELS,
  ANTI_HALLUCINATION_RULES,
  HERENESS_CHECKS,
  buildFirstPrinciplesSystemPrompt,
  injectFirstPrinciplesContext,
} from "./first-principles.js";
