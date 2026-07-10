/**
 * 多维约束求解器 (Multi-Dimensional Constraint Solver)
 *
 * 解决"约束求解器维度单一"问题:
 * 原实现仅支持逻辑依赖 (requires/prohibits/enables/conflicts/excludes)
 * 新增支持: 物理(GPU/内存)、语义(用户意图)、策略(生产环境) 约束
 *
 * 约束维度:
 * - logical:  逻辑依赖 (A requires B, A conflicts B)
 * - physical: 物理资源 (GPU VRAM >= 500MB, disk >= 1GB)
 * - field_match: 字段匹配约束 (field == value, field != value, field in set)
 * - policy:   策略约束 (environment != "production", security_level >= 2)
 * - temporal: 时间约束 (time_of_day between 9-17, day_of_week != "sunday")
 */

import { logger } from "../../utils/logger.js";

// ========== 类型定义 ==========

/** 约束维度 */
export type ConstraintDimension = "logical" | "physical" | "field_match" | "policy" | "temporal";

/** 约束类型 */
export type ConstraintType =
  | "requires"     // A requires B (A 必须有 B 才能执行)
  | "prohibits"    // A prohibits B (A 禁止 B)
  | "enables"      // A enables B (A 使能 B)
  | "conflicts"    // A conflicts B (A 和 B 不能同时存在)
  | "excludes"     // A excludes B (A 排斥 B)
  | "min_value"    // 属性 >= 最小值
  | "max_value"    // 属性 <= 最大值
  | "equals"       // 属性 == 值
  | "not_equals"   // 属性 != 值
  | "in_set"       // 属性在集合中
  | "not_in_set"   // 属性不在集合中
  | "between";     // 属性在范围内

/** 约束定义 */
export interface Constraint {
  id: string;
  /** 约束维度 */
  dimension: ConstraintDimension;
  /** 约束类型 */
  type: ConstraintType;
  /** 约束名称 */
  name: string;
  /** 约束描述 */
  description: string;
  /** 约束主体 (动作/资源/实体) */
  subject: string;
  /** 约束目标 (另一个动作/资源/实体，或属性值) */
  target?: string;
  /** 约束参数 (用于 min_value/max_value/between 等) */
  params?: Record<string, unknown>;
  /** 约束优先级 (越高越重要) */
  priority: number;
  /** 是否启用 */
  enabled: boolean;
  /** 创建时间 */
  createdAt: number;
}

/** 约束检查结果 */
export interface ConstraintCheckResult {
  /** 是否满足所有约束 */
  satisfied: boolean;
  /** 违反的约束 */
  violations: ConstraintViolation[];
  /** 满足的约束 */
  satisfiedConstraints: string[];
  /** 建议 (如何修复违反) */
  suggestions: string[];
}

/** 约束违反 */
export interface ConstraintViolation {
  /** 违反的约束 ID */
  constraintId: string;
  /** 约束名称 */
  constraintName: string;
  /** 约束维度 */
  dimension: ConstraintDimension;
  /** 违反原因 */
  reason: string;
  /** 严重程度 (1-10) */
  severity: number;
  /** 修复建议 */
  suggestion: string;
}

// ========== 约束求解器 ==========

export class ConstraintSolver {
  private constraints = new Map<string, Constraint>();
  private context: Record<string, unknown> = {};

  /**
   * 注册约束
   */
  register(constraint: Constraint): void {
    this.constraints.set(constraint.id, constraint);
    logger.info("[ConstraintSolver] Registered constraint", {
      id: constraint.id,
      dimension: constraint.dimension,
      type: constraint.type,
    });
  }

  /**
   * 批量注册约束
   */
  registerAll(constraints: Constraint[]): void {
    for (const c of constraints) this.register(c);
  }

  /**
   * 移除约束
   */
  unregister(constraintId: string): boolean {
    return this.constraints.delete(constraintId);
  }

  /**
   * 更新上下文 (当前环境状态)
   */
  updateContext(key: string, value: unknown): void {
    this.context[key] = value;
  }

  /**
   * 批量更新上下文
   */
  updateContextBulk(ctx: Record<string, unknown>): void {
    Object.assign(this.context, ctx);
  }

  /**
   * 检查单个动作是否满足所有约束
   */
  check(action: string, additionalContext?: Record<string, unknown>): ConstraintCheckResult {
    const ctx = { ...this.context, ...additionalContext };
    const violations: ConstraintViolation[] = [];
    const satisfied: string[] = [];
    const suggestions: string[] = [];

    for (const constraint of this.constraints.values()) {
      if (!constraint.enabled) continue;

      const result = this.evaluateConstraint(constraint, action, ctx);
      if (result.satisfied) {
        satisfied.push(constraint.id);
      } else {
        violations.push({
          constraintId: constraint.id,
          constraintName: constraint.name,
          dimension: constraint.dimension,
          reason: result.reason,
          severity: this.calculateSeverity(constraint),
          suggestion: result.suggestion,
        });
        suggestions.push(result.suggestion);
      }
    }

    return {
      satisfied: violations.length === 0,
      violations,
      satisfiedConstraints: satisfied,
      suggestions: [...new Set(suggestions)],
    };
  }

  /**
   * 从候选动作中选择满足约束的最佳动作
   */
  selectBest(candidates: string[], additionalContext?: Record<string, unknown>): {
    selected: string | null;
    results: Array<{ action: string; check: ConstraintCheckResult }>;
  } {
    const results = candidates.map((action) => ({
      action,
      check: this.check(action, additionalContext),
    }));

    // 按违反数量和严重程度排序
    results.sort((a, b) => {
      if (a.check.violations.length !== b.check.violations.length) {
        return a.check.violations.length - b.check.violations.length;
      }
      const aSeverity = a.check.violations.reduce((sum, v) => sum + v.severity, 0);
      const bSeverity = b.check.violations.reduce((sum, v) => sum + v.severity, 0);
      return aSeverity - bSeverity;
    });

    const best = results[0];
    const selected = best && best.check.satisfied ? best.action : null;

    return { selected, results };
  }

  /**
   * 获取所有约束
   */
  list(): Constraint[] {
    return Array.from(this.constraints.values());
  }

  /**
   * 按维度获取约束
   */
  listByDimension(dimension: ConstraintDimension): Constraint[] {
    return Array.from(this.constraints.values()).filter(
      (c) => c.dimension === dimension
    );
  }

  /**
   * 获取当前上下文
   */
  getContext(): Record<string, unknown> {
    return { ...this.context };
  }

  /**
   * 求解统计
   */
  getStats(): {
    total: number;
    byDimension: Record<string, number>;
    byType: Record<string, number>;
    enabled: number;
    disabled: number;
  } {
    const byDimension: Record<string, number> = {};
    const byType: Record<string, number> = {};
    let enabled = 0;
    let disabled = 0;

    for (const c of this.constraints.values()) {
      byDimension[c.dimension] = (byDimension[c.dimension] || 0) + 1;
      byType[c.type] = (byType[c.type] || 0) + 1;
      if (c.enabled) enabled++; else disabled++;
    }

    return {
      total: this.constraints.size,
      byDimension,
      byType,
      enabled,
      disabled,
    };
  }

  // ========== 私有方法 ==========

  private evaluateConstraint(
    constraint: Constraint,
    action: string,
    ctx: Record<string, unknown>
  ): { satisfied: boolean; reason: string; suggestion: string } {
    switch (constraint.dimension) {
      case "logical":
        return this.evaluateLogical(constraint, action, ctx);
      case "physical":
        return this.evaluatePhysical(constraint, action, ctx);
      case "field_match":
        return this.evaluateFieldMatch(constraint, action, ctx);
      case "policy":
        return this.evaluatePolicy(constraint, action, ctx);
      case "temporal":
        return this.evaluateTemporal(constraint, action, ctx);
      default:
        return { satisfied: true, reason: "", suggestion: "" };
    }
  }

  private evaluateLogical(
    constraint: Constraint,
    action: string,
    ctx: Record<string, unknown>
  ): { satisfied: boolean; reason: string; suggestion: string } {
    const target = constraint.target || "";
    const hasTarget = ctx[`has_${target}`] === true || ctx[`available_${target}`] === true;

    switch (constraint.type) {
      case "requires":
        if (hasTarget) return { satisfied: true, reason: "", suggestion: "" };
        return {
          satisfied: false,
          reason: `${action} 需要 ${target}，但 ${target} 不可用`,
          suggestion: `请先启用或安装 ${target}`,
        };

      case "prohibits":
        if (!hasTarget) return { satisfied: true, reason: "", suggestion: "" };
        return {
          satisfied: false,
          reason: `${action} 禁止 ${target}，但 ${target} 已存在`,
          suggestion: `请先禁用或移除 ${target}`,
        };

      case "conflicts":
        const hasAction = ctx[`has_${action}`] === true;
        if (hasAction && hasTarget) {
          return {
            satisfied: false,
            reason: `${action} 和 ${target} 冲突，不能同时存在`,
            suggestion: `请选择其一: ${action} 或 ${target}`,
          };
        }
        return { satisfied: true, reason: "", suggestion: "" };

      case "excludes":
        if (hasTarget) {
          return {
            satisfied: false,
            reason: `${action} 排斥 ${target}`,
            suggestion: `请先移除 ${target} 再执行 ${action}`,
          };
        }
        return { satisfied: true, reason: "", suggestion: "" };

      default:
        return { satisfied: true, reason: "", suggestion: "" };
    }
  }

  private evaluatePhysical(
    constraint: Constraint,
    action: string,
    ctx: Record<string, unknown>
  ): { satisfied: boolean; reason: string; suggestion: string } {
    const subject = constraint.subject;
    const currentValue = ctx[subject] as number | undefined;
    const minValue = constraint.params?.min as number | undefined;
    const maxValue = constraint.params?.max as number | undefined;

    if (currentValue === undefined) {
      return { satisfied: true, reason: "", suggestion: "" };
    }

    switch (constraint.type) {
      case "min_value":
        if (minValue !== undefined && currentValue < minValue) {
          return {
            satisfied: false,
            reason: `${subject} 当前值 ${currentValue} 低于最小要求 ${minValue}`,
            suggestion: constraint.description,
          };
        }
        return { satisfied: true, reason: "", suggestion: "" };

      case "max_value":
        if (maxValue !== undefined && currentValue > maxValue) {
          return {
            satisfied: false,
            reason: `${subject} 当前值 ${currentValue} 超过最大限制 ${maxValue}`,
            suggestion: constraint.description,
          };
        }
        return { satisfied: true, reason: "", suggestion: "" };

      case "between":
        const min = constraint.params?.min as number;
        const max = constraint.params?.max as number;
        if (min !== undefined && max !== undefined && (currentValue < min || currentValue > max)) {
          return {
            satisfied: false,
            reason: `${subject} 当前值 ${currentValue} 不在范围 [${min}, ${max}] 内`,
            suggestion: constraint.description,
          };
        }
        return { satisfied: true, reason: "", suggestion: "" };

      default:
        return { satisfied: true, reason: "", suggestion: "" };
    }
  }

  private evaluateFieldMatch(
    constraint: Constraint,
    action: string,
    ctx: Record<string, unknown>
  ): { satisfied: boolean; reason: string; suggestion: string } {
    switch (constraint.type) {
      case "equals":
        if (ctx[constraint.subject] === constraint.target) {
          return { satisfied: true, reason: "", suggestion: "" };
        }
        return {
          satisfied: false,
          reason: `${constraint.subject} 应为 ${constraint.target}，实际为 ${ctx[constraint.subject]}`,
          suggestion: constraint.description,
        };

      case "not_equals":
        if (ctx[constraint.subject] !== constraint.target) {
          return { satisfied: true, reason: "", suggestion: "" };
        }
        return {
          satisfied: false,
          reason: `${constraint.subject} 不应为 ${constraint.target}`,
          suggestion: constraint.description,
        };

      case "in_set":
        const allowedSet = constraint.params?.values as unknown[];
        if (allowedSet && allowedSet.includes(ctx[constraint.subject])) {
          return { satisfied: true, reason: "", suggestion: "" };
        }
        return {
          satisfied: false,
          reason: `${constraint.subject} 值 ${ctx[constraint.subject]} 不在允许集合中`,
          suggestion: constraint.description,
        };

      default:
        return { satisfied: true, reason: "", suggestion: "" };
    }
  }

  private evaluatePolicy(
    constraint: Constraint,
    action: string,
    ctx: Record<string, unknown>
  ): { satisfied: boolean; reason: string; suggestion: string } {
    switch (constraint.type) {
      case "not_equals":
        if (ctx[constraint.subject] !== constraint.target) {
          return { satisfied: true, reason: "", suggestion: "" };
        }
        return {
          satisfied: false,
          reason: `策略禁止: ${constraint.subject} 为 ${constraint.target} 时不能执行 ${action}`,
          suggestion: constraint.description,
        };

      case "in_set":
        const allowedSet = constraint.params?.values as unknown[];
        if (allowedSet && allowedSet.includes(ctx[constraint.subject])) {
          return { satisfied: true, reason: "", suggestion: "" };
        }
        return {
          satisfied: false,
          reason: `策略限制: ${action} 不在当前环境允许的操作中`,
          suggestion: constraint.description,
        };

      default:
        return { satisfied: true, reason: "", suggestion: "" };
    }
  }

  private evaluateTemporal(
    constraint: Constraint,
    action: string,
    ctx: Record<string, unknown>
  ): { satisfied: boolean; reason: string; suggestion: string } {
    const now = new Date();
    const hour = now.getHours();
    const day = now.getDay();

    switch (constraint.type) {
      case "between":
        const minHour = constraint.params?.min as number;
        const maxHour = constraint.params?.max as number;
        if (minHour !== undefined && maxHour !== undefined && (hour < minHour || hour > maxHour)) {
          return {
            satisfied: false,
            reason: `${action} 仅在 ${minHour}:00-${maxHour}:00 之间允许执行`,
            suggestion: `请在工作时间内执行此操作`,
          };
        }
        return { satisfied: true, reason: "", suggestion: "" };

      case "not_in_set":
        const blockedDays = constraint.params?.values as number[];
        if (blockedDays && blockedDays.includes(day)) {
          return {
            satisfied: false,
            reason: `${action} 在当前日期不允许执行`,
            suggestion: constraint.description,
          };
        }
        return { satisfied: true, reason: "", suggestion: "" };

      default:
        return { satisfied: true, reason: "", suggestion: "" };
    }
  }

  private calculateSeverity(constraint: Constraint): number {
    // 基于维度和优先级计算严重程度
    const dimensionWeight: Record<ConstraintDimension, number> = {
      logical: 5,
      physical: 8,
      field_match: 3,
      policy: 9,
      temporal: 2,
    };
    return Math.min(10, dimensionWeight[constraint.dimension] + (constraint.priority || 0));
  }
}

// ========== 预定义约束 ==========

/** 资源预算约束 (通用, 不依赖特定硬件) */
export const RESOURCE_CONSTRAINTS: Constraint[] = [
  {
    id: "resource-memory-min",
    dimension: "physical",
    type: "min_value",
    name: "内存最低要求",
    description: "本地推理需要至少 500MB 可用内存",
    subject: "available_memory_mb",
    params: { min: 500 },
    priority: 3,
    enabled: true,
    createdAt: Date.now(),
  },
  {
    id: "resource-memory-model",
    dimension: "physical",
    type: "min_value",
    name: "模型内存要求",
    description: "Qwen3-1.7B Q4_K_M 需要至少 1100MB 内存",
    subject: "available_memory_mb",
    params: { min: 1100 },
    priority: 5,
    enabled: true,
    createdAt: Date.now(),
  },
];

/**
 * @deprecated Use {@link RESOURCE_CONSTRAINTS} instead (hardware-agnostic)
 */
export const GPU_CONSTRAINTS: Constraint[] = [
  {
    id: "gpu-vram-min",
    dimension: "physical",
    type: "min_value",
    name: "GPU VRAM 最低要求",
    description: "本地推理需要至少 500MB 可用 VRAM",
    subject: "gpu_free_vram_mb",
    params: { min: 500 },
    priority: 3,
    enabled: true,
    createdAt: Date.now(),
  },
  {
    id: "gpu-vram-model",
    dimension: "physical",
    type: "min_value",
    name: "模型 VRAM 要求",
    description: "Qwen3-1.7B Q4_K_M 需要至少 1100MB VRAM",
    subject: "gpu_free_vram_mb",
    params: { min: 1100 },
    priority: 5,
    enabled: true,
    createdAt: Date.now(),
  },
];

/** 生产环境保护约束 */
export const POLICY_CONSTRAINTS: Constraint[] = [
  {
    id: "prod-no-delete",
    dimension: "policy",
    type: "not_equals",
    name: "生产环境禁止删除",
    description: "生产环境中禁止执行删除操作",
    subject: "environment",
    target: "production",
    priority: 10,
    enabled: true,
    createdAt: Date.now(),
  },
  {
    id: "prod-no-experimental",
    dimension: "policy",
    type: "not_equals",
    name: "生产环境禁止实验性操作",
    description: "生产环境中禁止执行实验性操作",
    subject: "environment",
    target: "production",
    priority: 8,
    enabled: true,
    createdAt: Date.now(),
  },
];

/** 工作时间约束 */
export const TEMPORAL_CONSTRAINTS: Constraint[] = [
  {
    id: "work-hours-only",
    dimension: "temporal",
    type: "between",
    name: "工作时间限制",
    description: "某些操作仅在工作时间 (9:00-18:00) 内允许",
    subject: "hour",
    params: { min: 9, max: 18 },
    priority: 2,
    enabled: false,
    createdAt: Date.now(),
  },
];

/** 安全审计约束 (Persona: audit) */
export const AUDIT_CONSTRAINTS: Constraint[] = [
  {
    id: "persona-audit-no-write",
    dimension: "policy",
    type: "not_equals",
    name: "审计模式禁止写操作",
    description: "安全审计模式下禁止任何写操作 (文件/数据库/配置)",
    subject: "action",
    target: "write",
    priority: 10,
    enabled: true,
    createdAt: Date.now(),
  },
  {
    id: "persona-audit-no-delete",
    dimension: "policy",
    type: "not_equals",
    name: "审计模式禁止删除",
    description: "安全审计模式下禁止删除操作",
    subject: "action",
    target: "delete",
    priority: 10,
    enabled: true,
    createdAt: Date.now(),
  },
  {
    id: "persona-audit-no-exec",
    dimension: "policy",
    type: "not_equals",
    name: "审计模式禁止执行",
    description: "安全审计模式下禁止执行任意代码/命令",
    subject: "action",
    target: "execute",
    priority: 10,
    enabled: true,
    createdAt: Date.now(),
  },
];


