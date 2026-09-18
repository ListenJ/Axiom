/**
 * GoalTracker — 超长会话下的目标事实核查 + 生命周期 + 会话状态追踪
 *
 * 核心职责：
 *   1. 事实核查：用 Jaccard 相似度验证 LLM 提取的 goals/beliefs 是否基于
 *      可靠信息源（实际观察数据）。低相似度的目标被判为潜在幻觉并过滤。
 *   2. 目标生命周期：合并新目标与已有目标（去重 + 累计计数），而非整体替换。
 *      支持活跃/达成/放弃状态转换，上限管理。
 *   3. 会话状态追踪：跨反思周期维护目标历史，检测目标漂移以维持上下文一致性。
 *
 * 设计原则：
 *   - 零额外 LLM 调用 — 纯 token 相似度计算
 *   - 无外部依赖 — 自带分词器 + Jaccard 实现
 *   - 单例模式 — 与 consciousness 模块其他组件一致
 *   - 可测试 — 提供 reset() 和直接构造函数
 */

import { logger } from "../../utils/logger.js";

// ─── 类型定义 ────────────────────────────────────────────────────────────

/** 目标记录 — 扩展基本目标信息，增加生命周期追踪字段 */
export interface GoalRecord {
  id: string;
  description: string;
  priority: number;
  status: "active" | "achieved" | "abandoned";
  /** 首次被提取的时间戳 */
  firstSeenAt: number;
  /** 最近被提取的时间戳 */
  lastSeenAt: number;
  /** 被提取的总次数（反映目标稳定性） */
  occurrenceCount: number;
  /** 最近一次事实核查的相似度分数 (0-1) */
  validationScore: number;
}

/** 信念记录 — 扩展 Belief，增加验证信息 */
export interface BeliefRecord {
  id: string;
  proposition: string;
  confidence: number;
  /** 事实核查分数 (0-1)，低于阈值的信念被标记为未验证 */
  validationScore: number;
  /** 是否通过事实核查 */
  validated: boolean;
  formedAt: number;
  updatedAt: number;
  status: "active" | "weakened" | "strengthened" | "retracted";
}

/** 事实核查结果 */
export interface ValidationResult {
  /** 通过核查的目标 */
  accepted: GoalRecord[];
  /** 被拒绝的目标（潜在幻觉） */
  rejected: Array<{ description: string; reason: string; score: number }>;
}

/** 目标漂移检测结果 */
export interface DriftResult {
  /** 是否检测到漂移 */
  drifting: boolean;
  /** 漂移原因 */
  reason?: string;
  /** 当前目标与历史目标的平均相似度 */
  consistencyScore: number;
}

// ─── 分词器 + Jaccard 相似度（轻量级，零依赖）────────────────────────────

/** 简单分词：小写 + 字母数字序列，过滤长度 < 2 的 token */
function tokenize(text: string): string[] {
  if (!text) return [];
  // 支持中英文混合：英文用 [a-z0-9]+，中文按单字切分
  const englishTokens = text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  const chineseTokens = text.match(/[\u4e00-\u9fff]/g) ?? [];
  return [...englishTokens.filter((t) => t.length >= 2), ...chineseTokens];
}

/** Jaccard 相似度（基于 token 集合） */
function jaccardSimilarity(tokensA: string[], tokensB: string[]): number {
  if (tokensA.length === 0 && tokensB.length === 0) return 1.0;
  if (tokensA.length === 0 || tokensB.length === 0) return 0.0;
  const setA = new Set(tokensA);
  const setB = new Set(tokensB);
  let intersection = 0;
  for (const t of setA) {
    if (setB.has(t)) intersection++;
  }
  const union = setA.size + setB.size - intersection;
  return union > 0 ? intersection / union : 0.0;
}

// ─── GoalTracker ────────────────────────────────────────────────────────

/** 默认配置 */
export interface GoalTrackerConfig {
  /** 活跃目标上限 */
  maxActiveGoals: number;
  /** 历史记录上限 */
  maxHistorySize: number;
  /** 事实核查阈值：Jaccard 相似度低于此值的目标被判为潜在幻觉 */
  factCheckThreshold: number;
  /** 去重阈值：Jaccard 相似度高于此值的两个目标视为同一目标 */
  dedupThreshold: number;
  /** 漂移检测阈值：当前目标与历史平均相似度低于此值判定为漂移 */
  driftThreshold: number;
  /** 漂移检测的历史窗口大小 */
  driftWindowSize: number;
}

export const DEFAULT_GOAL_TRACKER_CONFIG: GoalTrackerConfig = {
  maxActiveGoals: 10,
  maxHistorySize: 50,
  factCheckThreshold: 0.05,
  dedupThreshold: 0.65,
  driftThreshold: 0.20,
  driftWindowSize: 5,
};

export class GoalTracker {
  private activeGoals: Map<string, GoalRecord> = new Map();
  private goalHistory: GoalRecord[] = [];
  private readonly config: GoalTrackerConfig;
  private cycleCount = 0;
  /** trackHistory 调用前的历史长度 — detectDrift 据此排除当前周期 */
  private lastCycleHistoryLen = 0;

  constructor(config: Partial<GoalTrackerConfig> = {}) {
    this.config = { ...DEFAULT_GOAL_TRACKER_CONFIG, ...config };
  }

  /**
   * 事实核查：验证 LLM 提取的目标是否基于可靠信息源
   *
   * 将每个目标的 description 与 contextText（实际观察数据的文本表示）
   * 计算 Jaccard 相似度。低于 factCheckThreshold 的目标被判为潜在幻觉。
   *
   * @param rawGoals LLM 提取的原始目标列表
   * @param contextText 实际观察数据的文本表示（如 collectObservations 的 JSON）
   * @returns 通过核查的目标 + 被拒绝的目标
   */
  validateAgainstContext(
    rawGoals: Array<{ description: string; priority?: number }>,
    contextText: string,
  ): ValidationResult {
    const contextTokens = tokenize(contextText);
    const accepted: GoalRecord[] = [];
    const rejected: ValidationResult["rejected"] = [];
    const now = Date.now();

    for (const raw of rawGoals) {
      const goalTokens = tokenize(raw.description);
      const score = jaccardSimilarity(goalTokens, contextTokens);

      if (score < this.config.factCheckThreshold) {
        rejected.push({
          description: raw.description,
          reason: `事实核查失败：与观察数据相似度 ${score.toFixed(3)} < 阈值 ${this.config.factCheckThreshold}`,
          score,
        });
        logger.debug("[Consciousness/GoalTracker] 目标被拒（潜在幻觉）", {
          description: raw.description,
          score,
          threshold: this.config.factCheckThreshold,
        });
      } else {
        accepted.push({
          id: `goal-${now}-${Math.random().toString(36).slice(2, 8)}`,
          description: raw.description,
          priority: raw.priority ?? 5,
          status: "active",
          firstSeenAt: now,
          lastSeenAt: now,
          occurrenceCount: 1,
          validationScore: score,
        });
      }
    }

    if (rejected.length > 0) {
      logger.info("[Consciousness/GoalTracker] 事实核查完成", {
        accepted: accepted.length,
        rejected: rejected.length,
      });
    }

    return { accepted, rejected };
  }

  /**
   * 合并新验证目标与已有活跃目标（去重 + 累计计数）
   *
   * 对每个新目标：
   *   - 如果与已有目标相似度 > dedupThreshold，视为同一目标，更新 lastSeenAt 和 occurrenceCount
   *   - 否则作为新目标加入活跃列表
   *
   * 超过 maxActiveGoals 时，淘汰优先级最低且最久未见的旧目标。
   */
  mergeGoals(newGoals: GoalRecord[]): GoalRecord[] {
    const now = Date.now();

    for (const newGoal of newGoals) {
      let foundMatch = false;
      const newTokens = tokenize(newGoal.description);

      for (const [existingId, existing] of this.activeGoals) {
        const existingTokens = tokenize(existing.description);
        const sim = jaccardSimilarity(newTokens, existingTokens);

        if (sim >= this.config.dedupThreshold) {
          // 同一目标 — 更新而非新增
          existing.lastSeenAt = now;
          existing.occurrenceCount += 1;
          // 保留更高的优先级
          if (newGoal.priority > existing.priority) {
            existing.priority = newGoal.priority;
          }
          // 保留更高的验证分数
          if (newGoal.validationScore > existing.validationScore) {
            existing.validationScore = newGoal.validationScore;
          }
          foundMatch = true;
          break;
        }
      }

      if (!foundMatch) {
        this.activeGoals.set(newGoal.id, newGoal);
      }
    }

    // 上限管理：淘汰优先级最低且最久未见的目标
    if (this.activeGoals.size > this.config.maxActiveGoals) {
      const sorted = Array.from(this.activeGoals.values()).sort((a, b) => {
        // 先按优先级升序，再按 lastSeenAt 升序（最久未见的先淘汰）
        if (a.priority !== b.priority) return a.priority - b.priority;
        return a.lastSeenAt - b.lastSeenAt;
      });
      const toEvict = sorted.slice(0, this.activeGoals.size - this.config.maxActiveGoals);
      for (const goal of toEvict) {
        goal.status = "abandoned";
        this.activeGoals.delete(goal.id);
        this.goalHistory.push(goal);
      }
      logger.debug("[Consciousness/GoalTracker] 目标淘汰", {
        evicted: toEvict.length,
        remaining: this.activeGoals.size,
      });
    }

    return this.getActiveGoals();
  }

  /**
   * 记录一轮反思周期的目标快照到历史
   *
   * @param goals 本轮活跃目标
   */
  trackHistory(goals: GoalRecord[]): void {
    this.lastCycleHistoryLen = this.goalHistory.length;
    this.cycleCount++;
    // 记录当前活跃目标的快照（深拷贝 description 用于漂移检测）
    for (const goal of goals) {
      this.goalHistory.push({ ...goal });
    }
    // 修剪历史到上限
    if (this.goalHistory.length > this.config.maxHistorySize) {
      this.goalHistory = this.goalHistory.slice(-this.config.maxHistorySize);
    }
  }

  /**
   * 检测目标漂移：当前目标是否与近期历史一致
   *
   * 比较当前活跃目标与之前周期历史目标的平均相似度（排除当前周期）。
   * 如果平均相似度低于 driftThreshold，判定为漂移。
   */
  detectDrift(): DriftResult {
    if (this.activeGoals.size === 0 || this.lastCycleHistoryLen === 0) {
      return { drifting: false, consistencyScore: 1.0 };
    }

    // 只取当前周期之前的历史（排除本轮 trackHistory 刚加入的条目）
    const previousHistory = this.goalHistory.slice(0, this.lastCycleHistoryLen);
    // 再取最近 driftWindowSize 轮的窗口
    const recentHistory = previousHistory.slice(-this.config.driftWindowSize * 3);
    if (recentHistory.length === 0) {
      return { drifting: false, consistencyScore: 1.0 };
    }

    const currentGoals = Array.from(this.activeGoals.values());
    let totalSimilarity = 0;
    let comparisons = 0;

    for (const current of currentGoals) {
      const currentTokens = tokenize(current.description);
      let maxSim = 0;
      for (const historical of recentHistory) {
        const histTokens = tokenize(historical.description);
        const sim = jaccardSimilarity(currentTokens, histTokens);
        if (sim > maxSim) maxSim = sim;
      }
      totalSimilarity += maxSim;
      comparisons++;
    }

    const avgSimilarity = comparisons > 0 ? totalSimilarity / comparisons : 1.0;
    const drifting = avgSimilarity < this.config.driftThreshold;

    if (drifting) {
      logger.warn("[Consciousness/GoalTracker] 检测到目标漂移", {
        consistencyScore: avgSimilarity.toFixed(3),
        threshold: this.config.driftThreshold,
        cycleCount: this.cycleCount,
      });
    }

    return {
      drifting,
      reason: drifting
        ? `目标与历史一致性 ${avgSimilarity.toFixed(3)} < 阈值 ${this.config.driftThreshold}`
        : undefined,
      consistencyScore: avgSimilarity,
    };
  }

  /** 获取当前活跃目标列表（按优先级降序） */
  getActiveGoals(): GoalRecord[] {
    return Array.from(this.activeGoals.values()).sort((a, b) => b.priority - a.priority);
  }

  /** 获取目标历史 */
  getHistory(): GoalRecord[] {
    return [...this.goalHistory];
  }

  /** 获取已完成周期数 */
  getCycleCount(): number {
    return this.cycleCount;
  }

  /**
   * 标记目标为已达成或放弃
   * @returns 是否成功更新
   */
  updateGoalStatus(goalId: string, status: GoalRecord["status"]): boolean {
    const goal = this.activeGoals.get(goalId);
    if (!goal) return false;
    goal.status = status;
    if (status !== "active") {
      this.activeGoals.delete(goalId);
      this.goalHistory.push({ ...goal });
    }
    return true;
  }

  /** 重置全部状态（测试用） */
  reset(): void {
    this.activeGoals.clear();
    this.goalHistory = [];
    this.cycleCount = 0;
    this.lastCycleHistoryLen = 0;
  }
}

// ─── 单例 ───────────────────────────────────────────────────────────────

let _instance: GoalTracker | null = null;

export function getGoalTracker(): GoalTracker {
  if (!_instance) _instance = new GoalTracker();
  return _instance;
}

/** 测试用：重置单例 */
export function _resetGoalTrackerForTest(): void {
  _instance = null;
}

/** 测试用：设置自定义实例 */
export function _setGoalTrackerForTest(tracker: GoalTracker | null): void {
  _instance = tracker;
}
