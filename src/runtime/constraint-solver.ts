/**
 * Constraint Solver — 围绕约束推理
 *
 * 整个系统以后应该围绕 Constraint 推理，而不是 Graph。
 *
 * 约束类型：
 * - requires: A requires B（A 依赖 B）
 * - prohibits: A prohibits B（A 禁止 B）
 * - enables: A enables B（A 启用 B）
 * - conflicts: A conflicts B（A 与 B 冲突）
 * - excludes: A excludes B（A 与 B 互斥）
 *
 * 多维约束：
 * - resource: 资源约束 (GPU, 内存, Token)
 * - semantic: 语义约束 (用户意图, 上下文)
 * - policy: 策略约束 (生产环境保护, 安全策略)
 * - temporal: 时间约束 (截止日期, 超时)
 *
 * 约束求解：
 * - 给定一组实体和约束
 * - 判断约束是否满足
 * - 如果不满足，给出修复建议
 */

import { logger } from "../utils/logger.js";
import { eventBus, worldState } from "./kernel.js";
import { atomStore } from "./atom-engine.js";

// ─── Constraint Types ──────────────────────────────────────────────────────

export type ConstraintType = "requires" | "prohibits" | "enables" | "conflicts" | "excludes";
export type ConstraintDimension = "logical" | "resource" | "semantic" | "policy" | "temporal";

export interface Constraint {
  id: string
  type: ConstraintType
  dimension: ConstraintDimension  // 约束维度
  source: string      // 实体 ID 或名称
  target: string      // 实体 ID 或名称
  condition?: string  // 可选条件表达式
  confidence: number  // 0-1
  evidence: string    // 约束来源
  createdAt: number
}

export interface ConstraintViolation {
  constraint: Constraint
  message: string
  severity: "low" | "medium" | "high" | "critical"
  suggestion?: string
}

export interface SolveResult {
  satisfied: boolean
  violations: ConstraintViolation[]
  suggestions: string[]
  checkedConstraints: number
}

// ─── Constraint Store ──────────────────────────────────────────────────────

class ConstraintSolverImpl {
  private constraints = new Map<string, Constraint>();
  private stats = { solved: 0, violations: 0, resolved: 0 };

  /**
   * Add a constraint.
   */
  addConstraint(constraint: Omit<Constraint, "id" | "createdAt">): Constraint {
    const id = `constraint_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const full: Constraint = {
      ...constraint,
      id,
      createdAt: Date.now(),
    };

    this.constraints.set(id, full);

    // Also store as atom for knowledge network
    atomStore.create("constraint", `${constraint.source} ${constraint.type} ${constraint.target}`, {
      source: "constraint-solver",
      metadata: {
        constraintType: constraint.type,
        sourceEntity: constraint.source,
        targetEntity: constraint.target,
        confidence: constraint.confidence,
      },
    });

    eventBus.publish({
      type: "constraint.added",
      source: "constraint-solver",
      data: { id, type: constraint.type, source: constraint.source, target: constraint.target },
      priority: "normal",
    });

    return full;
  }

  /**
   * Remove a constraint.
   */
  removeConstraint(id: string): boolean {
    return this.constraints.delete(id);
  }

  /**
   * Solve constraints for a given set of entities.
   * Returns satisfied=true if all constraints are met.
   */
  solve(entities: string[], context?: Record<string, unknown>): SolveResult {
    this.stats.solved++;
    const violations: ConstraintViolation[] = [];
    const suggestions: string[] = [];

    for (const constraint of this.constraints.values()) {
      // Check if constraint applies to the given entities
      const sourcePresent = entities.includes(constraint.source);
      const targetPresent = entities.includes(constraint.target);

      if (!sourcePresent && !targetPresent) continue;

      // Evaluate conditional expression if present
      if (constraint.condition && context) {
        const conditionMet = this.evaluateCondition(constraint.condition, context);
        if (!conditionMet) continue; // Skip constraint if condition not met
      }

      switch (constraint.type) {
        case "requires": {
          // Source requires Target
          if (sourcePresent && !targetPresent) {
            violations.push({
              constraint,
              message: `${constraint.source} requires ${constraint.target}, but ${constraint.target} is not present`,
              severity: "high",
              suggestion: `Add ${constraint.target} to the execution context`,
            });
            suggestions.push(`Add ${constraint.target}`);
          }
          break;
        }

        case "prohibits": {
          // Source prohibits Target
          if (sourcePresent && targetPresent) {
            violations.push({
              constraint,
              message: `${constraint.source} prohibits ${constraint.target}, but both are present`,
              severity: "critical",
              suggestion: `Remove ${constraint.target} or use a different approach`,
            });
            suggestions.push(`Remove ${constraint.target}`);
          }
          break;
        }

        case "conflicts": {
          // Source conflicts with Target
          if (sourcePresent && targetPresent) {
            violations.push({
              constraint,
              message: `${constraint.source} conflicts with ${constraint.target}`,
              severity: "high",
              suggestion: `Choose one, not both`,
            });
            suggestions.push(`Choose between ${constraint.source} and ${constraint.target}`);
          }
          break;
        }

        case "excludes": {
          // Source excludes Target (mutually exclusive)
          if (sourcePresent && targetPresent) {
            violations.push({
              constraint,
              message: `${constraint.source} and ${constraint.target} are mutually exclusive`,
              severity: "high",
              suggestion: `Use only one of them`,
            });
          }
          break;
        }

        case "enables": {
          // Source enables Target (informational, not a violation)
          if (sourcePresent && !targetPresent) {
            suggestions.push(`${constraint.source} enables ${constraint.target} — consider adding it`);
          }
          break;
        }
      }
    }

    this.stats.violations += violations.length;

    const result: SolveResult = {
      satisfied: violations.length === 0,
      violations,
      suggestions,
      checkedConstraints: this.constraints.size,
    };

    // Publish solve event
    eventBus.publish({
      type: "constraint.solved",
      source: "constraint-solver",
      data: {
        satisfied: result.satisfied,
        violationCount: violations.length,
        entities,
      },
      priority: result.satisfied ? "low" : "high",
    });

    // Update world state
    worldState.set("constraints.lastSolve", {
      timestamp: Date.now(),
      satisfied: result.satisfied,
      violationCount: violations.length,
    });

    return result;
  }

  /**
   * Check if a specific constraint is satisfied.
   */
  check(constraintId: string, entities: string[]): boolean {
    const constraint = this.constraints.get(constraintId);
    if (!constraint) return true;

    const result = this.solve(entities);
    return !result.violations.some((v) => v.constraint.id === constraintId);
  }

  /**
   * Evaluate a condition string against context.
   * Supports: "key == value", "key != value", "key > value", "key < value", "key contains value"
   */
  private evaluateCondition(condition: string, context: Record<string, unknown>): boolean {
    try {
      // Parse "key operator value" patterns
      const operators = ["==", "!=", ">=", "<=", ">", "<", "contains"];
      for (const op of operators) {
        const idx = condition.indexOf(op);
        if (idx > 0) {
          const left = condition.slice(0, idx).trim();
          const right = condition.slice(idx + op.length).trim().replace(/['"]/g, "");
          const contextValue = context[left];
          const rightNum = Number(right);

          switch (op) {
            case "==": return String(contextValue) === right;
            case "!=": return String(contextValue) !== right;
            case ">": return Number(contextValue) > rightNum;
            case "<": return Number(contextValue) < rightNum;
            case ">=": return Number(contextValue) >= rightNum;
            case "<=": return Number(contextValue) <= rightNum;
            case "contains": return String(contextValue).includes(right);
          }
        }
      }
      return true; // If condition can't be parsed, assume met
    } catch {
      return true; // On error, assume condition is met
    }
  }

  /**
   * Get all constraints for an entity.
   */
  getConstraintsFor(entity: string): Constraint[] {
    const result: Constraint[] = [];
    for (const c of this.constraints.values()) {
      if (c.source === entity || c.target === entity) {
        result.push(c);
      }
    }
    return result;
  }

  /**
   * Get all constraints of a specific type.
   */
  getConstraintsByType(type: ConstraintType): Constraint[] {
    const result: Constraint[] = [];
    for (const c of this.constraints.values()) {
      if (c.type === type) result.push(c);
    }
    return result;
  }

  /**
   * Get all constraints of a specific dimension.
   */
  getConstraintsByDimension(dimension: ConstraintDimension): Constraint[] {
    const result: Constraint[] = [];
    for (const c of this.constraints.values()) {
      if (c.dimension === dimension) result.push(c);
    }
    return result;
  }

  /**
   * Learn a constraint from observation.
   */
  learn(source: string, type: ConstraintType, target: string, evidence: string, confidence = 0.8, dimension: ConstraintDimension = "logical"): Constraint {
    logger.info("[ConstraintSolver] Learning constraint", { source, type, target, confidence, dimension });
    this.stats.resolved++;
    return this.addConstraint({ type, dimension, source, target, confidence, evidence });
  }

  /**
   * Get stats.
   */
  getStats(): { total: number; solved: number; violations: number; resolved: number } {
    return { total: this.constraints.size, ...this.stats };
  }
}

export const constraintSolver = new ConstraintSolverImpl();

// ─── Predefined Constraints ────────────────────────────────────────────────

/**
 * Initialize common constraints.
 */
export function initConstraints(): void {
  // Tool constraints
  constraintSolver.addConstraint({ type: "requires", source: "terminal_exec", target: "shell", confidence: 1.0, evidence: "System requirement" });
  constraintSolver.addConstraint({ type: "requires", source: "code_diagnostics", target: "typescript", confidence: 0.9, evidence: "TypeScript compiler needed" });
  constraintSolver.addConstraint({ type: "requires", source: "git_status", target: "git", confidence: 1.0, evidence: "Git binary required" });
  constraintSolver.addConstraint({ type: "prohibits", source: "plan_mode", target: "fs_write", confidence: 1.0, evidence: "Plan mode is read-only" });
  constraintSolver.addConstraint({ type: "prohibits", source: "plan_mode", target: "terminal_exec", confidence: 1.0, evidence: "Plan mode is read-only" });

  // Model constraints
  constraintSolver.addConstraint({ type: "requires", source: "deep_research", target: "high_context_model", confidence: 0.9, evidence: "Deep research needs large context" });
  constraintSolver.addConstraint({ type: "conflicts", source: "local_model", target: "cloud_model", confidence: 0.7, evidence: "Cannot use both simultaneously" });

  // Agent constraints
  constraintSolver.addConstraint({ type: "requires", source: "hermes", target: "hermes_installation", confidence: 1.0, evidence: "Hermes must be installed" });
  constraintSolver.addConstraint({ type: "requires", source: "opencode", target: "opencode_installation", confidence: 1.0, evidence: "OpenCode must be installed" });

  logger.info("[ConstraintSolver] Initialized predefined constraints");
}
