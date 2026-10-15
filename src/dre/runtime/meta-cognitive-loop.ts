/**
 * MetaCognitiveLoop — 认知反馈环传动轴
 *
 * 闭合四个断点：
 *   A. 意识流 lessons → 规则引擎 learn()        （跨轮次：下一轮推理可用新规则）
 *   B. 突触 suggest → 认知管道 Step 2 知识注入   （同轮次：管道内实时合并）
 *   C. 心智模型 predict → Step 5 行动咨询        （同轮次：管道内实时咨询）
 *   D. 反思 issues → 管道参数微调               （跨轮次：累积模式检测后调整）
 *
 * 安全设计：
 *   - 每条路径有独立安全门（置信度阈值 + 限流 + 影子模式 + 预算 + 去重）
 *   - 所有动作经 EventBus 审计
 *   - 渐进启用：AXIOM_META_LOOP_A/B/C/D=1 独立开关
 *   - 影子模式：前 N 次只记录不生效（收集数据验证安全性）
 *
 * 不修改任何已有接口——纯连线：已有产出端 → 安全门 → 已有消费端。
 */

import { eventBus } from "./event-bus.js";
import { ruleEngine, type RuleType } from "./rule-engine.js";
import { logger } from "../../utils/logger.js";
import { readString, readInt, readBool } from "../../utils/env.js";

// ========== 安全门 ==========

interface SafetyGateConfig {
  /** 置信度阈值：低于此值只记录不生效 */
  confidenceThreshold: number;
  /** 时间窗口内最大动作数 */
  maxActionsPerWindow: number;
  /** 时间窗口（ms） */
  windowMs: number;
  /** 影子模式次数：前 N 次只记录不生效 */
  shadowModeCount: number;
  /** 总预算：累计动作上限 */
  budget: number;
  /** 开关 */
  enabled: boolean;
}

class SafetyGate {
  private config: SafetyGateConfig;
  private actionTimestamps: number[] = [];
  private totalActions = 0;
  private shadowCount = 0;

  constructor(config: SafetyGateConfig) {
    this.config = config;
  }

  /** 检查是否允许执行动作 */
  allow(confidence: number): { proceed: boolean; reason: string } {
    if (!this.config.enabled) {
      return { proceed: false, reason: "disabled" };
    }

    // 影子模式
    if (this.shadowCount < this.config.shadowModeCount) {
      this.shadowCount++;
      return { proceed: false, reason: `shadow-mode (${this.shadowCount}/${this.config.shadowModeCount})` };
    }

    // 置信度
    if (confidence < this.config.confidenceThreshold) {
      return { proceed: false, reason: `confidence ${confidence.toFixed(2)} < threshold ${this.config.confidenceThreshold}` };
    }

    // 预算
    if (this.totalActions >= this.config.budget) {
      return { proceed: false, reason: `budget exhausted (${this.totalActions}/${this.config.budget})` };
    }

    // 限流
    const now = Date.now();
    this.actionTimestamps = this.actionTimestamps.filter(
      (t) => now - t < this.config.windowMs,
    );
    if (this.actionTimestamps.length >= this.config.maxActionsPerWindow) {
      return { proceed: false, reason: `rate-limited (${this.actionTimestamps.length}/${this.config.maxActionsPerWindow} per ${this.config.windowMs}ms)` };
    }

    return { proceed: true, reason: "ok" };
  }

  /** 记录一次成功动作 */
  recordAction(): void {
    this.actionTimestamps.push(Date.now());
    this.totalActions++;
  }

  /** 获取统计 */
  getStats() {
    return {
      totalActions: this.totalActions,
      shadowCount: this.shadowCount,
      recentActions: this.actionTimestamps.length,
      budgetRemaining: this.config.budget - this.totalActions,
    };
  }
}

// ========== Bridge A: Lessons → Rules ==========

/**
 * 教训解析器：将自由文本教训转化为结构化规则候选。
 *
 * 确定性模式匹配（不使用 LLM）——保持传动轴的确定性。
 * 无法匹配的教训跳过（安全：不生成低质量规则）。
 */
function parseLesson(lesson: string): {
  type: RuleType;
  name: string;
  condition: string;
  action: string;
  confidence: number;
} | null {
  const lower = lesson.toLowerCase();

  // 模式 1: 超时
  if (lower.includes("timeout") || lower.includes("超时")) {
    return {
      type: "action",
      name: `auto-timeout-${Date.now().toString(36)}`,
      condition: "timeout_detected exists",
      action: "retry_with_exponential_backoff",
      confidence: 0.75,
    };
  }

  // 模式 2: 约束违反
  if (lower.includes("constraint") && lower.includes("violat")) {
    return {
      type: "constraint",
      name: `auto-constraint-${Date.now().toString(36)}`,
      condition: "constraint_violation exists",
      action: "flag_and_log_violation",
      confidence: 0.8,
    };
  }

  // 模式 3: 推理空洞
  if (lower.includes("gap") || lower.includes("missing") || lower.includes("空洞")) {
    return {
      type: "inference",
      name: `auto-gap-${Date.now().toString(36)}`,
      condition: "reasoning_gap exists",
      action: "request_additional_context",
      confidence: 0.7,
    };
  }

  // 模式 4: 并发问题
  if (lower.includes("concurrent") || lower.includes("race") || lower.includes("并发")) {
    return {
      type: "validation",
      name: `auto-concurrency-${Date.now().toString(36)}`,
      condition: "concurrent_access exists",
      action: "serialize_and_verify",
      confidence: 0.72,
    };
  }

  // 模式 5: 降级
  if (lower.includes("fallback") || lower.includes("degrad") || lower.includes("降级")) {
    return {
      type: "routing",
      name: `auto-fallback-${Date.now().toString(36)}`,
      condition: "primary_path_failed exists",
      action: "use_deterministic_fallback",
      confidence: 0.68,
    };
  }

  // 无法匹配——安全跳过
  return null;
}

class LessonsToRulesBridge {
  private gate: SafetyGate;
  private seenLessons = new Set<string>();
  /**
   * 去重集合上限（2026-10-14 全仓审核发现 4）。
   *
   * 当前 lesson 仅由 consciousness 的 3 个硬编码触发器产出（约 5 种形态），
   * 基数实际有界，故这不是已发生的泄漏。但容器原本无任何上限：一旦 lesson
   * 转为 LLM 生成自由文本，长驻进程将无界增长。Set 保持插入序，超限即删
   * 最旧条目（FIFO），保证内存占用恒定。
   */
  private readonly maxSeenLessons = 1000;

  constructor(gate: SafetyGate) {
    this.gate = gate;
  }

  process(lessons: string[], traceContext: string): void {
    for (const lesson of lessons) {
      // 去重：相同教训不重复处理
      const lessonKey = lesson.slice(0, 100);
      if (this.seenLessons.has(lessonKey)) continue;
      this.seenLessons.add(lessonKey);
      if (this.seenLessons.size > this.maxSeenLessons) {
        // Set 迭代顺序 = 插入顺序，首个即最旧
        const oldest = this.seenLessons.values().next().value;
        if (oldest !== undefined) this.seenLessons.delete(oldest);
      }

      const parsed = parseLesson(lesson);
      if (!parsed) {
        logger.debug("[MetaLoop/A] lesson unparseable, skipped", { lesson: lesson.slice(0, 80) });
        continue;
      }

      const decision = this.gate.allow(parsed.confidence);
      if (!decision.proceed) {
        logger.debug("[MetaLoop/A] lesson gated", {
          reason: decision.reason,
          confidence: parsed.confidence,
        });
        eventBus.publish({
          type: "meta.loop.a.gated",
          source: "meta-cognitive-loop",
          data: { lesson: lesson.slice(0, 80), reason: decision.reason, parsed: parsed.name },
          priority: "low",
        });
        continue;
      }

      // 执行：调用已有的 ruleEngine.learn()
      const rule = ruleEngine.learn(
        parsed.type,
        parsed.name,
        parsed.condition,
        parsed.action,
        `auto-learned from lesson: "${lesson.slice(0, 120)}" in context: ${traceContext.slice(0, 80)}`,
        parsed.confidence,
      );

      this.gate.recordAction();

      logger.info("[MetaLoop/A] lesson → rule", {
        ruleId: rule.id,
        ruleName: rule.name,
        confidence: parsed.confidence,
      });

      eventBus.publish({
        type: "meta.loop.a.learned",
        source: "meta-cognitive-loop",
        data: {
          ruleId: rule.id,
          ruleType: parsed.type,
          fromLesson: lesson.slice(0, 100),
        },
        priority: "normal",
      });
    }
  }

  getStats() {
    return { gate: this.gate.getStats(), seenLessons: this.seenLessons.size };
  }
}

// ========== Bridge D: Issues → Pipeline Adaptation ==========

interface IssuePattern {
  pattern: string;
  occurrences: number;
  firstSeen: number;
  lastSeen: number;
  proposedAdjustment: {
    searchLimitDelta: number;     // 搜索结果数微调
    minConfidenceDelta: number;   // 置信度阈值微调
  };
}

class IssuesToAdaptationBridge {
  private gate: SafetyGate;
  private patterns = new Map<string, IssuePattern>();
  /** 同一 issue 类型需要重复出现多少次才触发适应 */
  private readonly patternThreshold = 3;
  /**
   * 追踪模式上限（2026-10-14 全仓审核发现 4）。
   *
   * 同 seenLessons：当前 issue 由硬编码触发器产出（约 4 类），基数有界，
   * 未构成实际泄漏；但容器原本无上限。Map 保持插入序，超限淘汰最旧 key。
   */
  private readonly maxPatterns = 1000;

  constructor(gate: SafetyGate) {
    this.gate = gate;
  }

  process(issues: string[], traceContext: string): void {
    for (const issue of issues) {
      const issueKey = issue.slice(0, 80).toLowerCase();
      const existing = this.patterns.get(issueKey);

      if (existing) {
        existing.occurrences++;
        existing.lastSeen = Date.now();
      } else {
        this.patterns.set(issueKey, {
          pattern: issue.slice(0, 80),
          occurrences: 1,
          firstSeen: Date.now(),
          lastSeen: Date.now(),
          proposedAdjustment: this.proposeAdjustment(issue),
        });
        if (this.patterns.size > this.maxPatterns) {
          // Map 迭代顺序 = 插入顺序，首个即最旧
          const oldestKey = this.patterns.keys().next().value;
          if (oldestKey !== undefined) this.patterns.delete(oldestKey);
        }
      }

      // 模式检测：同一 issue 重复出现 ≥ threshold
      const pattern = this.patterns.get(issueKey)!;
      if (pattern.occurrences >= this.patternThreshold) {
        const confidence = Math.min(0.9, 0.6 + pattern.occurrences * 0.05);
        const decision = this.gate.allow(confidence);

        if (!decision.proceed) {
          logger.debug("[MetaLoop/D] adaptation gated", {
            reason: decision.reason,
            pattern: pattern.pattern,
            occurrences: pattern.occurrences,
          });
          continue;
        }

        // 执行：通过 EventBus 发布参数微调建议
        // 消费方（CognitivePipeline 或 ConfigLoader）可订阅并应用
        eventBus.publish({
          type: "meta.loop.d.adapt",
          source: "meta-cognitive-loop",
          data: {
            pattern: pattern.pattern,
            occurrences: pattern.occurrences,
            adjustment: pattern.proposedAdjustment,
            context: traceContext.slice(0, 80),
          },
          priority: "normal",
        });

        this.gate.recordAction();

        logger.info("[MetaLoop/D] issue pattern → adaptation proposal", {
          pattern: pattern.pattern,
          occurrences: pattern.occurrences,
          adjustment: pattern.proposedAdjustment,
        });

        // 重置该模式的计数（避免持续触发）
        pattern.occurrences = 0;
      }
    }
  }

  /** 根据问题类型提出参数微调建议 */
  private proposeAdjustment(issue: string): IssuePattern["proposedAdjustment"] {
    const lower = issue.toLowerCase();

    if (lower.includes("knowledge") || lower.includes("context") || lower.includes("知识")) {
      // 知识不足 → 增加搜索结果数
      return { searchLimitDelta: +2, minConfidenceDelta: 0 };
    }

    if (lower.includes("confidence") || lower.includes("low") || lower.includes("置信")) {
      // 置信度过低 → 降低阈值以纳入更多结果
      return { searchLimitDelta: 0, minConfidenceDelta: -0.05 };
    }

    if (lower.includes("noise") || lower.includes("irrelevant") || lower.includes("噪声")) {
      // 噪声过多 → 提高阈值以过滤
      return { searchLimitDelta: 0, minConfidenceDelta: +0.05 };
    }

    // 默认：不调整
    return { searchLimitDelta: 0, minConfidenceDelta: 0 };
  }

  getStats() {
    return {
      gate: this.gate.getStats(),
      trackedPatterns: this.patterns.size,
      patternsAboveThreshold: Array.from(this.patterns.values()).filter(
        (p) => p.occurrences >= this.patternThreshold,
      ).length,
    };
  }
}

// ========== MetaCognitiveLoop 主体 ==========

export interface MetaCognitiveLoopStats {
  bridgeA: { gate: ReturnType<SafetyGate["getStats"]>; seenLessons: number };
  bridgeD: {
    gate: ReturnType<SafetyGate["getStats"]>;
    trackedPatterns: number;
    patternsAboveThreshold: number;
  };
  totalCompleted: number;
}

export class MetaCognitiveLoop {
  private bridgeA: LessonsToRulesBridge;
  private bridgeD: IssuesToAdaptationBridge;
  private subscriptionId: string | null = null;
  private totalCompleted = 0;

  constructor() {
    // Bridge A: lessons → rules
    this.bridgeA = new LessonsToRulesBridge(
      new SafetyGate({
        enabled: readBool("AXIOM_META_LOOP_A", true),
        confidenceThreshold: readInt("AXIOM_META_LOOP_A_CONF", 70, { min: 0, max: 100 }) / 100,
        maxActionsPerWindow: readInt("AXIOM_META_LOOP_A_RATE", 10, { min: 1, max: 1000 }),
        windowMs: 3600_000, // 1h
        shadowModeCount: readInt("AXIOM_META_LOOP_A_SHADOW", 50, { min: 0, max: 10000 }),
        budget: readInt("AXIOM_META_LOOP_A_BUDGET", 100, { min: 1, max: 100000 }),
      }),
    );

    // Bridge D: issues → adaptation
    this.bridgeD = new IssuesToAdaptationBridge(
      new SafetyGate({
        enabled: readBool("AXIOM_META_LOOP_D", true),
        confidenceThreshold: readInt("AXIOM_META_LOOP_D_CONF", 80, { min: 0, max: 100 }) / 100,
        maxActionsPerWindow: 1, // 每小时最多 1 次适应
        windowMs: 3600_000,
        shadowModeCount: readInt("AXIOM_META_LOOP_D_SHADOW", 100, { min: 0, max: 100000 }),
        budget: readInt("AXIOM_META_LOOP_D_BUDGET", 20, { min: 1, max: 10000 }),
      }),
    );
  }

  /** 启动：订阅 cognitive.pipeline.completed 事件 */
  start(): void {
    if (this.subscriptionId) {
      logger.warn("[MetaLoop] already started");
      return;
    }

    this.subscriptionId = eventBus.subscribe(
      "cognitive.pipeline.completed",
      async (event) => {
        this.totalCompleted++;
        const data = event.data as {
          lessons?: string[];
          issues?: string[];
          input?: string;
          confidence?: number;
        };

        const context = data.input ?? "unknown";

        // Bridge A: lessons → rules
        if (data.lessons && data.lessons.length > 0) {
          try {
            this.bridgeA.process(data.lessons, context);
          } catch (err) {
            logger.warn("[MetaLoop/A] bridge error", { error: (err as Error).message });
          }
        }

        // Bridge D: issues → adaptation
        if (data.issues && data.issues.length > 0) {
          try {
            this.bridgeD.process(data.issues, context);
          } catch (err) {
            logger.warn("[MetaLoop/D] bridge error", { error: (err as Error).message });
          }
        }
      },
      0, // 优先级 0（后台）
    );

    logger.info("[MetaLoop] started", {
      bridgeA: readBool("AXIOM_META_LOOP_A", true),
      bridgeD: readBool("AXIOM_META_LOOP_D", true),
    });
  }

  /** 停止 */
  stop(): void {
    if (this.subscriptionId) {
      eventBus.unsubscribe(this.subscriptionId);
      this.subscriptionId = null;
      logger.info("[MetaLoop] stopped");
    }
  }

  /** 获取统计 */
  getStats(): MetaCognitiveLoopStats {
    return {
      bridgeA: this.bridgeA.getStats(),
      bridgeD: this.bridgeD.getStats(),
      totalCompleted: this.totalCompleted,
    };
  }
}

// ========== 单例 ==========

let metaLoopInstance: MetaCognitiveLoop | null = null;

export function getMetaCognitiveLoop(): MetaCognitiveLoop {
  if (!metaLoopInstance) {
    metaLoopInstance = new MetaCognitiveLoop();
  }
  return metaLoopInstance;
}
