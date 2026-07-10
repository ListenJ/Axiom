/**
 * 心智模型层 (Mental Model Layer) — v4.0 增强版
 *
 * 桥接 Pattern → Skill 的认知断层
 *
 * 增强特性 (from cognitive-runtime branch):
 * - 领域规则 (ModelRule): condition→action 条件推理
 * - 场景模拟 (Simulation): what-if 演练
 * - Skill 生成: 从成功模拟自动生成技能
 * - 统计追踪: 模型数/模拟数/技能数
 * - 4 个预注册模型: Git Conflicts + Code Refactor + Auth + Database
 *
 * 心智模型 = 概念图 + 状态转换 + 规则 + 模拟 + 预测函数
 */

import { logger } from "../../utils/logger.js";

// ========== 类型定义 ==========

/** 模型概念 */
export interface ModelConcept {
  id: string;
  name: string;
  description: string;
  /** 概念属性 */
  properties: Record<string, unknown>;
  /** 概念与其他概念的关系 */
  relations: Array<{ target: string; type: string }>;
}

/** 状态转换 */
export interface StateTransition {
  id: string;
  /** 源状态 */
  fromState: string;
  /** 目标状态 */
  toState: string;
  /** 触发条件 */
  trigger: string;
  /** 所需概念 */
  requiredConcepts: string[];
  /** 转换概率 (0-1) */
  probability: number;
}

/** 模式匹配结果 */
export interface ModelPattern {
  /** 匹配的概念链 */
  conceptChain: string[];
  /** 匹配的状态路径 */
  statePath: string[];
  /** 置信度 */
  confidence: number;
  /** 建议的技能 */
  suggestedSkill?: string;
}

/** 领域规则 (condition → action) */
export interface ModelRule {
  id: string;
  condition: string;
  action: string;
  confidence: number;
}

/** 模拟步骤 */
export interface SimulationStep {
  action: string;
  result: string;
  state: Record<string, unknown>;
}

/** 场景模拟 */
export interface Simulation {
  id: string;
  scenario: string;
  steps: SimulationStep[];
  outcome: "success" | "failure" | "uncertain";
  confidence: number;
  timestamp: number;
}

/** 心智模型 */
export interface MentalModel {
  id: string;
  name: string;
  domain: string;
  description: string;
  /** 模型概念 */
  concepts: ModelConcept[];
  /** 状态转换图 */
  transitions: StateTransition[];
  /** 初始状态 */
  initialState: string;
  /** 当前状态 */
  currentState: string;
  /** 模型置信度 */
  confidence: number;
  /** 使用次数 */
  usageCount: number;
  /** 最后使用时间 */
  lastUsedAt: number;
  /** 创建时间 */
  createdAt: number;
  /** 领域规则 (v4.0) */
  rules: ModelRule[];
  /** 模拟结果 (v4.0) */
  simulations: Simulation[];
}

// ========== 心智模型池 ==========

export class MentalModelPool {
  private models = new Map<string, MentalModel>();

  /**
   * 注册心智模型 (深拷贝，避免多池共享可变状态)
   */
  register(model: MentalModel): void {
    const copy: MentalModel = {
      ...model,
      concepts: model.concepts.map((c) => ({ ...c, relations: [...c.relations] })),
      transitions: model.transitions.map((t) => ({ ...t, requiredConcepts: [...t.requiredConcepts] })),
    };
    this.models.set(copy.id, copy);
    logger.info("[MentalModel] Registered model", {
      id: copy.id,
      name: copy.name,
      concepts: copy.concepts.length,
      transitions: copy.transitions.length,
    });
  }

  /**
   * 获取模型
   */
  get(modelId: string): MentalModel | undefined {
    return this.models.get(modelId);
  }

  /**
   * 按领域查找模型
   */
  findByDomain(domain: string): MentalModel[] {
    return Array.from(this.models.values()).filter((m) => m.domain === domain);
  }

  /**
   * 模式匹配 — 在模型中查找匹配的概念链和状态路径
   */
  matchPattern(modelId: string, observations: string[]): ModelPattern | null {
    const model = this.models.get(modelId);
    if (!model) return null;

    // 提取观察中涉及的概念 (直接匹配 + 关系扩展)
    const directMatches = new Set<string>();
    for (const obs of observations) {
      const lower = obs.toLowerCase();
      for (const concept of model.concepts) {
        if (lower.includes(concept.name.toLowerCase())) {
          directMatches.add(concept.id);
        }
      }
    }

    if (directMatches.size === 0) return null;

    // 关系扩展: 如果 A 匹配了，且 A →(may-cause/requires) B，也把 B 加入
    const expandedMatches = new Set(directMatches);
    for (const concept of model.concepts) {
      if (directMatches.has(concept.id)) {
        for (const rel of concept.relations) {
          if (rel.type === "may-cause" || rel.type === "requires") {
            expandedMatches.add(rel.target);
          }
        }
      }
    }

    const matchedConcepts = Array.from(expandedMatches);

    // 查找状态路径
    const statePath = this.findStatePath(model, matchedConcepts);

    // 更新使用统计
    model.usageCount++;
    model.lastUsedAt = Date.now();

    // 置信度: 直接匹配数 / 总概念数 (关系扩展不降低置信度)
    const confidence = Math.min(1.0, (directMatches.size + matchedConcepts.length * 0.3) / model.concepts.length);

    return {
      conceptChain: matchedConcepts,
      statePath,
      confidence,
    };
  }

  /**
   * 预测 — 基于当前状态和观察，预测下一步
   */
  predict(modelId: string, observation: string): {
    predictedState: string;
    trigger: string;
    probability: number;
  } | null {
    const model = this.models.get(modelId);
    if (!model) return null;

    // 查找从当前状态出发的转换
    const candidates = model.transitions.filter(
      (t) => t.fromState === model.currentState
    );

    if (candidates.length === 0) return null;

    // 按概率排序
    candidates.sort((a, b) => b.probability - a.probability);

    // 检查触发条件
    for (const transition of candidates) {
      if (observation.toLowerCase().includes(transition.trigger.toLowerCase())) {
        return {
          predictedState: transition.toState,
          trigger: transition.trigger,
          probability: transition.probability,
        };
      }
    }

    // 返回最高概率的转换
    return {
      predictedState: candidates[0].toState,
      trigger: candidates[0].trigger,
      probability: candidates[0].probability,
    };
  }

  /**
   * 推进状态
   */
  advanceState(modelId: string, trigger: string): boolean {
    const model = this.models.get(modelId);
    if (!model) return false;

    const transition = model.transitions.find(
      (t) => t.fromState === model.currentState && t.trigger === trigger
    );

    if (!transition) return false;

    model.currentState = transition.toState;
    return true;
  }

  /**
   * 获取所有模型
   */
  list(): MentalModel[] {
    return Array.from(this.models.values());
  }

  /**
   * 添加规则到模型 (v4.0)
   */
  addRule(modelId: string, condition: string, action: string, confidence: number = 0.8): boolean {
    const model = this.models.get(modelId);
    if (!model) return false;
    model.rules.push({
      id: `rule_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      condition,
      action,
      confidence,
    });
    return true;
  }

  /**
   * 场景模拟 (v4.0): 在模型上运行 what-if 演练
   * 应用规则和概念关系来模拟状态转换
   */
  simulate(modelId: string, scenario: string, initialState: Record<string, unknown>): Simulation | null {
    const model = this.models.get(modelId);
    if (!model) return null;

    const steps: SimulationStep[] = [];
    const state = { ...initialState };

    // 应用规则模拟状态转换
    for (const rule of model.rules) {
      if (this.evaluateCondition(rule.condition, state)) {
        const stateChange = this.applyAction(rule.action, state);
        steps.push({ action: rule.action, result: `Applied: ${rule.condition} → ${rule.action}`, state: { ...state } });
        Object.assign(state, stateChange);
      }
    }

    // 应用概念关系作为状态转换
    for (const concept of model.concepts) {
      for (const rel of concept.relations) {
        const sourceState = state[concept.name];
        if (sourceState !== undefined) {
          if (rel.type === "causes" || rel.type === "may-cause") {
            state[rel.target] = `affected_by_${concept.name}`;
          } else if (rel.type === "requires") {
            if (!state[rel.target]) state[rel.target] = `missing_required_by_${concept.name}`;
          }
        }
      }
    }

    const simulation: Simulation = {
      id: `sim_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      scenario,
      steps,
      outcome: steps.length > 0 ? "success" : "uncertain",
      confidence: model.confidence * (steps.length > 0 ? 1 : 0.5),
      timestamp: Date.now(),
    };

    model.simulations.push(simulation);
    return simulation;
  }

  /**
   * 从成功模拟生成技能描述 (v4.0)
   */
  generateSkillFromSimulation(modelId: string, simulationId: string): string | null {
    const model = this.models.get(modelId);
    if (!model) return null;
    const sim = model.simulations.find((s) => s.id === simulationId);
    if (!sim || sim.outcome !== "success") return null;
    return `Skill from ${model.domain}: ${sim.scenario}`;
  }

  /**
   * 获取统计 (v4.0)
   */
  getStats(): { models: number; totalSimulations: number; totalRules: number } {
    let sims = 0;
    let rules = 0;
    for (const m of this.models.values()) {
      sims += m.simulations.length;
      rules += m.rules.length;
    }
    return { models: this.models.size, totalSimulations: sims, totalRules: rules };
  }

  /**
   * 激活心智模型 (v4.1 — Persona 系统集成)
   *
   * 仅更新 lastUsedAt — usageCount 由 matchPattern/predict 等"实际使用"路径自增,
   * 避免 Persona 激活后再 matchPattern 导致 usageCount 双计数。
   */
  activate(modelId: string): boolean {
    const model = this.models.get(modelId);
    if (!model) return false;
    model.lastUsedAt = Date.now();
    return true;
  }

  /**
   * 停用心智模型 (v4.1 — Persona 系统集成)
   */
  deactivate(_modelId: string): void {
    // Persona 退出时清理, 当前仅标记
  }

  /**
   * 获取活跃的心智模型 IDs (v4.1 — Persona 系统集成)
   * 最近使用过的模型视为活跃
   */
  getActiveIds(): string[] {
    const recentThreshold = Date.now() - 3600000; // 1小时内
    return Array.from(this.models.values())
      .filter((m) => m.lastUsedAt > recentThreshold)
      .map((m) => m.id);
  }

  /**
   * 查找状态路径 (BFS)
   */
  private findStatePath(model: MentalModel, conceptIds: string[]): string[] {
    const path: string[] = [model.currentState];
    let current = model.currentState;
    const visited = new Set<string>(current);

    // 简单 BFS: 沿着转换走，直到没有未访问的转换
    for (let i = 0; i < 10; i++) {
      const next = model.transitions.find(
        (t) => t.fromState === current && !visited.has(t.toState)
      );
      if (!next) break;
      path.push(next.toState);
      visited.add(next.toState);
      current = next.toState;
    }

    return path;
  }

  /**
   * 评估条件 (v4.0): key==value | key exists | key contains value
   */
  private evaluateCondition(condition: string, state: Record<string, unknown>): boolean {
    const eqMatch = condition.match(/^(\w+)\s*==\s*(.+)$/);
    if (eqMatch) return String(state[eqMatch[1]]) === eqMatch[2].trim();
    const existsMatch = condition.match(/^(\w+)\s+exists$/);
    if (existsMatch) return state[existsMatch[1]] !== undefined;
    const containsMatch = condition.match(/^(\w+)\s+contains\s+(.+)$/);
    if (containsMatch) return String(state[containsMatch[1]] ?? "").includes(containsMatch[2].trim());
    return JSON.stringify(state).toLowerCase().includes(condition.toLowerCase());
  }

  /**
   * 应用动作到状态 (v4.0): set key to value | increment key
   */
  private applyAction(action: string, state: Record<string, unknown>): Record<string, unknown> {
    const changes: Record<string, unknown> = {};
    const setMatch = action.match(/^set\s+(\w+)\s+to\s+(.+)$/i);
    if (setMatch) { changes[setMatch[1]] = setMatch[2].trim(); return changes; }
    const incMatch = action.match(/^increment\s+(\w+)$/i);
    if (incMatch) { changes[incMatch[1]] = (Number(state[incMatch[1]]) || 0) + 1; return changes; }
    changes[action] = Date.now();
    return changes;
  }
}

// ========== 预定义心智模型 ==========

/**
 * Git 冲突模型
 */
export const GIT_CONFLICT_MODEL: MentalModel = {
  id: "git-conflict",
  name: "Git 冲突解决模型",
  domain: "git",
  description: "描述 Git 合并冲突的产生、检测和解决过程",
  concepts: [
    { id: "HEAD", name: "HEAD", description: "当前分支的最新提交", properties: {}, relations: [] },
    { id: "Index", name: "Index", description: "暂存区", properties: {}, relations: [] },
    { id: "WorkingTree", name: "WorkingTree", description: "工作目录", properties: {}, relations: [] },
    { id: "Merge", name: "Merge", description: "合并操作", properties: {}, relations: [{ target: "Conflict", type: "may-cause" }] },
    { id: "Conflict", name: "Conflict", description: "冲突状态", properties: {}, relations: [{ target: "Resolution", type: "requires" }] },
    { id: "Resolution", name: "Resolution", description: "冲突解决", properties: {}, relations: [] },
  ],
  transitions: [
    { id: "t1", fromState: "clean", toState: "merging", trigger: "merge", requiredConcepts: ["Merge"], probability: 1.0 },
    { id: "t2", fromState: "merging", toState: "conflict", trigger: "same-file-change", requiredConcepts: ["HEAD", "WorkingTree"], probability: 0.7 },
    { id: "t3", fromState: "merging", toState: "clean", trigger: "auto-merge", requiredConcepts: [], probability: 0.3 },
    { id: "t4", fromState: "conflict", toState: "resolved", trigger: "resolve", requiredConcepts: ["Resolution"], probability: 1.0 },
    { id: "t5", fromState: "resolved", toState: "clean", trigger: "commit", requiredConcepts: [], probability: 1.0 },
  ],
  initialState: "clean",
  currentState: "clean",
  confidence: 0.9,
  usageCount: 0,
  lastUsedAt: 0,
  createdAt: Date.now(),
  rules: [],
  simulations: [],
};

/**
 * 代码重构模型
 */
export const CODE_REFACTOR_MODEL: MentalModel = {
  id: "code-refactor",
  name: "代码重构模型",
  domain: "code",
  description: "描述代码重构的安全操作序列",
  concepts: [
    { id: "CodeSmell", name: "CodeSmell", description: "代码异味", properties: {}, relations: [{ target: "RefactorTechnique", type: "suggests" }] },
    { id: "RefactorTechnique", name: "RefactorTechnique", description: "重构技术", properties: {}, relations: [] },
    { id: "Test", name: "Test", description: "测试用例", properties: {}, relations: [{ target: "RefactorTechnique", type: "validates" }] },
    { id: "Dependency", name: "Dependency", description: "依赖关系", properties: {}, relations: [] },
  ],
  transitions: [
    { id: "t1", fromState: "smelly", toState: "analyzing", trigger: "detect-smell", requiredConcepts: ["CodeSmell"], probability: 1.0 },
    { id: "t2", fromState: "analyzing", toState: "testing", trigger: "write-test", requiredConcepts: ["Test"], probability: 1.0 },
    { id: "t3", fromState: "testing", toState: "refactoring", trigger: "apply-technique", requiredConcepts: ["RefactorTechnique"], probability: 0.9 },
    { id: "t4", fromState: "refactoring", toState: "verifying", trigger: "run-test", requiredConcepts: ["Test"], probability: 1.0 },
    { id: "t5", fromState: "verifying", toState: "clean", trigger: "test-pass", requiredConcepts: [], probability: 0.95 },
    { id: "t6", fromState: "verifying", toState: "smelly", trigger: "test-fail", requiredConcepts: [], probability: 0.05 },
  ],
  initialState: "smelly",
  currentState: "smelly",
  confidence: 0.85,
  usageCount: 0,
  lastUsedAt: 0,
  createdAt: Date.now(),
  rules: [],
  simulations: [],
};

// ========== v4.0 新增预定义模型 ==========

export const AUTH_MODEL: MentalModel = {
  id: "auth-flow",
  name: "认证流程模型",
  domain: "auth",
  description: "JWT/OAuth2 认证的三个核心阶段: Token → Refresh → Expiry",
  concepts: [
    { id: "Token", name: "Token", description: "认证令牌", properties: {}, relations: [] },
    { id: "Refresh", name: "Refresh", description: "Token 刷新流程", properties: {}, relations: [] },
    { id: "Expiry", name: "Expiry", description: "Token 过期状态", properties: {}, relations: [{ target: "Refresh", type: "may-cause" }] },
    { id: "Validation", name: "Validation", description: "Token 校验流程", properties: {}, relations: [{ target: "Token", type: "requires" }] },
  ],
  transitions: [
    { id: "t1", fromState: "authenticated", toState: "expiring", trigger: "token-expiring", requiredConcepts: ["Expiry"], probability: 1.0 },
    { id: "t2", fromState: "expiring", toState: "refreshing", trigger: "refresh", requiredConcepts: ["Refresh"], probability: 0.9 },
    { id: "t3", fromState: "expiring", toState: "unauthenticated", trigger: "token-expired", requiredConcepts: ["Expiry"], probability: 0.1 },
    { id: "t4", fromState: "refreshing", toState: "authenticated", trigger: "token-refreshed", requiredConcepts: ["Token"], probability: 0.95 },
  ],
  initialState: "authenticated",
  currentState: "authenticated",
  confidence: 0.92,
  usageCount: 0,
  lastUsedAt: 0,
  createdAt: Date.now(),
  rules: [],
  simulations: [],
};

export const DATABASE_MODEL: MentalModel = {
  id: "database-tx",
  name: "数据库事务模型",
  domain: "database",
  description: "ACID 事务生命周期: Query → Transaction → Deadlock → Retry",
  concepts: [
    { id: "Query", name: "Query", description: "数据库查询", properties: {}, relations: [] },
    { id: "Connection", name: "Connection", description: "连接池", properties: {}, relations: [{ target: "Query", type: "requires" }] },
    { id: "Transaction", name: "Transaction", description: "ACID 事务", properties: {}, relations: [] },
    { id: "Deadlock", name: "Deadlock", description: "死锁状态", properties: {}, relations: [{ target: "Transaction", type: "may-cause" }] },
  ],
  transitions: [
    { id: "t1", fromState: "connected", toState: "querying", trigger: "execute", requiredConcepts: ["Query"], probability: 1.0 },
    { id: "t2", fromState: "querying", toState: "in-transaction", trigger: "begin", requiredConcepts: ["Transaction"], probability: 0.8 },
    { id: "t3", fromState: "in-transaction", toState: "deadlocked", trigger: "lock-conflict", requiredConcepts: ["Deadlock"], probability: 0.2 },
    { id: "t4", fromState: "in-transaction", toState: "committed", trigger: "commit", requiredConcepts: [], probability: 0.8 },
    { id: "t5", fromState: "deadlocked", toState: "in-transaction", trigger: "retry", requiredConcepts: ["Transaction"], probability: 0.7 },
  ],
  initialState: "connected",
  currentState: "connected",
  confidence: 0.88,
  usageCount: 0,
  lastUsedAt: 0,
  createdAt: Date.now(),
  rules: [],
  simulations: [],
};


