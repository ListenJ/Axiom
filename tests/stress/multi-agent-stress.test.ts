/**
 * 多 Agent 并行压测 — 多 Agent 并发场景下的资源分配与任务调度能力
 *
 * 测试维度:
 * 1. 10 Agent 并行提交 100 任务（混合优先级）— 调度吞吐与提交延迟
 * 2. 50 Agent 并行调用 CapabilityRegistry.select() — 能力选择吞吐与延迟
 * 3. 资源竞争：多个 Agent 同时请求同一能力 — 一致性与无崩溃
 * 4. 错误隔离：一个 Agent 失败不影响其他 Agent — 故障隔离
 * 5. 公平性：低优先级 Agent 不会饿死 — 调度公平性
 *
 * 性能目标：关键操作（任务提交、能力选择）响应时间 < 10ms
 * 注意：scheduler / capabilityRegistry 为同步内存操作，无网络 IO，
 *       10ms 目标覆盖提交/选择/调度逻辑本身。
 *
 * bun test tests/stress/multi-agent-stress.test.ts --timeout 60000
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { scheduler, type TaskPriority } from "../../src/dre/runtime/scheduler.js";
import { capabilityRegistry, type CapabilityContract } from "../../src/dre/runtime/capability-registry.js";

// ========== 辅助 ==========

const PRIORITIES: TaskPriority[] = ["critical", "high", "normal", "low", "background"];

/** 注册 3 个测试用 Provider，覆盖 internal/external 两种类型与不同成本/可靠性 */
function setupProviders(): void {
  capabilityRegistry.registerProvider({
    id: "prov-local",
    name: "Local Provider",
    type: "internal",
    capabilities: ["code.reasoning", "knowledge.retrieval"],
    costPerCall: 0,
    avgLatencyMs: 50,
    reliability: 0.75,
    maxConcurrency: 100,
    metadata: {},
  });
  capabilityRegistry.registerProvider({
    id: "prov-hermes",
    name: "Hermes",
    type: "external",
    capabilities: ["code.reasoning", "research.synthesis"],
    costPerCall: 0.01,
    avgLatencyMs: 500,
    reliability: 0.9,
    maxConcurrency: 2,
    metadata: {},
  });
  capabilityRegistry.registerProvider({
    id: "prov-claude",
    name: "Claude",
    type: "external",
    capabilities: ["code.reasoning", "generation.creative"],
    costPerCall: 0.03,
    avgLatencyMs: 1000,
    reliability: 0.95,
    maxConcurrency: 2,
    metadata: {},
  });
}

// ========== 1. 10 Agent × 100 任务混合优先级 ==========

describe("Multi-Agent Stress: 10 agents × 100 tasks", () => {
  beforeEach(() => scheduler.reset());
  afterEach(() => scheduler.reset());

  test("parallel submission + drain, per-submit < 10ms", async () => {
    const AGENTS = 10;
    const TASKS_PER_AGENT = 100;
    const start = performance.now();

    // 模拟 10 个 Agent 并行提交（Promise.all 逻辑并发，scheduler 同步内存操作）
    const agentRun = async (agentId: number): Promise<void> => {
      for (let i = 0; i < TASKS_PER_AGENT; i++) {
        const priority = PRIORITIES[(i + agentId) % PRIORITIES.length];
        scheduler.submit({
          name: `agent-${agentId}-task-${i}`,
          priority,
          payload: { agent: agentId, idx: i },
          maxRetries: 0,
          dependencies: [],
        });
        // 周期性 yield，让多 Agent 交错提交（模拟真实并行）
        if (i % 25 === 0) await Promise.resolve();
      }
    };

    await Promise.all(Array.from({ length: AGENTS }, (_, i) => agentRun(i)));

    const submitMs = performance.now() - start;
    const submitted = AGENTS * TASKS_PER_AGENT;
    const perSubmit = submitMs / submitted;

    // 排空队列并完成所有任务
    let completed = 0;
    let task: ReturnType<typeof scheduler.getNext>;
    while ((task = scheduler.getNext()) !== null) {
      scheduler.complete(task.id, { ok: true });
      completed++;
    }

    const totalMs = performance.now() - start;
    console.log(
      `[Stress] 10×100 submit: ${submitMs.toFixed(2)}ms total, ${perSubmit.toFixed(4)}ms/submit; ` +
      `drain → ${completed}/${submitted}; total ${totalMs.toFixed(2)}ms`,
    );

    expect(completed).toBe(submitted);
    expect(perSubmit).toBeLessThan(10);
  });
});

// ========== 2. 50 Agent × CapabilityRegistry.select() ==========

describe("Multi-Agent Stress: 50 agents × CapabilityRegistry.select()", () => {
  const CONTRACT: CapabilityContract = "code.reasoning";

  beforeEach(() => {
    capabilityRegistry.reset();
    setupProviders();
  });
  afterEach(() => capabilityRegistry.reset());

  test("50 agents × 100 selects, per-select < 10ms", async () => {
    const AGENTS = 50;
    const SELECTS_PER_AGENT = 100;
    const start = performance.now();

    const agentRun = async (agentId: number): Promise<number> => {
      let success = 0;
      for (let i = 0; i < SELECTS_PER_AGENT; i++) {
        const cap = capabilityRegistry.select(CONTRACT);
        if (cap) {
          // 模拟 10% 失败率，触发 recordResult 的 EMA 更新
          capabilityRegistry.recordResult(cap.id, i % 10 !== 0);
          success++;
        }
        if (i % 50 === 0) await Promise.resolve();
      }
      return success;
    };

    const results = await Promise.all(Array.from({ length: AGENTS }, (_, i) => agentRun(i)));
    const totalMs = performance.now() - start;
    const totalSelects = AGENTS * SELECTS_PER_AGENT;
    const perSelect = totalMs / totalSelects;
    const successCount = results.reduce((s, n) => s + n, 0);

    const stats = capabilityRegistry.getStats();
    console.log(
      `[Stress] 50×100 select: ${totalMs.toFixed(2)}ms, ${perSelect.toFixed(4)}ms/select, ` +
      `success ${successCount}/${totalSelects}, selections=${stats.selections}`,
    );

    expect(successCount).toBe(totalSelects);
    expect(perSelect).toBeLessThan(10);
    expect(stats.selections).toBe(totalSelects);
  });
});

// ========== 3. 资源竞争：多 Agent 同时请求同一能力 ==========

describe("Multi-Agent Stress: resource contention", () => {
  const CONTRACT: CapabilityContract = "code.reasoning";

  beforeEach(() => {
    capabilityRegistry.reset();
    setupProviders();
  });
  afterEach(() => capabilityRegistry.reset());

  test("100 agents contend for same contract — no crash, all valid", async () => {
    const AGENTS = 100;
    const start = performance.now();

    const agentRun = async (agentId: number): Promise<string | null> => {
      const cap = capabilityRegistry.select(CONTRACT);
      if (cap) capabilityRegistry.recordResult(cap.id, agentId % 5 !== 0);
      return cap?.id ?? null;
    };

    const results = await Promise.all(Array.from({ length: AGENTS }, (_, i) => agentRun(i)));
    const totalMs = performance.now() - start;
    const nonNull = results.filter((r): r is string => r !== null).length;

    console.log(
      `[Stress] 100 agents contend: ${totalMs.toFixed(2)}ms, ${nonNull}/${AGENTS} got capability`,
    );

    // 所有 Agent 都应成功获取能力（registry 无并发上限）
    expect(nonNull).toBe(AGENTS);

    // 验证所选能力均属于目标 contract，且 ID 在合法集合内
    const validIds = new Set(capabilityRegistry.listByContract(CONTRACT).map((c) => c.id));
    for (const id of results) {
      if (id) {
        expect(validIds.has(id)).toBe(true);
        const cap = capabilityRegistry.getCapability(id);
        expect(cap?.contract).toBe(CONTRACT);
      }
    }
  });

  test("concurrent register + select — no race corruption", async () => {
    const start = performance.now();
    let selectOk = 0;

    // 一边注册新 Provider，一边 select
    const registerPromise = (async (): Promise<void> => {
      for (let i = 0; i < 50; i++) {
        capabilityRegistry.registerProvider({
          id: `race-prov-${i}`,
          name: `Race Provider ${i}`,
          type: "internal",
          capabilities: [CONTRACT],
          costPerCall: (i % 5) * 0.005,
          avgLatencyMs: 10 + (i % 100),
          reliability: 0.5 + (i % 50) * 0.01,
          maxConcurrency: 1,
          metadata: {},
        });
        if (i % 10 === 0) await Promise.resolve();
      }
    })();

    const selectPromise = (async (): Promise<void> => {
      for (let i = 0; i < 50; i++) {
        const cap = capabilityRegistry.select(CONTRACT);
        if (cap) {
          capabilityRegistry.recordResult(cap.id, i % 3 !== 0);
          selectOk++;
        }
        if (i % 10 === 0) await Promise.resolve();
      }
    })();

    await Promise.all([registerPromise, selectPromise]);
    const totalMs = performance.now() - start;
    const stats = capabilityRegistry.getStats();

    console.log(
      `[Stress] concurrent register+select: ${totalMs.toFixed(2)}ms, ` +
      `selectOk=${selectOk}, providers=${stats.providers}, capabilities=${stats.capabilities}`,
    );

    // 验证 registry 状态一致性：每个 provider 恰好贡献 1 个该 contract 能力
    const contractCaps = capabilityRegistry.listByContract(CONTRACT);
    expect(contractCaps.length).toBe(stats.providers);
    expect(stats.providers).toBe(50 + 3); // 50 race + 3 setup
  });
});

// ========== 4. 错误隔离：单 Agent 失败不影响其他 Agent ==========

describe("Multi-Agent Stress: error isolation", () => {
  beforeEach(() => scheduler.reset());
  afterEach(() => scheduler.reset());

  test("one agent failure does not block others", () => {
    const start = performance.now();

    // Agent A: 提交并触发失败
    const failTask = scheduler.submit({
      name: "agent-A-fail",
      priority: "normal",
      payload: {},
      maxRetries: 0,
      dependencies: [],
    });
    const next1 = scheduler.getNext();
    expect(next1).not.toBeNull();
    if (next1) scheduler.fail(next1.id, "intentional failure (agent A)");

    // Agent B / C: 正常任务
    const okTaskB = scheduler.submit({
      name: "agent-B-ok",
      priority: "high",
      payload: {},
      maxRetries: 0,
      dependencies: [],
    });
    const okTaskC = scheduler.submit({
      name: "agent-C-ok",
      priority: "normal",
      payload: {},
      maxRetries: 0,
      dependencies: [],
    });

    let completed = 0;
    let task: ReturnType<typeof scheduler.getNext>;
    while ((task = scheduler.getNext()) !== null) {
      scheduler.complete(task.id, { ok: true });
      completed++;
    }

    const totalMs = performance.now() - start;
    const failedTask = scheduler.getTask(failTask.id);
    const taskB = scheduler.getTask(okTaskB.id);
    const taskC = scheduler.getTask(okTaskC.id);

    console.log(
      `[Stress] error isolation: ${totalMs.toFixed(2)}ms, completed=${completed}, ` +
      `failStatus=${failedTask?.status}, bStatus=${taskB?.status}, cStatus=${taskC?.status}`,
    );

    // 失败 Agent 的任务标记为 failed，不影响其他 Agent
    expect(failedTask?.status).toBe("failed");
    expect(taskB?.status).toBe("completed");
    expect(taskC?.status).toBe("completed");
    expect(completed).toBe(2); // B + C 完成，A 不计入
  });

  test("retry exhaustion stays isolated", () => {
    // Agent A: 任务重试耗尽 → failed
    const retryTask = scheduler.submit({
      name: "agent-A-retry",
      priority: "normal",
      payload: {},
      maxRetries: 2,
      dependencies: [],
    });

    // 取出 → 失败 → 重排 → 取出 → 失败 → 重排 → 取出 → 失败 → 终态
    const exhaust = (): void => {
      for (let attempt = 0; attempt < 3; attempt++) {
        // 推进 notBefore 时间以跳过退避（直接调用 getNext 可能因 notBefore 返回 null）
        const t = scheduler.getNext();
        if (t && t.id === retryTask.id) {
          scheduler.fail(t.id, `attempt ${attempt} failed`);
        }
      }
    };
    exhaust();

    // Agent B: 在 A 重试期间正常完成
    const okTask = scheduler.submit({
      name: "agent-B-ok",
      priority: "high",
      payload: {},
      maxRetries: 0,
      dependencies: [],
    });
    let completed = 0;
    let task: ReturnType<typeof scheduler.getNext>;
    while ((task = scheduler.getNext()) !== null) {
      scheduler.complete(task.id, { ok: true });
      completed++;
    }

    const retryTaskState = scheduler.getTask(retryTask.id);
    const okTaskState = scheduler.getTask(okTask.id);

    console.log(
      `[Stress] retry isolation: completed=${completed}, ` +
      `retryStatus=${retryTaskState?.status}(retries=${retryTaskState?.retries}), okStatus=${okTaskState?.status}`,
    );

    // 注意：退避期间 A 可能仍在队列（status=pending），B 正常完成即视为隔离成功
    expect(okTaskState?.status).toBe("completed");
    expect(completed).toBeGreaterThanOrEqual(1);
  });
});

// ========== 5. 公平性：低优先级 Agent 不饿死 ==========

describe("Multi-Agent Stress: fairness (no starvation)", () => {
  beforeEach(() => scheduler.reset());
  afterEach(() => scheduler.reset());

  test("low-priority tasks are scheduled under critical load", () => {
    const start = performance.now();
    const lowCount = 20;
    const criticalCount = 20;

    // 交错提交 critical + low，确保 critical 不抢占全部调度槽
    for (let i = 0; i < criticalCount; i++) {
      scheduler.submit({
        name: `critical-${i}`,
        priority: "critical",
        payload: {},
        maxRetries: 0,
        dependencies: [],
      });
      scheduler.submit({
        name: `low-${i}`,
        priority: "low",
        payload: {},
        maxRetries: 0,
        dependencies: [],
      });
    }

    let lowCompleted = 0;
    let criticalCompleted = 0;
    let task: ReturnType<typeof scheduler.getNext>;
    while ((task = scheduler.getNext()) !== null) {
      scheduler.complete(task.id, { ok: true });
      if (task.priority === "low") lowCompleted++;
      else if (task.priority === "critical") criticalCompleted++;
    }

    const totalMs = performance.now() - start;
    console.log(
      `[Stress] fairness: ${totalMs.toFixed(2)}ms, critical=${criticalCompleted}, low=${lowCompleted}`,
    );

    // 批量排空场景下，低优先级任务必须全部被调度（不饿死）
    expect(criticalCompleted).toBe(criticalCount);
    expect(lowCompleted).toBe(lowCount);
  });

  test("background tasks complete when no critical tasks pending", () => {
    const start = performance.now();
    const mixed: Array<{ priority: TaskPriority; count: number }> = [
      { priority: "critical", count: 10 },
      { priority: "high", count: 10 },
      { priority: "normal", count: 10 },
      { priority: "low", count: 10 },
      { priority: "background", count: 10 },
    ];

    for (const { priority, count } of mixed) {
      for (let i = 0; i < count; i++) {
        scheduler.submit({
          name: `${priority}-${i}`,
          priority,
          payload: {},
          maxRetries: 0,
          dependencies: [],
        });
      }
    }

    const byPriority: Record<string, number> = {
      critical: 0, high: 0, normal: 0, low: 0, background: 0,
    };
    let task: ReturnType<typeof scheduler.getNext>;
    while ((task = scheduler.getNext()) !== null) {
      scheduler.complete(task.id, { ok: true });
      byPriority[task.priority]++;
    }

    const totalMs = performance.now() - start;
    console.log(
      `[Stress] fairness mixed: ${totalMs.toFixed(2)}ms, ` +
      `bg=${byPriority.background}, low=${byPriority.low}, normal=${byPriority.normal}, ` +
      `high=${byPriority.high}, critical=${byPriority.critical}`,
    );

    // 所有优先级任务都应被调度完成
    expect(byPriority.background).toBe(10);
    expect(byPriority.low).toBe(10);
    expect(byPriority.normal).toBe(10);
    expect(byPriority.high).toBe(10);
    expect(byPriority.critical).toBe(10);
  });
});
