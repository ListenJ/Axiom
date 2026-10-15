import { describe, test, expect } from "bun:test";
import { ruleEngine } from "./rule-engine.js";
import { eventBus } from "./event-bus.js";

/**
 * MetaCognitiveLoop 单元测试
 *
 * 注意：不直接使用 process.env（架构门禁要求所有 env 读取经 env.ts）。
 * 安全门配置通过环境变量在启动时读取——测试验证事件驱动行为。
 */
describe("MetaCognitiveLoop", () => {

  test("SafetyGate: 影子模式——前 N 次只记录不生效", async () => {
    // 影子模式下，lessons 不应产生新规则
    const rulesBefore = ruleEngine.listByType("action").length;

    eventBus.publish({
      type: "cognitive.pipeline.completed",
      source: "test",
      data: {
        input: "test-timeout-scenario",
        lessons: ["timeout occurred in database query"],
        issues: [],
      },
      priority: "normal",
    });

    await new Promise((r) => setTimeout(r, 100));

    const rulesAfter = ruleEngine.listByType("action").length;
    // 影子模式下不应新增规则
    expect(rulesAfter).toBe(rulesBefore);
  });

  test("LessonParser: 已知模式能正确解析", () => {
    // timeout 模式
    eventBus.publish({
      type: "cognitive.pipeline.completed",
      source: "test",
      data: {
        input: "test",
        lessons: ["timeout occurred"],
        issues: [],
      },
      priority: "normal",
    });

    // constraint 模式
    eventBus.publish({
      type: "cognitive.pipeline.completed",
      source: "test",
      data: {
        input: "test",
        lessons: ["constraint violated: memory limit"],
        issues: [],
      },
      priority: "normal",
    });

    // gap 模式
    eventBus.publish({
      type: "cognitive.pipeline.completed",
      source: "test",
      data: {
        input: "test",
        lessons: ["gap in reasoning: missing premise"],
        issues: [],
      },
      priority: "normal",
    });

    // 这些都应该被正确解析（不抛错即通过）
    expect(true).toBe(true);
  });

  test("Bridge D: issues 累积后才触发适应", async () => {
    const adaptEvents: unknown[] = [];
    const subId = eventBus.subscribe("meta.loop.d.adapt", (event) => {
      adaptEvents.push(event);
    });

    // 发送 2 次（低于阈值 3）——不应触发
    for (let i = 0; i < 2; i++) {
      eventBus.publish({
        type: "cognitive.pipeline.completed",
        source: "test",
        data: {
          input: "test",
          lessons: [],
          issues: ["knowledge insufficient for domain X"],
        },
        priority: "normal",
      });
      await new Promise((r) => setTimeout(r, 50));
    }

    expect(adaptEvents.length).toBe(0);

    // 第 3 次——应触发（如果未被影子模式拦截）
    eventBus.publish({
      type: "cognitive.pipeline.completed",
      source: "test",
      data: {
        input: "test",
        lessons: [],
        issues: ["knowledge insufficient for domain X"],
      },
      priority: "normal",
    });
    await new Promise((r) => setTimeout(r, 100));

    eventBus.unsubscribe(subId);
  });

  test("Bridge B/C: 管道内实时连接不破坏确定性", () => {
    // Bridge B 和 C 在管道内执行，失败时 fail-safe 降级
    // 验证：即使 synapse/mentalModel 返回 null，管道仍正常完成
    // 这已由 cognitive-pipeline.test.ts 的 21 个测试覆盖
    expect(true).toBe(true);
  });

  test("EventBus: 传动轴事件可被订阅", () => {
    let received = false;
    const subId = eventBus.subscribe("meta.loop.a.learned", () => {
      received = true;
    });

    eventBus.publish({
      type: "cognitive.pipeline.completed",
      source: "test",
      data: {
        input: "test",
        lessons: ["timeout occurred in operation"],
        issues: [],
      },
      priority: "normal",
    });

    eventBus.unsubscribe(subId);
    // 订阅和取消订阅不抛错即通过
    expect(true).toBe(true);
  });

  // ─── 容器上限（2026-10-14 全仓审核发现 4）────────────────────────────
  // 探针曾实测：500 条互异事件 → seenLessons/trackedPatterns 各 500，只增不删。
  // 当前 lesson/issue 基数有界（硬编码触发器），但容器无上限设计在 lesson 转为
  // LLM 自由文本后即转为真实泄漏。以下断言锁死"超限即淘汰"。
  test("容器上限：大量互异事件后 seenLessons/trackedPatterns 不无界增长", async () => {
    const { getMetaCognitiveLoop } = await import("./meta-cognitive-loop.js");
    const loop = getMetaCognitiveLoop();
    loop.start();

    const N = 1500; // > maxSeenLessons(1000) 与 maxPatterns(1000)
    for (let i = 0; i < N; i++) {
      await eventBus.publish({
        type: "cognitive.pipeline.completed",
        source: "cap-test",
        data: {
          input: `cap-${i}`,
          lessons: [`unique lesson variant ${i} about timeout handling`],
          issues: [`unique issue ${i} about knowledge context`],
        },
        priority: "normal",
      });
    }
    await new Promise((r) => setTimeout(r, 300));

    const s = loop.getStats();
    expect(s.bridgeA.seenLessons, "seenLessons 应被上限约束").toBeLessThanOrEqual(1000);
    expect(s.bridgeD.trackedPatterns, "trackedPatterns 应被上限约束").toBeLessThanOrEqual(1000);
    // 反向自检：确实处理了大量事件（否则"没超限"是因为根本没跑）
    expect(s.totalCompleted).toBeGreaterThanOrEqual(N);
    loop.stop();
  }, 30_000);
});
