/**
 * 心智模型层 (Mental Model Layer)
 *
 * 桥接 Pattern → Skill 的认知断层
 *
 * 核心思想:
 * 当系统学习到一个模式 (如 "Git 经常冲突") 时，
 * 不应直接生成 Skill，
 * 而是先构建一个内部模拟模型 (如 Git 的 HEAD/Index/Merge 概念)，
 * 并在此模型上演练出 Skill。
 *
 * 心智模型 = 概念图 + 状态转换 + 预测函数
 *
 * 例如: Git 冲突模型
 * - 概念: HEAD, Index, WorkingTree, Merge, Conflict
 * - 状态转换: merge → conflict → resolve → commit
 * - 预测: 如果两个分支修改同一文件，则 merge 会产生 conflict
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
};

/**
 * 获取预注册的心智模型池
 */
export function createDefaultMentalModelPool(): MentalModelPool {
  const pool = new MentalModelPool();
  pool.register(GIT_CONFLICT_MODEL);
  pool.register(CODE_REFACTOR_MODEL);
  return pool;
}
