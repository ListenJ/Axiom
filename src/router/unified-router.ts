/**
 * Unified Router — Single entry point for all routing decisions.
 *
 * Replaces the fragmented routing across:
 * - model-router.ts (execute, chat, tool)
 * - intelligent-router.ts (keyword → complexity → model)
 * - intent-router.ts (keyword → agent)
 * - scene-router.ts (scene → tool)
 *
 * The UnifiedRouter chains:
 *   Keyword Match (0 cost) → Context Scoring → Strategy → Model Assignment
 *
 * Backward-compatible: delegates to existing router.executeWithRole().
 */

import { logger } from "../utils/logger.js";
import { router, type ChatMessage, type ChatResponse } from "./model-router.js";
import { assessComplexity } from "../agents/planning/index.js";
import { scoreCandidates, buildRoutingContext } from "./context-scorer.js";
import { applyStrategies, recordCircuitFailure, recordCircuitSuccess } from "./route-strategy.js";
import type { RoutingContext, RoutingSignal, FailureRecord, PatternSignal } from "./context-scorer.js";
import type { StrategyResult } from "./route-strategy.js";
import { assignModel, findModelsForRole, listAllRoles, type TaskRole } from "./model-capability-registry.js";
import { eventBus, worldState } from "../runtime/kernel.js";

// ─── Unified Routing Decision ──────────────────────────────────────────────

export interface UnifiedRoutingDecision {
  /** Selected role */
  role: TaskRole;
  /** Strategy that made the decision */
  strategy: string;
  /** Confidence (0-1) */
  confidence: number;
  /** Human-readable reason */
  reason: string;
  /** Thinking intensity */
  thinkingIntensity: "none" | "low" | "medium" | "high";
  /** Whether planning phase was invoked */
  planned: boolean;
  /** Routing latency in ms */
  latencyMs: number;
  /** Whether this was a fast-path (keyword) match */
  fastPath: boolean;
}

// ─── Keyword Fast-Path ─────────────────────────────────────────────────────

/**
 * Zero-cost keyword matching.  Returns a role if confidence > 0.8.
 * This is the same logic as intent-router.ts but unified.
 */
function keywordFastPath(input: string): { role: TaskRole; confidence: number } | null {
  const lower = input.toLowerCase().trim();

  // High-confidence patterns (exact match or strong signal)
  const patterns: Array<{ regex: RegExp; role: TaskRole; confidence: number }> = [
    // Code tasks
    { regex: /\b(refactor|重构)\b/i, role: "coding", confidence: 0.9 },
    { regex: /\b(code review|审查|code_review)\b/i, role: "review", confidence: 0.9 },
    { regex: /\b(implement|实现|write code|写代码)\b/i, role: "coding", confidence: 0.85 },
    { regex: /\b(debug|调试|fix bug|修复)\b/i, role: "coding", confidence: 0.85 },
    { regex: /\b(test|测试|unit test|单元测试)\b/i, role: "coding", confidence: 0.85 },

    // Architecture tasks
    { regex: /\b(architecture|架构|system design|系统设计)\b/i, role: "architecture", confidence: 0.9 },
    { regex: /\b(design pattern|设计模式|microservice|微服务)\b/i, role: "architecture", confidence: 0.85 },

    // Research tasks
    { regex: /\b(research|研究|investigate|调研)\b/i, role: "research", confidence: 0.85 },
    { regex: /\b(compare|比较|evaluate|评估|analyze|分析)\b/i, role: "research", confidence: 0.8 },

    // Decision tasks
    { regex: /\b(decide|决策|choose|选择|recommend|推荐)\b/i, role: "decision", confidence: 0.85 },

    // English/translation
    { regex: /\b(translate|翻译|english|英文)\b/i, role: "english", confidence: 0.9 },

    // Math
    { regex: /\b(math|数学|calculate|计算|equation|方程)\b/i, role: "math", confidence: 0.9 },
  ];

  for (const p of patterns) {
    if (p.regex.test(lower)) {
      return { role: p.role, confidence: p.confidence };
    }
  }

  // Check for greetings (general-chat)
  if (/^(hi|hello|hey|你好|嗨|早|晚安)\b/i.test(lower)) {
    return { role: "general-chat", confidence: 0.95 };
  }

  return null;
}

// ─── Unified Router ────────────────────────────────────────────────────────

class UnifiedRouter {
  /**
   * Route a user message to the optimal model/role.
   *
   * Pipeline:
   * 1. Keyword fast-path (0 cost, < 1ms)
   * 2. Context scoring (0 cost, < 5ms)
   * 3. Strategy selection (0 cost, < 5ms)
   * 4. Model assignment (0 cost, < 10ms)
   */
  async route(
    input: string,
    messages: ChatMessage[],
    opts?: {
      recentFailures?: FailureRecord[];
      sessionPatterns?: PatternSignal[];
      cumulativeContextTokens?: number;
      isTopicContinuation?: boolean;
      consecutiveFailures?: number;
      signal?: RoutingSignal;
    },
  ): Promise<UnifiedRoutingDecision> {
    const startTime = Date.now();

    // Step 1: Build routing context first (needed for guarded fast-path)
    const context = buildRoutingContext(messages, opts);

    // Step 2: Keyword fast-path with context guards
    // Inspired by MARCH (arXiv:2603.24579) — information asymmetry prevents
    // self-confirmation bias. Here, we check context before trusting keywords.
    const fastPath = keywordFastPath(input);
    if (fastPath && fastPath.confidence > 0.8) {
      // Guard: fall through to full scoring if context suggests keyword is misleading
      const roleFailures = context.recentFailures.filter((f) => f.role === fastPath.role);
      const hasDrift = opts?.signal?.patternDrift ?? false;
      const hasFatigue = opts?.signal?.fatigueIndicator ?? false;
      const consecutiveFails = context.consecutiveFailures;

      if (roleFailures.length === 0 && !hasDrift && !hasFatigue && consecutiveFails < 3) {
        const latencyMs = Date.now() - startTime;
        logger.info("[UnifiedRouter] Fast-path hit", {
          role: fastPath.role,
          confidence: fastPath.confidence,
          latencyMs,
        });
        return {
          role: fastPath.role,
          strategy: "keyword-fast-path",
          confidence: fastPath.confidence,
          reason: `Keyword match: ${fastPath.role}`,
          thinkingIntensity: "none",
          planned: false,
          latencyMs,
          fastPath: true,
        };
      }

      logger.info("[UnifiedRouter] Fast-path guarded (falling through)", {
        role: fastPath.role,
        roleFailures: roleFailures.length,
        hasDrift,
        hasFatigue,
        consecutiveFails,
      });
    }

    // Step 3: Score candidates
    const candidates = this.getCandidates();
    const scores = scoreCandidates(candidates, context);

    // Step 4: Apply strategies
    const strategyResult = applyStrategies(scores, context, opts?.signal);

    const latencyMs = Date.now() - startTime;

    logger.info("[UnifiedRouter] Routing decision", {
      role: strategyResult.role,
      strategy: strategyResult.strategy,
      confidence: strategyResult.confidence,
      thinkingIntensity: strategyResult.thinkingIntensity,
      latencyMs,
    });

    // Publish routing decision to Event Bus
    eventBus.publish({
      type: "routing.decision",
      source: "unified-router",
      data: {
        role: strategyResult.role,
        strategy: strategyResult.strategy,
        confidence: strategyResult.confidence,
        thinkingIntensity: strategyResult.thinkingIntensity,
        latencyMs,
      },
      priority: "normal",
    });

    // Update world state with routing decision
    worldState.set("routing.lastDecision", {
      timestamp: Date.now(),
      role: strategyResult.role,
      strategy: strategyResult.strategy,
      confidence: strategyResult.confidence,
    });

    return {
      role: strategyResult.role,
      strategy: strategyResult.strategy,
      confidence: strategyResult.confidence,
      reason: strategyResult.reason,
      thinkingIntensity: strategyResult.thinkingIntensity,
      planned: false,
      latencyMs,
      fastPath: false,
    };
  }

  /**
   * Execute a routed request.  Combines routing + execution.
   */
  async execute(
    input: string,
    messages: ChatMessage[],
    opts?: Parameters<typeof this.route>[2],
  ): Promise<ChatResponse & { routing: UnifiedRoutingDecision }> {
    const decision = await this.route(input, messages, opts);

    try {
      const result = await router.executeWithRole(decision.role, messages);
      recordCircuitSuccess(result.model);

      return {
        content: result.content,
        model: result.model,
        provider: result.provider,
        usage: result.usage,
        layer: "general" as const,
        routing: decision,
      };
    } catch (err) {
      recordCircuitFailure(decision.role);
      throw err;
    }
  }

  /**
   * Get all candidate roles for scoring from the real model registry.
   */
  private getCandidates(): Array<{ model: string; provider: string; role: TaskRole }> {
    const candidates: Array<{ model: string; provider: string; role: TaskRole }> = [];
    const seen = new Set<string>();

    for (const role of listAllRoles()) {
      const assignment = assignModel(role);
      if (assignment && !seen.has(assignment.model.id)) {
        seen.add(assignment.model.id);
        candidates.push({
          model: assignment.model.id,
          provider: assignment.model.provider,
          role,
        });
      }
    }

    return candidates;
  }
}

// ─── Singleton ─────────────────────────────────────────────────────────────

export const unifiedRouter = new UnifiedRouter();
