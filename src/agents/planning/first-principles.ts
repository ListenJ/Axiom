/**
 * First Principles Engine — injected into Planning Phase prompt.
 *
 * This module does NOT make LLM calls.  It provides the philosophical
 * constraints that the planner prompt embeds.  The "hereness" engineering:
 *
 *   Before answering, the agent must:
 *   1. Identify the most basic assumptions
 *   2. Decompose into indivisible atomic facts
 *   3. Reason from atoms — not analogy
 *   4. Mark certainty levels
 *   5. Say "I don't know" rather than fabricate
 *
 * Inspired by: Aristotle's Organon, Descartes' methodic doubt,
 * Feynman's "first principle" thinking, Socratic elenchus.
 */

// ─── Prompt Fragments ──────────────────────────────────────────────────────

/**
 * Core first-principles directive.
 * Embedded verbatim in every planning prompt.
 */
export const FIRST_PRINCIPLES_DIRECTIVE = `## First Principles Protocol

Before constructing your plan, apply this reasoning protocol:

1. DECOMPOSITION (Aristotle)
   - Break the question into its smallest atomic parts
   - Identify: what is GIVEN (known), what is ASKED (goal), what is ASSUMED (implicit)

2. METHODIC DOUBT (Descartes)
   - For each assumption, ask: "What if this is false?"
   - If an assumption is unverifiable, mark it as UNCERTAIN

3. RECONSTRUCTION (Feynman)
   - From the atomic facts alone, reconstruct the answer
   - Do NOT use "common knowledge" or "typically" as reasoning steps

4. ELENCHUS CHECK (Socrates)
   - After forming your plan, argue AGAINST it
   - What is the strongest counter-argument?
   - If the counter-argument is stronger, revise the plan

5. HERENESS (Heidegger / Dasein)
   - Be present in the ACTUAL situation, not an idealized version
   - Consider: what is the user ACTUALLY trying to accomplish?
   - Consider: what constraints exist RIGHT NOW (time, tools, knowledge)?`;

/**
 * Certainty level markers the agent must use.
 */
export const CERTAINTY_LEVELS = {
  CERTAIN: "[CERTAIN]",       // Verified by tool output or explicit user statement
  INFERRED: "[INFERRED]",     // Logical deduction from certain facts
  UNCERTAIN: "[UNCERTAIN]",   // Assumption or common knowledge
  FABRICATED: "[FABRICATED]", // Should NEVER appear — triggers rejection
} as const;

/**
 * Anti-hallucination guardrails.
 * Embedded in planning prompt and verifier.
 */
export const ANTI_HALLUCINATION_RULES = `## Anti-Hallucination Rules

1. NEVER fabricate numbers, dates, URLs, or citations
2. NEVER claim a tool was called if it wasn't
3. NEVER present inference as certainty
4. If you don't know — say "I don't know" and plan how to find out
5. Every factual claim must have a source tag: [CERTAIN], [INFERRED], or [UNCERTAIN]
6. If confidence < 60%, ask the user for clarification instead of guessing`;

// ─── Prompt Builder ────────────────────────────────────────────────────────

/**
 * Build the system prompt for the planning LLM call.
 * Uses the cheapest available model (decision role).
 */
export function buildFirstPrinciplesSystemPrompt(): string {
  return `You are the Planning Phase of OpenClaw AI Agent.

${FIRST_PRINCIPLES_DIRECTIVE}

${ANTI_HALLUCINATION_RULES}

## Output Rules
- Output ONLY valid JSON (no markdown, no commentary)
- Maximum 8 plan steps
- If uncertain about user intent, put the question in clarificationsNeeded
- Every step must have a concrete verifyMethod
- Do NOT hallucinate tools — only use the listed available tools`;
}

/**
 * Inject first-principles context into the planning prompt.
 * Called by planner.ts before making the LLM call.
 */
export function injectFirstPrinciplesContext(
  userInput: string,
  conversationContext: string,
): string {
  const parts: string[] = [];

  parts.push(buildFirstPrinciplesSystemPrompt());
  parts.push("");

  if (conversationContext) {
    parts.push("## Conversation Context");
    parts.push(conversationContext);
    parts.push("");
  }

  parts.push("## User Input");
  parts.push(userInput);
  parts.push("");
  parts.push("Create your execution plan as JSON.");

  return parts.join("\n");
}

// ─── Hereness Engineering ──────────────────────────────────────────────────

/**
 * "Hereness" constraints — forces the agent to consider the ACTUAL
 * situation rather than an idealized version.
 *
 * This is NOT a separate LLM call.  It's a set of questions the
 * verifier checks against the plan.
 */
export const HERENESS_CHECKS = [
  "Does this plan consider the user's ACTUAL environment (OS, tools available)?",
  "Does this plan account for REAL constraints (time, token budget, model capabilities)?",
  "Is this plan solving the user's ACTUAL problem, or an idealized version?",
  "Are the verification methods CONCRETE (can be checked by a machine)?",
  "Does the plan avoid steps that assume perfect information?",
] as const;
