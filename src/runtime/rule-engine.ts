/**
 * Rule Engine — Rule 也是 Knowledge
 *
 * Rule 不要写死。Rule 本身就是 Entity。
 * Runtime 可以学习 Rule。
 *
 * Rule 结构：
 * - Condition（条件）
 * - Action（动作）
 * - Priority（优先级）
 * - Confidence（置信度）
 * - Source（来源）
 */

import { logger } from "../utils/logger.js";
import { eventBus, worldState } from "./kernel.js";
import { atomStore } from "./atom-engine.js";

// ─── Rule Types ────────────────────────────────────────────────────────────

export type RuleType = "inference" | "constraint" | "action" | "validation" | "routing";

export interface Rule {
  id: string
  type: RuleType
  name: string
  description: string
  condition: string      // 条件表达式
  action: string         // 动作描述
  priority: number       // 越高越优先
  confidence: number     // 0-1
  source: string         // 来源
  version: number
  createdAt: number
  lastFired: number
  fireCount: number
  successCount: number
}

export interface RuleMatch {
  rule: Rule
  matched: boolean
  reason: string
}

export interface RuleExecutionResult {
  fired: Rule[]
  results: unknown[]
  errors: string[]
}

// ─── Rule Engine ───────────────────────────────────────────────────────────

class RuleEngineImpl {
  private rules = new Map<string, Rule>();
  private stats = { evaluated: 0, fired: 0, learned: 0 };

  /**
   * Add a rule.
   */
  addRule(rule: Omit<Rule, "id" | "version" | "createdAt" | "lastFired" | "fireCount" | "successCount">): Rule {
    const id = `rule_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const full: Rule = {
      ...rule,
      id,
      version: 1,
      createdAt: Date.now(),
      lastFired: 0,
      fireCount: 0,
      successCount: 0,
    };

    this.rules.set(id, full);

    // Store as atom
    atomStore.create("rule", rule.name, {
      source: rule.source,
      confidence: rule.confidence > 0.8 ? "certain" : "inferred",
      metadata: { ruleId: id, ruleType: rule.type },
    });

    eventBus.publish({
      type: "rule.added",
      source: "rule-engine",
      data: { id, type: rule.type, name: rule.name },
      priority: "low",
    });

    return full;
  }

  /**
   * Evaluate all rules against a context.
   */
  evaluate(context: Record<string, unknown>): RuleMatch[] {
    this.stats.evaluated++;
    const matches: RuleMatch[] = [];

    // Sort by priority (highest first)
    const sorted = Array.from(this.rules.values()).sort((a, b) => b.priority - a.priority);

    for (const rule of sorted) {
      const match = this.evaluateRule(rule, context);
      if (match.matched) {
        matches.push(match);
      }
    }

    return matches;
  }

  /**
   * Execute all matching rules.
   */
  execute(context: Record<string, unknown>): RuleExecutionResult {
    const matches = this.evaluate(context);
    const fired: Rule[] = [];
    const results: unknown[] = [];
    const errors: string[] = [];

    for (const match of matches) {
      try {
        // Execute the rule action
        const result = this.executeRule(match.rule, context);
        results.push(result);

        // Update rule stats
        match.rule.lastFired = Date.now();
        match.rule.fireCount++;
        match.rule.successCount++;
        fired.push(match.rule);
        this.stats.fired++;

        eventBus.publish({
          type: "rule.fired",
          source: "rule-engine",
          data: { id: match.rule.id, name: match.rule.name, type: match.rule.type },
          priority: "normal",
        });
      } catch (err) {
        errors.push(`Rule ${match.rule.name}: ${(err as Error).message}`);
        match.rule.fireCount++;
      }
    }

    return { fired, results, errors };
  }

  /**
   * Learn a new rule from observation.
   */
  learn(type: RuleType, name: string, condition: string, action: string, evidence: string, confidence = 0.7): Rule {
    this.stats.learned++;
    logger.info("[RuleEngine] Learning rule", { type, name, confidence });

    return this.addRule({
      type,
      name,
      description: `Learned from: ${evidence}`,
      condition,
      action,
      priority: 0,
      confidence,
      source: "learned",
    });
  }

  /**
   * Get all rules.
   */
  list(): Rule[] {
    return Array.from(this.rules.values());
  }

  /**
   * Get rules by type.
   */
  listByType(type: RuleType): Rule[] {
    return Array.from(this.rules.values()).filter((r) => r.type === type);
  }

  /**
   * Remove a rule.
   */
  remove(id: string): boolean {
    return this.rules.delete(id);
  }

  /**
   * Get stats.
   */
  getStats(): { total: number; evaluated: number; fired: number; learned: number } {
    return { total: this.rules.size, ...this.stats };
  }

  // ─── Private ─────────────────────────────────────────────────────

  private evaluateRule(rule: Rule, context: Record<string, unknown>): RuleMatch {
    // Simple condition evaluation
    try {
      // Parse condition: "key operator value"
      const match = rule.condition.match(/^(\w+)\s*(==|!=|contains)\s*(.+)$/);
      if (!match) {
        return { rule, matched: false, reason: "Invalid condition format" };
      }

      const [, key, operator, value] = match;
      const contextValue = context[key];

      if (contextValue === undefined) {
        return { rule, matched: false, reason: `Missing context key: ${key}` };
      }

      let matched = false;
      switch (operator) {
        case "==":
          matched = String(contextValue) === value.trim();
          break;
        case "!=":
          matched = String(contextValue) !== value.trim();
          break;
        case "contains":
          matched = String(contextValue).includes(value.trim());
          break;
      }

      return { rule, matched, reason: matched ? "Condition satisfied" : "Condition not satisfied" };
    } catch (err) {
      return { rule, matched: false, reason: `Error: ${(err as Error).message}` };
    }
  }

  private matchCondition(condition: string, context: Record<string, unknown>): boolean {
    // Simple condition matching
    // Format: "key operator value"
    const parts = condition.split(/\s+(?:==|!=|>|<|>=|<=|contains|matches)\s+/);
    if (parts.length !== 2) return false;

    const [left, right] = parts.map((p) => p.trim());
    const leftValue = context[left];
    const rightValue = right.replace(/['"]/g, "");

    // Simple equality check
    if (condition.includes("==")) return String(leftValue) === rightValue;
    if (condition.includes("!=")) return String(leftValue) !== rightValue;
    if (condition.includes("contains")) return String(leftValue).includes(rightValue);

    return false;
  }

  private executeRule(rule: Rule, context: Record<string, unknown>): unknown {
    // Simple action execution
    // In production, this would be a proper action executor
    return { rule: rule.name, action: rule.action, context };
  }
}

export const ruleEngine = new RuleEngineImpl();

// ─── Predefined Rules ─────────────────────────────────────────────────────

/**
 * Initialize common rules.
 */
export function initRules(): void {
  // Inference rules
  ruleEngine.addRule({
    type: "inference",
    name: "code-task-detection",
    description: "Detect code-related tasks",
    condition: "intent == code",
    action: "route_to_coding_role",
    priority: 10,
    confidence: 0.9,
    source: "predefined",
  });

  ruleEngine.addRule({
    type: "inference",
    name: "research-task-detection",
    description: "Detect research tasks",
    condition: "intent == research",
    action: "route_to_research_role",
    priority: 10,
    confidence: 0.9,
    source: "predefined",
  });

  // Constraint rules
  ruleEngine.addRule({
    type: "constraint",
    name: "plan-mode-read-only",
    description: "Plan mode only allows read operations",
    condition: "mode == plan",
    action: "block_write_operations",
    priority: 100,
    confidence: 1.0,
    source: "predefined",
  });

  // Action rules
  ruleEngine.addRule({
    type: "action",
    name: "auto-retry-on-failure",
    description: "Retry failed operations",
    condition: "success == false",
    action: "retry_with_backoff",
    priority: 5,
    confidence: 0.8,
    source: "predefined",
  });

  // Validation rules
  ruleEngine.addRule({
    type: "validation",
    name: "check-api-key",
    description: "Check API key before external calls",
    condition: "provider != internal",
    action: "validate_api_key",
    priority: 50,
    confidence: 1.0,
    source: "predefined",
  });

  // Routing rules
  ruleEngine.addRule({
    type: "routing",
    name: "use-local-first",
    description: "Prefer local models when available",
    condition: "complexity == simple",
    action: "use_local_model",
    priority: 20,
    confidence: 0.8,
    source: "predefined",
  });

  logger.info("[RuleEngine] Initialized predefined rules");
}
