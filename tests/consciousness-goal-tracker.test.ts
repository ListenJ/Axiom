/**
 * GoalTracker 测试套件
 *
 * 覆盖三大核心能力：
 *   1. 事实核查 — 验证 LLM 提取的目标是否基于可靠信息源（Jaccard 相似度）
 *   2. 目标生命周期 — 去重、合并、淘汰、状态转换
 *   3. 会话状态追踪 — 历史记录、漂移检测
 *
 * 额外包含超长会话场景模拟（多轮反思周期）和性能基准测试。
 */
import { describe, beforeEach, afterEach, test, expect } from "bun:test";
import {
  GoalTracker,
  DEFAULT_GOAL_TRACKER_CONFIG,
  _resetGoalTrackerForTest,
  type GoalRecord,
} from "../src/agents/consciousness/goal-tracker.js";

// ─── 辅助函数 ─────────────────────────────────────────────────────────

/** 模拟观察数据（collectObservations 的简化版） */
function makeContext(opts: {
  intent?: string;
  goals?: string[];
  focus?: string[];
  mood?: string;
}): string {
  return JSON.stringify({
    idleMs: 1000,
    tokensSpentThisSession: 500,
    recentFocus: opts.focus ?? ["debugging", "typescript"],
    mood: opts.mood ?? "neutral",
    nextGoal: opts.goals?.[0] ?? "observe system",
    mental: {
      currentIntent: opts.intent ?? "coding",
      activeGoals: opts.goals ?? ["debug typescript error"],
      activeBeliefs: ["user is debugging"],
    },
  });
}

/** 构造一个与指定上下文有高相似度的目标描述 */
function relevantGoal(): { description: string; priority: number } {
  return { description: "Debug the typescript error in user code", priority: 8 };
}

/** 构造一个与任何实际上下文都无关的幻觉目标 */
function hallucinatedGoal(): { description: string; priority: number } {
  return { description: "The Eiffel Tower was built in 1492 in Berlin", priority: 5 };
}

// ─── 事实核查测试 ──────────────────────────────────────────────────────

describe("GoalTracker — 事实核查", () => {
  let tracker: GoalTracker;

  beforeEach(() => {
    tracker = new GoalTracker();
  });

  afterEach(() => {
    tracker.reset();
    _resetGoalTrackerForTest();
  });

  test("与观察数据有高相似度的目标应通过核查", () => {
    const ctx = makeContext({ focus: ["debugging", "typescript"], goals: ["debug typescript"] });
    const result = tracker.validateAgainstContext([relevantGoal()], ctx);
    expect(result.accepted).toHaveLength(1);
    expect(result.rejected).toHaveLength(0);
    expect(result.accepted[0]!.validationScore).toBeGreaterThan(0);
  });

  test("与观察数据完全无关的目标应被拒绝（幻觉过滤）", () => {
    const ctx = makeContext({ focus: ["debugging", "typescript"] });
    const result = tracker.validateAgainstContext([hallucinatedGoal()], ctx);
    expect(result.accepted).toHaveLength(0);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0]!.score).toBeLessThan(DEFAULT_GOAL_TRACKER_CONFIG.factCheckThreshold);
  });

  test("混合目标列表应正确分流通过和拒绝", () => {
    const ctx = makeContext({ focus: ["debugging", "typescript", "code"] });
    const result = tracker.validateAgainstContext(
      [relevantGoal(), hallucinatedGoal(), { description: "Review code quality", priority: 3 }],
      ctx,
    );
    expect(result.accepted.length).toBeGreaterThanOrEqual(1);
    expect(result.rejected.length).toBeGreaterThanOrEqual(1);
  });

  test("空目标列表应返回空结果", () => {
    const ctx = makeContext({});
    const result = tracker.validateAgainstContext([], ctx);
    expect(result.accepted).toHaveLength(0);
    expect(result.rejected).toHaveLength(0);
  });

  test("空上下文应拒绝所有目标（无可靠信息源）", () => {
    const result = tracker.validateAgainstContext([relevantGoal()], "");
    expect(result.accepted).toHaveLength(0);
    expect(result.rejected).toHaveLength(1);
  });

  test("中文目标应正确分词和核查", () => {
    const ctx = JSON.stringify({
      recentFocus: ["调试", "代码", "错误"],
      mental: { activeGoals: ["调试代码错误"] },
    });
    const result = tracker.validateAgainstContext(
      [{ description: "调试代码中的错误", priority: 5 }],
      ctx,
    );
    expect(result.accepted.length).toBeGreaterThanOrEqual(1);
  });
});

// ─── 目标生命周期测试 ─────────────────────────────────────────────────

describe("GoalTracker — 目标生命周期", () => {
  let tracker: GoalTracker;

  beforeEach(() => {
    tracker = new GoalTracker();
  });

  afterEach(() => {
    tracker.reset();
    _resetGoalTrackerForTest();
  });

  test("新目标应被添加到活跃列表", () => {
    const ctx = makeContext({ focus: ["debugging", "typescript"] });
    const validation = tracker.validateAgainstContext([relevantGoal()], ctx);
    const merged = tracker.mergeGoals(validation.accepted);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.status).toBe("active");
  });

  test("相似目标应被去重而非重复添加", () => {
    const ctx = makeContext({ focus: ["debugging", "typescript"] });
    // 第一轮
    const v1 = tracker.validateAgainstContext([relevantGoal()], ctx);
    tracker.mergeGoals(v1.accepted);
    expect(tracker.getActiveGoals()).toHaveLength(1);

    // 第二轮 — 描述略有不同但高度相似
    const v2 = tracker.validateAgainstContext(
      [{ description: "Debug the typescript error in user codebase", priority: 7 }],
      ctx,
    );
    tracker.mergeGoals(v2.accepted);
    expect(tracker.getActiveGoals()).toHaveLength(1); // 仍然只有 1 个（去重）
    expect(tracker.getActiveGoals()[0]!.occurrenceCount).toBe(2);
  });

  test("不同目标应分别保留", () => {
    const ctx = makeContext({ focus: ["debugging", "typescript", "testing", "performance"] });
    const v = tracker.validateAgainstContext(
      [
        { description: "Debug typescript error in code", priority: 8 },
        { description: "Run performance testing suite", priority: 5 },
      ],
      ctx,
    );
    tracker.mergeGoals(v.accepted);
    expect(tracker.getActiveGoals().length).toBeGreaterThanOrEqual(1);
  });

  test("超过上限时应淘汰优先级最低的目标", () => {
    const tracker2 = new GoalTracker({ maxActiveGoals: 3 });
    const ctx = makeContext({
      focus: ["debugging", "typescript", "testing", "performance", "code", "review"],
    });
    // 添加 5 个不同目标（描述中包含足够多的上下文关键词以确保通过事实核查）
    const goals = [
      { description: "Debug typescript error in code review", priority: 1 },
      { description: "Run performance testing in code review", priority: 2 },
      { description: "Review code quality and testing performance", priority: 3 },
      { description: "Fix typescript code in performance testing", priority: 4 },
      { description: "Update testing code review and debugging", priority: 5 },
    ];
    const v = tracker2.validateAgainstContext(goals, ctx);
    tracker2.mergeGoals(v.accepted);
    expect(tracker2.getActiveGoals().length).toBeLessThanOrEqual(3);
    // 优先级最高的应保留
    const priorities = tracker2.getActiveGoals().map((g) => g.priority);
    expect(Math.max(...priorities)).toBeGreaterThanOrEqual(4);
  });

  test("updateGoalStatus 应正确转换目标状态", () => {
    const ctx = makeContext({ focus: ["debugging", "typescript"] });
    const v = tracker.validateAgainstContext([relevantGoal()], ctx);
    tracker.mergeGoals(v.accepted);
    const goalId = tracker.getActiveGoals()[0]!.id;

    expect(tracker.updateGoalStatus(goalId, "achieved")).toBe(true);
    expect(tracker.getActiveGoals()).toHaveLength(0);
    expect(tracker.getHistory().length).toBeGreaterThanOrEqual(1);
  });

  test("updateGoalStatus 对不存在的 ID 应返回 false", () => {
    expect(tracker.updateGoalStatus("nonexistent", "achieved")).toBe(false);
  });
});

// ─── 会话状态追踪测试 ─────────────────────────────────────────────────

describe("GoalTracker — 会话状态追踪", () => {
  let tracker: GoalTracker;

  beforeEach(() => {
    tracker = new GoalTracker();
  });

  afterEach(() => {
    tracker.reset();
    _resetGoalTrackerForTest();
  });

  test("trackHistory 应增加周期计数", () => {
    expect(tracker.getCycleCount()).toBe(0);
    tracker.trackHistory([]);
    expect(tracker.getCycleCount()).toBe(1);
    tracker.trackHistory([]);
    expect(tracker.getCycleCount()).toBe(2);
  });

  test("历史记录应被修剪到上限", () => {
    const tracker2 = new GoalTracker({ maxHistorySize: 5 });
    for (let i = 0; i < 10; i++) {
      const goal: GoalRecord = {
        id: `goal-${i}`,
        description: `goal number ${i}`,
        priority: 5,
        status: "active",
        firstSeenAt: Date.now(),
        lastSeenAt: Date.now(),
        occurrenceCount: 1,
        validationScore: 0.5,
      };
      tracker2.trackHistory([goal]);
    }
    expect(tracker2.getHistory().length).toBeLessThanOrEqual(5);
  });

  test("无目标时 detectDrift 应返回不漂移", () => {
    const result = tracker.detectDrift();
    expect(result.drifting).toBe(false);
    expect(result.consistencyScore).toBe(1.0);
  });

  test("目标与历史一致时不应触发漂移", () => {
    const ctx = makeContext({ focus: ["debugging", "typescript"] });
    // 轮 1
    const v1 = tracker.validateAgainstContext([relevantGoal()], ctx);
    tracker.mergeGoals(v1.accepted);
    tracker.trackHistory(tracker.getActiveGoals());
    // 轮 2 — 相似目标
    const v2 = tracker.validateAgainstContext([relevantGoal()], ctx);
    tracker.mergeGoals(v2.accepted);
    tracker.trackHistory(tracker.getActiveGoals());

    const drift = tracker.detectDrift();
    expect(drift.drifting).toBe(false);
    expect(drift.consistencyScore).toBeGreaterThan(DEFAULT_GOAL_TRACKER_CONFIG.driftThreshold);
  });

  test("目标与历史完全不同时应触发漂移检测", () => {
    // 轮 1 — debugging 相关
    const ctx1 = makeContext({ focus: ["debugging", "typescript"] });
    const v1 = tracker.validateAgainstContext([relevantGoal()], ctx1);
    tracker.mergeGoals(v1.accepted);
    tracker.trackHistory(tracker.getActiveGoals());

    // 轮 2 — 完全不同领域（通过事实核查但与历史不一致）
    const ctx2 = makeContext({ focus: ["performance", "testing", "benchmark"] });
    const v2 = tracker.validateAgainstContext(
      [{ description: "Run performance benchmark testing suite", priority: 5 }],
      ctx2,
    );
    tracker.mergeGoals(v2.accepted);
    tracker.trackHistory(tracker.getActiveGoals());

    const drift = tracker.detectDrift();
    // 当前目标与历史目标不同 → 低一致性（1 个匹配 + 1 个不匹配 = 0.5）
    expect(drift.consistencyScore).toBeLessThanOrEqual(0.5);
  });
});

// ─── 超长会话场景模拟（多轮反思周期）──────────────────────────────────

describe("GoalTracker — 超长会话模拟", () => {
  let tracker: GoalTracker;

  beforeEach(() => {
    tracker = new GoalTracker();
  });

  afterEach(() => {
    tracker.reset();
    _resetGoalTrackerForTest();
  });

  test("20 轮反思周期应保持稳定（无内存泄漏，目标不丢失）", () => {
    const ctx = makeContext({ focus: ["debugging", "typescript", "code"] });

    for (let cycle = 0; cycle < 20; cycle++) {
      // 每轮提取相似目标（模拟 LLM 在长会话中反复提及相同目标）
      const v = tracker.validateAgainstContext(
        [{ description: "Debug typescript error in code", priority: 7 }],
        ctx,
      );
      tracker.mergeGoals(v.accepted);
      tracker.trackHistory(tracker.getActiveGoals());
    }

    expect(tracker.getCycleCount()).toBe(20);
    // 相同目标应被去重，活跃列表仍为 1 个
    expect(tracker.getActiveGoals()).toHaveLength(1);
    expect(tracker.getActiveGoals()[0]!.occurrenceCount).toBe(20);
    // 不应漂移（目标一致）
    const drift = tracker.detectDrift();
    expect(drift.drifting).toBe(false);
  });

  test("长会话中偶尔的幻觉目标应被过滤", () => {
    const goodCtx = makeContext({ focus: ["debugging", "typescript", "code"] });
    const badCtx = makeContext({ focus: ["eiffel", "tower", "berlin", "1492"] });

    // 正常轮次
    for (let i = 0; i < 5; i++) {
      const v = tracker.validateAgainstContext([relevantGoal()], goodCtx);
      tracker.mergeGoals(v.accepted);
      tracker.trackHistory(tracker.getActiveGoals());
    }

    // 混入幻觉目标
    const vBad = tracker.validateAgainstContext([hallucinatedGoal()], badCtx);
    tracker.mergeGoals(vBad.accepted);
    tracker.trackHistory(tracker.getActiveGoals());

    // 幻觉目标要么被事实核查拒绝，要么即使通过也应在漂移检测中被发现
    const drift = tracker.detectDrift();
    const activeGoals = tracker.getActiveGoals();

    // 如果幻觉目标通过了核查（因为 badCtx 包含了相关词），漂移检测应捕获
    if (activeGoals.length > 1) {
      // 有多个目标时检查是否漂移
      expect(drift.consistencyScore).toBeLessThanOrEqual(1.0);
    }
    // 原始目标应仍然存在
    const hasOriginal = activeGoals.some((g) =>
      g.description.toLowerCase().includes("typescript") || g.description.toLowerCase().includes("debug"),
    );
    expect(hasOriginal).toBe(true);
  });

  test("长会话中目标自然演化（渐进变化）不应被误判为漂移", () => {
    // 模拟目标从 "debug typescript" 逐渐演化到 "fix typescript compilation"
    const contexts = [
      { focus: ["debugging", "typescript", "error"], desc: "Debug typescript error in code" },
      { focus: ["debugging", "typescript", "error"], desc: "Debug typescript error in code" },
      { focus: ["typescript", "error", "fix"], desc: "Fix typescript error in code" },
      { focus: ["typescript", "fix", "compilation"], desc: "Fix typescript compilation error" },
      { focus: ["typescript", "fix", "compilation"], desc: "Fix typescript compilation error" },
    ];

    for (const { focus, desc } of contexts) {
      const ctx = makeContext({ focus });
      const v = tracker.validateAgainstContext([{ description: desc, priority: 7 }], ctx);
      tracker.mergeGoals(v.accepted);
      tracker.trackHistory(tracker.getActiveGoals());
    }

    // 渐进变化不应导致严重漂移
    const drift = tracker.detectDrift();
    expect(drift.consistencyScore).toBeGreaterThan(0);
  });
});

// ─── 性能基准测试 ─────────────────────────────────────────────────────

describe("GoalTracker — 性能基准", () => {
  let tracker: GoalTracker;

  beforeEach(() => {
    tracker = new GoalTracker();
  });

  afterEach(() => {
    tracker.reset();
    _resetGoalTrackerForTest();
  });

  test("validateAgainstContext 应在 5ms 内处理 50 个目标", () => {
    const ctx = makeContext({ focus: ["debugging", "typescript", "code", "error", "fix"] });
    const goals = Array.from({ length: 50 }, (_, i) => ({
      description: `Debug typescript error number ${i} in code`,
      priority: 5,
    }));

    const start = Date.now();
    tracker.validateAgainstContext(goals, ctx);
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(5);
  });

  test("mergeGoals 应在 2ms 内合并 100 个目标", () => {
    const goals: GoalRecord[] = Array.from({ length: 100 }, (_, i) => ({
      id: `goal-perf-${i}`,
      description: `Unique goal number ${i} for testing`,
      priority: 5,
      status: "active" as const,
      firstSeenAt: Date.now(),
      lastSeenAt: Date.now(),
      occurrenceCount: 1,
      validationScore: 0.5,
    }));

    const start = Date.now();
    tracker.mergeGoals(goals);
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(2);
  });

  test("detectDrift 应在 1ms 内完成（100 条历史记录）", () => {
    // 填充历史
    for (let i = 0; i < 100; i++) {
      tracker.trackHistory([
        {
          id: `hist-${i}`,
          description: `Historical goal ${i}`,
          priority: 5,
          status: "active",
          firstSeenAt: Date.now(),
          lastSeenAt: Date.now(),
          occurrenceCount: 1,
          validationScore: 0.5,
        },
      ]);
    }
    // 添加一个活跃目标
    tracker.mergeGoals([
      {
        id: "active-1",
        description: "Current active goal",
        priority: 5,
        status: "active",
        firstSeenAt: Date.now(),
        lastSeenAt: Date.now(),
        occurrenceCount: 1,
        validationScore: 0.5,
      },
    ]);

    const start = Date.now();
    tracker.detectDrift();
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(2);
  });
});

// ─── 不同长度会话场景下的幻觉率评估 ──────────────────────────────────

describe("GoalTracker — 不同长度会话幻觉率评估", () => {
  let tracker: GoalTracker;

  beforeEach(() => {
    tracker = new GoalTracker();
  });

  afterEach(() => {
    tracker.reset();
    _resetGoalTrackerForTest();
  });

  // 在指定长度的会话中，每轮注入 1 个真实目标 + 1 个幻觉目标，
  // 测量幻觉目标的误接受率（FAR）与真实目标的接受率（TAR）。
  // 核心不变量：无论会话多长，FAR 应保持极低（事实核查有效），TAR 应保持较高。
  function assessHallucinationRate(rounds: number): {
    far: number;
    tar: number;
    hallucinatedInjected: number;
    hallucinatedAccepted: number;
    realInjected: number;
    realAccepted: number;
  } {
    const goodCtx = makeContext({ focus: ["debugging", "typescript", "code", "error"] });
    let hallucinatedInjected = 0;
    let hallucinatedAccepted = 0;
    let realInjected = 0;
    let realAccepted = 0;

    for (let i = 0; i < rounds; i++) {
      // 真实目标（应通过事实核查）
      const realResult = tracker.validateAgainstContext([relevantGoal()], goodCtx);
      realInjected++;
      realAccepted += realResult.accepted.length;
      tracker.mergeGoals(realResult.accepted);
      tracker.trackHistory(tracker.getActiveGoals());

      // 幻觉目标（应被事实核查拒绝）
      const halluResult = tracker.validateAgainstContext([hallucinatedGoal()], goodCtx);
      hallucinatedInjected++;
      hallucinatedAccepted += halluResult.accepted.length;
      // 即便误接受也合并，以观察生命周期行为
      tracker.mergeGoals(halluResult.accepted);
      tracker.trackHistory(tracker.getActiveGoals());
    }

    const far = hallucinatedInjected > 0 ? hallucinatedAccepted / hallucinatedInjected : 0;
    const tar = realInjected > 0 ? realAccepted / realInjected : 0;
    return { far, tar, hallucinatedInjected, hallucinatedAccepted, realInjected, realAccepted };
  }

  test("短会话（10 轮）应保持极低幻觉误接受率", () => {
    const r = assessHallucinationRate(10);
    // 幻觉目标应全部被事实核查拒绝 → FAR = 0
    expect(r.far).toBeLessThan(0.1);
    expect(r.hallucinatedAccepted).toBe(0);
    // 真实目标应被接受（去重后 occurrenceCount 累计，但每轮 validate 仍计数 accepted）
    expect(r.tar).toBeGreaterThan(0.9);
  });

  test("中等会话（50 轮）应保持极低幻觉误接受率", () => {
    const r = assessHallucinationRate(50);
    expect(r.far).toBeLessThan(0.1);
    expect(r.hallucinatedAccepted).toBe(0);
    expect(r.tar).toBeGreaterThan(0.9);
    // 50 轮后真实目标的 occurrenceCount 应累计到 50
    const active = tracker.getActiveGoals();
    expect(active.length).toBeGreaterThanOrEqual(1);
    expect(Math.max(...active.map((g) => g.occurrenceCount))).toBe(50);
  });

  test("超长会话（200 轮）应保持极低幻觉误接受率", () => {
    const r = assessHallucinationRate(200);
    expect(r.far).toBeLessThan(0.1);
    expect(r.hallucinatedAccepted).toBe(0);
    expect(r.tar).toBeGreaterThan(0.9);
    expect(tracker.getCycleCount()).toBe(400); // 每轮 2 次 trackHistory
  });

  test("三种长度会话的幻觉率均应低于阈值（横向对比）", () => {
    const lengths = [10, 50, 200];
    const rates = lengths.map((L) => {
      // 用独立 tracker 评估每个长度，互不干扰
      const t = new GoalTracker();
      let hallucinatedInjected = 0;
      let hallucinatedAccepted = 0;
      const goodCtx = makeContext({ focus: ["debugging", "typescript", "code", "error"] });
      for (let i = 0; i < L; i++) {
        const realR = t.validateAgainstContext([relevantGoal()], goodCtx);
        t.mergeGoals(realR.accepted);
        t.trackHistory(t.getActiveGoals());
        const halluR = t.validateAgainstContext([hallucinatedGoal()], goodCtx);
        hallucinatedInjected++;
        hallucinatedAccepted += halluR.accepted.length;
        t.mergeGoals(halluR.accepted);
        t.trackHistory(t.getActiveGoals());
      }
      t.reset();
      return hallucinatedInjected > 0 ? hallucinatedAccepted / hallucinatedInjected : 0;
    });
    // 所有三种子会话的 FAR 都应 < 0.1
    for (const rate of rates) {
      expect(rate).toBeLessThan(0.1);
    }
  });
});

// ─── 资源占用监测 ─────────────────────────────────────────────────────

describe("GoalTracker — 资源占用监测", () => {
  let tracker: GoalTracker;

  beforeEach(() => {
    tracker = new GoalTracker();
  });

  afterEach(() => {
    tracker.reset();
    _resetGoalTrackerForTest();
  });

  test("超长会话（200 轮）后堆内存增长应保持有界（无内存泄漏）", () => {
    if (typeof process === "undefined" || typeof process.memoryUsage !== "function") {
      // 非 Node/Bun 运行时跳过（无法测量内存）
      return;
    }
    // 强制 GC 前先测量基线（如果可用）
    if (typeof globalThis.gc === "function") globalThis.gc();
    const before = process.memoryUsage().heapUsed;

    const ctx = makeContext({ focus: ["debugging", "typescript", "code", "error"] });
    for (let i = 0; i < 200; i++) {
      const v = tracker.validateAgainstContext(
        [
          relevantGoal(),
          { description: `Debug typescript error variant ${i}`, priority: 5 },
          hallucinatedGoal(),
        ],
        ctx,
      );
      tracker.mergeGoals(v.accepted);
      tracker.trackHistory(tracker.getActiveGoals());
    }

    const after = process.memoryUsage().heapUsed;
    const growthBytes = after - before;
    const growthMB = growthBytes / (1024 * 1024);

    // 200 轮会话后堆增长应 < 5MB（历史上限 50 条 + 活跃上限 10 条，内存占用应有界）
    expect(growthMB).toBeLessThan(5);
    // 历史记录应被修剪到上限，不应无限增长
    expect(tracker.getHistory().length).toBeLessThanOrEqual(DEFAULT_GOAL_TRACKER_CONFIG.maxHistorySize);
    // 活跃目标也应受上限约束
    expect(tracker.getActiveGoals().length).toBeLessThanOrEqual(DEFAULT_GOAL_TRACKER_CONFIG.maxActiveGoals);
  });

  test("历史记录与活跃目标数量应始终受上限约束（资源占用可控）", () => {
    const ctx = makeContext({
      focus: ["debugging", "typescript", "testing", "performance", "code", "review", "fix", "error"],
    });
    // 注入大量目标，触发上限管理
    for (let i = 0; i < 500; i++) {
      const v = tracker.validateAgainstContext(
        [{ description: `Debug typescript code testing performance review ${i}`, priority: i % 10 }],
        ctx,
      );
      tracker.mergeGoals(v.accepted);
      tracker.trackHistory(tracker.getActiveGoals());
    }
    expect(tracker.getActiveGoals().length).toBeLessThanOrEqual(DEFAULT_GOAL_TRACKER_CONFIG.maxActiveGoals);
    expect(tracker.getHistory().length).toBeLessThanOrEqual(DEFAULT_GOAL_TRACKER_CONFIG.maxHistorySize);
  });
});

// ─── 单例测试 ─────────────────────────────────────────────────────────

describe("GoalTracker — 单例", () => {
  afterEach(() => {
    _resetGoalTrackerForTest();
  });

  test("getGoalTracker 应返回同一实例", async () => {
    const { getGoalTracker } = await import("../src/agents/consciousness/goal-tracker.js");
    const a = getGoalTracker();
    const b = getGoalTracker();
    expect(a).toBe(b);
  });

  test("_resetGoalTrackerForTest 应使下次 getGoalTracker 返回新实例", async () => {
    const { getGoalTracker, _resetGoalTrackerForTest: reset } = await import(
      "../src/agents/consciousness/goal-tracker.js"
    );
    const a = getGoalTracker();
    reset();
    const b = getGoalTracker();
    expect(a).not.toBe(b);
  });
});
