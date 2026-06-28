/**
 * Planning Phase — Core Planner.
 *
 * Before every non-trivial user request, the planner:
 * 1. Classifies complexity (keyword-only, zero LLM cost)
 * 2. For simple tasks: returns a 1-step passthrough plan
 * 3. For medium/complex tasks: calls the cheapest model (decision role)
 *    with constrained JSON output to generate an ExecutionPlan
 *
 * Design constraints:
 * - Planning latency < 2s (target)
 * - Planning token cost < 512 tokens
 * - Simple tasks bypass planning entirely (passthrough)
 * - The plan is ALWAYS validated against the schema before use
 */

import { logger } from "../../utils/logger.js";
import { router, type ChatMessage } from "../../router/model-router.js";
import type { ExecutionPlan, PlanStep, Complexity } from "./plan-schema.js";
import { EXECUTION_PLAN_SCHEMA, buildPlanningPrompt } from "./plan-schema.js";
import { injectFirstPrinciplesContext } from "./first-principles.js";
import { eventBus, worldState } from "../../runtime/kernel.js";

// ─── Complexity Classifier (zero-cost, keyword-based) ──────────────────────

interface ClassificationResult {
  complexity: Complexity;
  reason: string;
  needsPlanning: boolean;
}

const SIMPLE_PATTERNS = [
  // Greetings
  /^(hi|hello|hey|你好|嗨|早|晚安)\b/i,
  // Simple factual questions
  /^(what is|什么是|怎么用|how to use)\b/i,
  // Single-step requests
  /^(show|list|tell|explain|解释|显示|列出)\b/i,
  // Short messages (< 30 chars, no code keywords)
];

const COMPLEX_KEYWORDS = [
  // Multi-step tasks
  "refactor", "重构", "architecture", "架构", "design", "设计",
  "implement", "实现", "build", "构建", "migrate", "迁移",
  "optimize", "优化", "debug", "调试", "investigate", "调查",
  // Analysis tasks
  "analyze", "分析", "compare", "比较", "evaluate", "评估",
  "review", "审查", "audit", "审计",
  // Research tasks
  "research", "研究", "investigate", "调研", "survey", "综述",
];

function classifyComplexity(input: string): ClassificationResult {
  const trimmed = input.trim();
  const len = trimmed.length;

  // Very short messages are always simple
  if (len < 20 && !COMPLEX_KEYWORDS.some((kw) => trimmed.toLowerCase().includes(kw))) {
    return { complexity: "simple", reason: "short message", needsPlanning: false };
  }

  // Greetings and simple questions
  if (SIMPLE_PATTERNS.some((p) => p.test(trimmed))) {
    return { complexity: "simple", reason: "greeting or simple question", needsPlanning: false };
  }

  // Check for complex keywords
  const lowerInput = trimmed.toLowerCase();
  const matchedComplexKeywords = COMPLEX_KEYWORDS.filter((kw) => lowerInput.includes(kw));

  if (matchedComplexKeywords.length >= 2) {
    return {
      complexity: "complex",
      reason: `multiple complexity indicators: ${matchedComplexKeywords.join(", ")}`,
      needsPlanning: true,
    };
  }

  if (matchedComplexKeywords.length === 1) {
    return {
      complexity: "medium",
      reason: `complexity indicator: ${matchedComplexKeywords[0]}`,
      needsPlanning: true,
    };
  }

  // Long messages (>200 chars) are likely complex
  if (len > 200) {
    return { complexity: "medium", reason: "long message", needsPlanning: true };
  }

  // Default: simple
  return { complexity: "simple", reason: "no complexity indicators", needsPlanning: false };
}

// ─── Passthrough Plan (for simple tasks) ────────────────────────────────────

function buildPassthroughPlan(input: string): ExecutionPlan {
  return {
    understanding: input.length > 100 ? input.slice(0, 100) + "..." : input,
    knownFacts: [],
    unknowns: [],
    steps: [
      {
        id: 1,
        action: "generate",
        description: "Respond directly to the user",
        expectedOutput: "A helpful response",
        verifyMethod: "Response is relevant and accurate",
      },
    ],
    verificationCriteria: "Response directly addresses the user's request",
    complexity: "simple",
    firstPrinciples: [],
  };
}

// ─── Schema Validation ─────────────────────────────────────────────────────

function validatePlan(raw: unknown): ExecutionPlan | null {
  if (!raw || typeof raw !== "object") return null;

  const obj = raw as Record<string, unknown>;

  // Required fields
  if (typeof obj.understanding !== "string" || obj.understanding.length === 0) return null;
  if (!Array.isArray(obj.steps) || obj.steps.length === 0) return null;
  if (typeof obj.verificationCriteria !== "string") return null;
  if (!["simple", "medium", "complex"].includes(obj.complexity as string)) return null;
  if (!Array.isArray(obj.firstPrinciples)) return null;

  // Validate steps
  for (const step of obj.steps as Record<string, unknown>[]) {
    if (typeof step.id !== "number" || step.id < 1) return null;
    if (typeof step.description !== "string" || step.description.length === 0) return null;
    if (typeof step.expectedOutput !== "string") return null;
    if (typeof step.verifyMethod !== "string") return null;
    const validActions = ["analyze", "search", "generate", "verify", "ask_user", "tool_call"];
    if (!validActions.includes(step.action as string)) return null;
    // If action is tool_call, tool must be specified
    if (step.action === "tool_call" && typeof step.tool !== "string") return null;
  }

  return raw as ExecutionPlan;
}

// ─── JSON Extraction (handles markdown fences) ─────────────────────────────

function extractJson(content: string): unknown {
  // Try direct parse first
  try {
    return JSON.parse(content);
  } catch {
    // Try extracting from markdown fences
    const fenceMatch = content.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
    if (fenceMatch) {
      try {
        return JSON.parse(fenceMatch[1]);
      } catch {
        // fall through
      }
    }
    // Try finding first { to last }
    const firstBrace = content.indexOf("{");
    const lastBrace = content.lastIndexOf("}");
    if (firstBrace !== -1 && lastBrace > firstBrace) {
      try {
        return JSON.parse(content.slice(firstBrace, lastBrace + 1));
      } catch {
        // fall through
      }
    }
  }
  return null;
}

// ─── Main Planner ──────────────────────────────────────────────────────────

export interface PlanningResult {
  plan: ExecutionPlan;
  classification: ClassificationResult;
  latencyMs: number;
  skipped: boolean;
  error?: string;
}

// ─── Plan Cache (LRU, 60s TTL) ─────────────────────────────────────────────

const PLAN_CACHE_MAX = 32;
const PLAN_CACHE_TTL = 60_000; // 60 seconds
const planCache = new Map<string, { result: PlanningResult; at: number }>();

function cacheKey(input: string): string {
  // Simple hash: first 100 chars + length
  return `${input.slice(0, 100)}|${input.length}`;
}

function getCached(input: string): PlanningResult | null {
  const key = cacheKey(input);
  const entry = planCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.at > PLAN_CACHE_TTL) {
    planCache.delete(key);
    return null;
  }
  return entry.result;
}

function setCache(input: string, result: PlanningResult): void {
  const key = cacheKey(input);
  if (planCache.size >= PLAN_CACHE_MAX) {
    // Evict oldest
    const first = planCache.keys().next().value;
    if (first) planCache.delete(first);
  }
  planCache.set(key, { result, at: Date.now() });
}

/**
 * Generate an execution plan for the given user input.
 *
 * - Simple tasks → passthrough plan (0ms, 0 tokens)
 * - Medium/complex tasks → LLM-generated plan (decision model, ~1-2s)
 * - If planning fails → passthrough plan with error logged
 * - Results cached for 60s to avoid redundant LLM calls
 */
export async function planExecution(
  userInput: string,
  conversationHistory: ChatMessage[] = [],
): Promise<PlanningResult> {
  // Check cache first
  const cached = getCached(userInput);
  if (cached) {
    logger.debug("[Planner] Cache hit");
    return { ...cached, latencyMs: 0 };
  }

  const startTime = Date.now();

  // Step 1: Classify complexity (zero cost)
  const classification = classifyComplexity(userInput);

  // Simple tasks: skip planning entirely
  if (!classification.needsPlanning) {
    const plan = buildPassthroughPlan(userInput);
    logger.info("[Planner] Simple task, passthrough", {
      complexity: classification.complexity,
      reason: classification.reason,
    });
    return {
      plan,
      classification,
      latencyMs: 0,
      skipped: true,
    };
  }

  // Step 2: Build planning prompt
  const historyText = conversationHistory
    .slice(-6) // Last 3 turns
    .map((m) => `${m.role}: ${m.content.slice(0, 200)}`)
    .join("\n");

  // Include dynamically generated tools from ToolFactory
  const { toolFactory } = await import("../../mcp/tool-factory.js");
  const generatedTools = toolFactory.getGenerated();
  const toolList = [
    "memory_search, memory_read, memory_write, web_search, web_fetch",
    "code_generate, code_review, code_refactor, terminal_exec, git_status, git_diff",
    "fs_read, fs_write, fs_search, code_symbols, code_diagnostics",
    ...generatedTools.map((t) => t.name),
  ].join(", ");

  const planningPrompt = buildPlanningPrompt(
    userInput,
    historyText,
    toolList,
    new Date().toISOString(),
  );

  // Inject first-principles context into the system message
  const systemPrompt = injectFirstPrinciplesContext(userInput, historyText);

  // Step 3: Call decision model (cheapest available)
  try {
    const messages: ChatMessage[] = [
      { role: "system", content: systemPrompt },
      { role: "user", content: planningPrompt },
    ];

    const response = await router.chat("decision", messages);

    if (!response.content) {
      logger.warn("[Planner] Empty response from decision model");
      return {
        plan: buildPassthroughPlan(userInput),
        classification,
        latencyMs: Date.now() - startTime,
        skipped: false,
        error: "Empty response",
      };
    }

    // Step 4: Parse and validate
    const raw = extractJson(response.content);
    const plan = validatePlan(raw);

    if (!plan) {
      logger.warn("[Planner] Invalid plan structure, falling back to passthrough", {
        responsePreview: response.content.slice(0, 200),
      });
      return {
        plan: buildPassthroughPlan(userInput),
        classification,
        latencyMs: Date.now() - startTime,
        skipped: false,
        error: "Schema validation failed",
      };
    }

    const latencyMs = Date.now() - startTime;
    logger.info("[Planner] Plan generated", {
      complexity: plan.complexity,
      steps: plan.steps.length,
      latencyMs,
      model: response.model,
      hasUnknowns: plan.unknowns.length > 0,
      hasClarifications: (plan.clarificationsNeeded?.length ?? 0) > 0,
    });

    const result: PlanningResult = { plan, classification, latencyMs, skipped: false };
    setCache(userInput, result);

    // Publish planning event to Runtime Event Bus
    eventBus.publish({
      type: "planning.completed",
      source: "planner",
      data: {
        complexity: plan.complexity,
        steps: plan.steps.length,
        latencyMs,
        hasUnknowns: plan.unknowns.length > 0,
        hasClarifications: (plan.clarificationsNeeded?.length ?? 0) > 0,
      },
      priority: "normal",
    });

    // Update world state
    worldState.set("planning.lastPlan", {
      timestamp: Date.now(),
      complexity: plan.complexity,
      steps: plan.steps.length,
      understanding: plan.understanding,
    });

    return result;
  } catch (err) {
    const errorMsg = (err as Error).message;
    logger.error("[Planner] Planning failed, using passthrough", err instanceof Error ? err : new Error(String(err)));
    return {
      plan: buildPassthroughPlan(userInput),
      classification,
      latencyMs: Date.now() - startTime,
      skipped: false,
      error: errorMsg,
    };
  }
}

/**
 * Quick complexity check without generating a plan.
 * Used by the router to decide whether to invoke planning.
 */
export function assessComplexity(input: string): ClassificationResult {
  return classifyComplexity(input);
}

export type { ClassificationResult };
