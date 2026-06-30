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
 *
 * 增强：支持过程性知识（Procedure）
 * - Steps（步骤序列）
 * - Checkpoints（检查点）
 * - Rollback（回滚策略）
 */

import { logger } from "../utils/logger.js";
import { eventBus } from "./kernel.js";
import { atomStore } from "./atom-engine.js";

// ─── Rule Types ────────────────────────────────────────────────────────────

export type RuleType = "inference" | "constraint" | "action" | "validation" | "routing" | "procedure";

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
  steps?: ProcedureStep[] // 过程性步骤 (for procedure type)
  version: number
  createdAt: number
  lastFired: number
  fireCount: number
  successCount: number
}

/**
 * Procedure Step — 过程性知识步骤
 */
export interface ProcedureStep {
  order: number
  action: string
  expected: string
  checkpoint?: string  // 检查点
  rollback?: string    // 回滚策略
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
   * Learn rules from successful patterns in memory.
   * Called periodically by the Tick Engine's reflect phase.
   */
  async learnFromMemory(): Promise<number> {
    try {
      const { memoryEngine } = await import("./memory-engine.js");
      const patterns = memoryEngine.getPatterns();
      let learned = 0;

      for (const pattern of patterns) {
        if (pattern.frequency >= 3 && pattern.confidence >= 0.7) {
          // Check if rule already exists for this pattern
          const existing = Array.from(this.rules.values())
            .some((r) => r.description.includes(pattern.id));
          if (existing) continue;

          // Learn a routing rule from the pattern
          this.learn(
            "inference",
            `pattern_${pattern.id}`,
            `frequency >= ${pattern.frequency}`,
            `save_to_memory`,
            `Pattern: ${pattern.description}`,
            pattern.confidence,
          );
          learned++;
        }
      }

      return learned;
    } catch {
      return 0;
    }
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
    // Enhanced condition evaluation
    try {
      // Parse condition: "key operator value"
      const match = rule.condition.match(/^(\w+)\s*(==|!=|contains|>|<|>=|<=|matches|in)\s*(.+)$/);
      if (!match) {
        return { rule, matched: false, reason: "Invalid condition format" };
      }

      const [, key, operator, value] = match;
      const contextValue = context[key];

      if (contextValue === undefined) {
        return { rule, matched: false, reason: `Missing context key: ${key}` };
      }

      let matched = false;
      const trimmedValue = value.trim();

      switch (operator) {
        case "==":
          matched = String(contextValue) === trimmedValue;
          break;
        case "!=":
          matched = String(contextValue) !== trimmedValue;
          break;
        case "contains":
          matched = String(contextValue).includes(trimmedValue);
          break;
        case ">":
          matched = Number(contextValue) > Number(trimmedValue);
          break;
        case "<":
          matched = Number(contextValue) < Number(trimmedValue);
          break;
        case ">=":
          matched = Number(contextValue) >= Number(trimmedValue);
          break;
        case "<=":
          matched = Number(contextValue) <= Number(trimmedValue);
          break;
        case "matches":
          matched = new RegExp(trimmedValue).test(String(contextValue));
          break;
        case "in":
          const values = trimmedValue.split(",").map((v) => v.trim());
          matched = values.includes(String(contextValue));
          break;
      }

      return { rule, matched, reason: matched ? "Condition satisfied" : "Condition not satisfied" };
    } catch (err) {
      return { rule, matched: false, reason: `Error: ${(err as Error).message}` };
    }
  }

  private executeRule(rule: Rule, context: Record<string, unknown>): unknown {
    const action = rule.action;
    const result: Record<string, unknown> = { rule: rule.name, action, dispatched: false };

    // Dispatch action to event bus so other modules can react
    eventBus.publish({
      type: "rule.action",
      source: "rule-engine",
      data: { ruleId: rule.id, ruleName: rule.name, action, context },
      priority: rule.priority > 50 ? "high" : "normal",
    });

    // Apply known action side-effects
    switch (action) {
      case "block_write_operations":
        result.dispatched = true;
        result.effect = "writes_blocked";
        eventBus.publish({
          type: "constraint.write_blocked",
          source: "rule-engine",
          data: { rule: rule.name, reason: rule.description },
          priority: "high",
        });
        break;

      case "retry_with_backoff":
        result.dispatched = true;
        result.effect = "retry_scheduled";
        eventBus.publish({
          type: "task.retry_requested",
          source: "rule-engine",
          data: { context, backoffMs: 1000 * (rule.fireCount + 1) },
          priority: "normal",
        });
        break;

      case "route_to_coding_role":
      case "route_to_research_role":
        result.dispatched = true;
        result.effect = "routed";
        eventBus.publish({
          type: "agent.route",
          source: "rule-engine",
          data: { action, context },
          priority: "normal",
        });
        break;

      case "validate_api_key":
        result.dispatched = true;
        result.effect = "validation_requested";
        eventBus.publish({
          type: "validation.api_key",
          source: "rule-engine",
          data: { context },
          priority: "high",
        });
        break;

      case "use_local_model":
        result.dispatched = true;
        result.effect = "local_model_preferred";
        eventBus.publish({
          type: "routing.local_model",
          source: "rule-engine",
          data: { context },
          priority: "normal",
        });
        break;

      case "save_to_memory":
        result.dispatched = true;
        result.effect = "memory_saved";
        eventBus.publish({
          type: "memory.save_requested",
          source: "rule-engine",
          data: { context },
          priority: "normal",
        });
        break;

      case "log_failure":
        result.dispatched = true;
        result.effect = "failure_logged";
        eventBus.publish({
          type: "memory.log_failure",
          source: "rule-engine",
          data: { context },
          priority: "normal",
        });
        break;

      case "validate_token_budget":
        result.dispatched = true;
        result.effect = "token_budget_checked";
        eventBus.publish({
          type: "validation.token_budget",
          source: "rule-engine",
          data: { context },
          priority: "normal",
        });
        break;

      case "check_model_health":
        result.dispatched = true;
        result.effect = "model_health_checked";
        eventBus.publish({
          type: "validation.model_health",
          source: "rule-engine",
          data: { context },
          priority: "normal",
        });
        break;

      case "stop_retrying":
        result.dispatched = true;
        result.effect = "retry_stopped";
        eventBus.publish({
          type: "task.retry_stopped",
          source: "rule-engine",
          data: { context },
          priority: "high",
        });
        break;

      case "abort_execution":
        result.dispatched = true;
        result.effect = "execution_aborted";
        eventBus.publish({
          type: "task.aborted",
          source: "rule-engine",
          data: { context },
          priority: "critical",
        });
        break;

      case "route_to_architecture_role":
        result.dispatched = true;
        result.effect = "routed";
        eventBus.publish({
          type: "agent.route",
          source: "rule-engine",
          data: { action: "architecture", context },
          priority: "normal",
        });
        break;

      default:
        // Unknown action — still publish for potential listeners
        result.dispatched = false;
        result.effect = "unhandled";
        break;
    }

    return result;
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

  // Additional inference rules
  ruleEngine.addRule({
    type: "inference",
    name: "debug-task-detection",
    description: "Detect debugging tasks",
    condition: "intent == debug",
    action: "route_to_coding_role",
    priority: 10,
    confidence: 0.9,
    source: "predefined",
  });

  ruleEngine.addRule({
    type: "inference",
    name: "test-task-detection",
    description: "Detect testing tasks",
    condition: "intent == test",
    action: "route_to_coding_role",
    priority: 10,
    confidence: 0.9,
    source: "predefined",
  });

  ruleEngine.addRule({
    type: "inference",
    name: "architecture-task-detection",
    description: "Detect architecture tasks",
    condition: "intent == architecture",
    action: "route_to_architecture_role",
    priority: 10,
    confidence: 0.9,
    source: "predefined",
  });

  // Action rules
  ruleEngine.addRule({
    type: "action",
    name: "auto-save-on-success",
    description: "Auto-save successful results to memory",
    condition: "success == true",
    action: "save_to_memory",
    priority: 3,
    confidence: 0.7,
    source: "predefined",
  });

  ruleEngine.addRule({
    type: "action",
    name: "log-on-failure",
    description: "Log failures for learning",
    condition: "success == false",
    action: "log_failure",
    priority: 5,
    confidence: 0.9,
    source: "predefined",
  });

  // Validation rules
  ruleEngine.addRule({
    type: "validation",
    name: "check-token-budget",
    description: "Check token budget before expensive operations",
    condition: "complexity == complex",
    action: "validate_token_budget",
    priority: 40,
    confidence: 0.8,
    source: "predefined",
  });

  ruleEngine.addRule({
    type: "validation",
    name: "check-model-availability",
    description: "Check model availability before routing",
    condition: "provider != internal",
    action: "check_model_health",
    priority: 45,
    confidence: 0.9,
    source: "predefined",
  });

  // Constraint rules
  ruleEngine.addRule({
    type: "constraint",
    name: "max-retries",
    description: "Limit retry attempts",
    condition: "retries >= 3",
    action: "stop_retrying",
    priority: 100,
    confidence: 1.0,
    source: "predefined",
  });

  ruleEngine.addRule({
    type: "constraint",
    name: "timeout-enforcement",
    description: "Enforce execution timeout",
    condition: "latency > 30000",
    action: "abort_execution",
    priority: 90,
    confidence: 1.0,
    source: "predefined",
  });

  logger.info("[RuleEngine] Initialized predefined rules");
}
