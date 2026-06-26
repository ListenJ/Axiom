/**
 * Context Scorer — Consciousness-aware routing decisions.
 *
 * The scorer evaluates routing context (conversation history, failures,
 * user expertise, time of day, cumulative context) and produces a
 * scoring matrix that the UnifiedRouter uses to select the optimal model.
 *
 * Design: zero LLM cost.  Pure rule-based scoring with O(1) lookups.
 */

import type { TaskRole } from "./model-capability-registry.js";

// ─── Routing Context ───────────────────────────────────────────────────────

export interface RoutingContext {
  /** Recent conversation messages (last 6) */
  recentMessages: Array<{ role: string; content: string }>;
  /** Recent failure records */
  recentFailures: FailureRecord[];
  /** Inferred user expertise level */
  userExpertise: "beginner" | "intermediate" | "expert";
  /** Task complexity (from planner or classifier) */
  taskComplexity: "simple" | "medium" | "complex";
  /** Currently active tools */
  activeTools: string[];
  /** Session patterns from consciousness layer */
  sessionPatterns: PatternSignal[];
  /** Current time period */
  timeOfDay: "morning" | "afternoon" | "evening" | "night";
  /** Total context tokens accumulated */
  cumulativeContextTokens: number;
  /** Whether this is a continuation of a previous topic */
  isTopicContinuation: boolean;
  /** Number of consecutive failures in this session */
  consecutiveFailures: number;
}

export interface FailureRecord {
  model: string;
  provider: string;
  error: string;
  timestamp: number;
  role: TaskRole;
}

export interface PatternSignal {
  intent: string;
  frequency: number;
  lastSeen: number;
  avgConfidence: number;
}

// ─── Routing Signal (from consciousness) ───────────────────────────────────

export interface RoutingSignal {
  /** Intent drift detected — user switched topics */
  patternDrift: boolean;
  /** Context fatigue — long conversation, model may lose coherence */
  fatigueIndicator: boolean;
  /** Inferred expertise from message complexity */
  expertiseSignal: "beginner" | "intermediate" | "expert";
  /** Urgency level from message tone */
  urgencyLevel: "low" | "normal" | "high";
}

// ─── Score Breakdown ───────────────────────────────────────────────────────

export interface ModelScore {
  model: string;
  provider: string;
  role: TaskRole;
  totalScore: number;
  breakdown: {
    basePriority: number;
    historyBonus: number;
    failurePenalty: number;
    expertiseBonus: number;
    complexityMatch: number;
    contextFatigue: number;
    timePreference: number;
    driftPenalty: number;
  };
}

// ─── Scoring Weights ───────────────────────────────────────────────────────

const WEIGHTS = {
  // Base priority for each role (higher = preferred)
  basePriority: {
    decision: 100,
    architecture: 95,
    coding: 90,
    review: 85,
    research: 80,
    "general-chat": 70,
    "general-tool": 65,
    english: 60,
    rl: 55,
    evaluation: 50,
    embedding: 40,
    memory: 35,
    deep_research: 30,
    math: 25,
    main_coding: 20,
    "computer-use": 15,
  } as Record<string, number>,

  // History bonus: if this role was used recently and succeeded
  historyBonus: 15,

  // Failure penalty (per recent failure, max -40)
  failurePenaltyPerIncident: -10,
  failurePenaltyMax: -40,

  // Expertise bonus: expert users get higher-quality models
  expertiseBonus: {
    beginner: -5,     // Prefer simpler, faster models
    intermediate: 0,  // Default
    expert: 10,       // Prefer higher-quality models
  },

  // Complexity match: model should match task complexity
  complexityMatch: {
    simple: { "general-chat": 10, "general-tool": 8, coding: 5 },
    medium: { coding: 10, research: 8, review: 6 },
    complex: { decision: 10, architecture: 8, coding: 6, deep_research: 5 },
  } as Record<string, Record<string, number>>,

  // Context fatigue: penalize all models when context is long
  fatigueThreshold: 8000,  // tokens
  fatiguePenaltyPer1k: -2, // per 1k tokens over threshold
  fatigueMax: -20,

  // Time preference: cheaper models at night
  timePreference: {
    morning: 0,
    afternoon: 0,
    evening: -3,  // Slight preference for cheaper models
    night: -5,    // Stronger preference
  },

  // Drift penalty: when user switches topics, penalize current model
  driftPenalty: -8,
} as const;

// ─── Scorer ────────────────────────────────────────────────────────────────

/**
 * Score all candidate roles for a given routing context.
 * Returns sorted array (highest score first).
 */
export function scoreCandidates(
  candidates: Array<{ model: string; provider: string; role: TaskRole }>,
  context: RoutingContext,
): ModelScore[] {
  const scores: ModelScore[] = candidates.map((c) => {
    const role = c.role;

    // Base priority
    const basePriority = WEIGHTS.basePriority[role] ?? 50;

    // History bonus: if this role was used recently in the session
    const recentRoles = context.recentMessages
      .filter((m) => m.role === "assistant")
      .length;
    const historyBonus = recentRoles > 0 ? WEIGHTS.historyBonus * 0.5 : 0;

    // Failure penalty
    const recentFailuresForRole = context.recentFailures.filter(
      (f) => f.role === role && Date.now() - f.timestamp < 300_000, // 5 min window
    ).length;
    const failurePenalty = Math.max(
      WEIGHTS.failurePenaltyMax,
      recentFailuresForRole * WEIGHTS.failurePenaltyPerIncident,
    );

    // Expertise bonus
    const expertiseBonus = WEIGHTS.expertiseBonus[context.userExpertise];

    // Complexity match
    const complexityWeights = WEIGHTS.complexityMatch[context.taskComplexity] ?? {};
    const complexityMatch = complexityWeights[role] ?? 0;

    // Context fatigue
    const overThreshold = Math.max(0, context.cumulativeContextTokens - WEIGHTS.fatigueThreshold);
    const contextFatigue = Math.max(
      WEIGHTS.fatigueMax,
      Math.floor(overThreshold / 1000) * WEIGHTS.fatiguePenaltyPer1k,
    );

    // Time preference
    const timePreference = WEIGHTS.timePreference[context.timeOfDay];

    // Drift penalty
    const driftPenalty = context.isTopicContinuation ? 0 : WEIGHTS.driftPenalty;

    const totalScore =
      basePriority +
      historyBonus +
      failurePenalty +
      expertiseBonus +
      complexityMatch +
      contextFatigue +
      timePreference +
      driftPenalty;

    return {
      model: c.model,
      provider: c.provider,
      role,
      totalScore,
      breakdown: {
        basePriority,
        historyBonus,
        failurePenalty,
        expertiseBonus,
        complexityMatch,
        contextFatigue,
        timePreference,
        driftPenalty,
      },
    };
  });

  // Sort by total score descending
  scores.sort((a, b) => b.totalScore - a.totalScore);
  return scores;
}

// ─── Context Builder ───────────────────────────────────────────────────────

/**
 * Build a RoutingContext from raw inputs.
 * Called by the chat route before routing.
 */
export function buildRoutingContext(
  messages: Array<{ role: string; content: string }>,
  opts?: {
    recentFailures?: FailureRecord[];
    sessionPatterns?: PatternSignal[];
    cumulativeContextTokens?: number;
    isTopicContinuation?: boolean;
    consecutiveFailures?: number;
  },
): RoutingContext {
  const now = new Date();
  const hour = now.getHours();
  let timeOfDay: RoutingContext["timeOfDay"];
  if (hour >= 6 && hour < 12) timeOfDay = "morning";
  else if (hour >= 12 && hour < 18) timeOfDay = "afternoon";
  else if (hour >= 18 && hour < 22) timeOfDay = "evening";
  else timeOfDay = "night";

  // Infer expertise from message complexity
  const lastUserMsg = messages.filter((m) => m.role === "user").slice(-1)[0];
  const expertise = inferExpertise(lastUserMsg?.content ?? "");

  // Infer complexity from message length and keywords
  const complexity = inferComplexity(lastUserMsg?.content ?? "");

  return {
    recentMessages: messages.slice(-6),
    recentFailures: opts?.recentFailures ?? [],
    userExpertise: expertise,
    taskComplexity: complexity,
    activeTools: [],
    sessionPatterns: opts?.sessionPatterns ?? [],
    timeOfDay,
    cumulativeContextTokens: opts?.cumulativeContextTokens ?? estimateTokens(messages),
    isTopicContinuation: opts?.isTopicContinuation ?? false,
    consecutiveFailures: opts?.consecutiveFailures ?? 0,
  };
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function inferExpertise(message: string): "beginner" | "intermediate" | "expert" {
  const lower = message.toLowerCase();

  // Expert signals: technical terms, specific tool names, code patterns
  const expertPatterns = [
    /\b(implement|refactor|architect|optimize|concurrent|async|await)\b/,
    /\b(docker|kubernetes|terraform|webpack|vite|turbopack)\b/,
    /\b(typescript|rust|golang|python|java|c\+\+)\b/,
    /```[\s\S]{20,}```/, // code blocks
    /[{}\[\]();]/.source.length > 3, // code-like syntax
  ];

  const expertMatches = expertPatterns.filter((p) => {
    if (p instanceof RegExp) return p.test(lower);
    return false;
  }).length;

  if (expertMatches >= 2) return "expert";

  // Beginner signals: short messages, simple questions
  if (message.length < 30 && !/[?？]/.test(message)) return "beginner";
  if (/^(hi|hello|hey|你好|help|帮助)\b/i.test(message)) return "beginner";

  return "intermediate";
}

function inferComplexity(message: string): "simple" | "medium" | "complex" {
  const lower = message.toLowerCase();

  const complexKeywords = [
    "refactor", "重构", "architecture", "架构", "design", "设计",
    "implement", "实现", "build", "构建", "migrate", "迁移",
    "optimize", "优化", "debug", "调试", "investigate", "调查",
    "analyze", "分析", "compare", "比较", "evaluate", "评估",
  ];

  const matched = complexKeywords.filter((kw) => lower.includes(kw));
  if (matched.length >= 2) return "complex";
  if (matched.length === 1) return "medium";
  if (message.length > 200) return "medium";

  return "simple";
}

function estimateTokens(messages: Array<{ role: string; content: string }>): number {
  // Rough estimate: 1 token ≈ 4 chars for English, 2 chars for Chinese
  let total = 0;
  for (const msg of messages) {
    const chineseChars = (msg.content.match(/[\u4e00-\u9fff]/g) ?? []).length;
    const otherChars = msg.content.length - chineseChars;
    total += Math.ceil(chineseChars / 2) + Math.ceil(otherChars / 4);
  }
  return total;
}
