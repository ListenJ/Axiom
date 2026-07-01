/**
 * Consciousness Module — Shared Types
 *
 * Lightweight type contracts for the self-reflection module.
 * All types are pure data; no methods, no business logic.
 */

// ─── Self State ────────────────────────────────────────────────────────────

/** A belief about the world — confidence-weighted proposition. */
export interface Belief {
  /** Unique belief identifier. */
  id: string;
  /** Proposition content (e.g. "User is debugging a Git conflict"). */
  proposition: string;
  /** Confidence in this belief (0-1). */
  confidence: number;
  /** Evidence supporting this belief. */
  supportingEvidence: string[];
  /** Evidence contradicting this belief. */
  contradictingEvidence: string[];
  /** When this belief was first formed. */
  formedAt: number;
  /** When this belief was last updated. */
  updatedAt: number;
  /** Belief status. */
  status: "active" | "weakened" | "strengthened" | "retracted";
}

/** Mental dimension of world state — what the agent thinks, wants, and believes. */
export interface MentalState {
  /** Current intent (what the agent is trying to do right now). */
  currentIntent: string;
  /** Active goals (what the agent wants to achieve). */
  goals: Array<{ id: string; description: string; priority: number; status: "active" | "achieved" | "abandoned" }>;
  /** Active beliefs about the world. */
  beliefs: Belief[];
  /** Hypotheses being tested. */
  activeHypotheses: string[];
  /** Current mood (from reflection). */
  mood: string;
}

/** Mutable self-state the consciousness loop reads/writes via the Blackboard. */
export interface SelfState {
  /** Last time the agent received user input (epoch ms). */
  lastUserActivityAt: number;
  /** Last time a reflection cycle completed (epoch ms). */
  lastReflectionAt: number;
  /** Cumulative tokens spent in reflection since process start. */
  tokensSpentThisSession: number;
  /** Topics that recently dominated user input. */
  recentFocus: string[];
  /** Counters per (intent, agentName) tuple — used by SkillPromoter. */
  patternCounts: Record<string, number>;
  /** Last 3 insight notes written by MemoryCurator. */
  recentInsights: string[];
  /** Free-form mood string the LLM itself produced (or "neutral"). */
  mood: string;
  /** Free-form 1-sentence goal, refreshed each reflection. */
  nextGoal: string;
  /** Mental state — beliefs, goals, intent (v2.9.1 cognitive enhancement). */
  mental: MentalState;
}

/** Fresh / default self-state. */
export const EMPTY_SELF_STATE: SelfState = {
  lastUserActivityAt: 0,
  lastReflectionAt: 0,
  tokensSpentThisSession: 0,
  recentFocus: [],
  patternCounts: {},
  recentInsights: [],
  mood: "neutral",
  nextGoal: "Observe system and wait for first user signal.",
  mental: {
    currentIntent: "observe",
    goals: [],
    beliefs: [],
    activeHypotheses: [],
    mood: "neutral",
  },
};

// ─── Triggers ─────────────────────────────────────────────────────────────

export type ReflectionTrigger =
  | { kind: "idle"; idleMs: number }
  | { kind: "schedule"; cron: string }
  | { kind: "token-budget"; tokensUsed: number; budget: number }
  | { kind: "manual"; reason?: string }
  | { kind: "blackboard-signal"; key: string };

export interface TriggerConfig {
  /** Trigger when no user activity for this many ms. */
  idleThresholdMs: number;
  /** Trigger when cumulative reflection tokens exceed this count. */
  tokenBudget: number;
  /** Cron expression (Bun.cron syntax) for periodic reflection. */
  scheduleCron: string;
  /** Disable the module entirely. */
  enabled: boolean;
}

export const DEFAULT_TRIGGER_CONFIG: TriggerConfig = {
  idleThresholdMs: 15 * 60 * 1000,   // 15 min idle
  tokenBudget: 50_000,                // ~50k tokens per session
  scheduleCron: "0 */6 * * *",        // every 6h
  enabled: true,
};

// ─── Reflection Cycle Outputs ─────────────────────────────────────────────

export interface ReflectionOutcome {
  trigger: ReflectionTrigger;
  startedAt: number;
  finishedAt: number;
  durationMs: number;
  tokensUsed: number;
  /** Skill ids newly promoted to the registry this cycle. */
  promotedSkillIds: string[];
  /** Note paths newly created/updated by the curator. */
  curatorNotePaths: string[];
  /** Number of memory artifacts archived by the curator. */
  archivedCount: number;
  /** LLM's own 1-sentence summary of this reflection. */
  summary: string;
  /** Set when the cycle aborted early (e.g. no models available). */
  abortedReason?: string;
}

// ─── Skill Promotion Candidate ────────────────────────────────────────────

/** A frequent (intent, agentName) pattern the promoter may crystallize. */
export interface PatternCandidate {
  /** Stable key — usually `intent|agentName`. */
  key: string;
  intent: string;
  agentName: string;
  count: number;
  /** Window the count was measured over (ms). */
  windowMs: number;
  /** Example user inputs the LLM saw, for Hermes prompt context. */
  sampleInputs: string[];
}
