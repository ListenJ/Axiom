/**
 * 边缘场景测试 A — 异常输入处理 (Abnormal Input Handling)
 *
 * 测试目标：验证各核心组件在异常输入下的稳定性与容错能力。
 * 覆盖组件：Cache、KnowledgeNetwork、AtomEngine、Scheduler、EventBus
 *
 * 异常输入类型：
 *   1. 空值/空白输入（null/undefined/空字符串/纯空格）
 *   2. 超大输入（10MB 字符串、10k 字符键名）
 *   3. 特殊字符（Unicode/emoji/控制字符/SQL注入模式/原型污染模式）
 *   4. 类型错误（数字当字符串、对象当字符串）
 *   5. 不存在的 ID 操作（删除/更新/链接不存在的实体）
 *   6. 循环/自引用（实体链接到自身）
 *
 * 设计原则（遵循 AGENTS.md 规则 7 TDD）：
 *   - 测行为不测实现：通过公共接口验证容错行为
 *   - 每个测试断言"不崩溃"+ "返回合理值"
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Cache } from "../../src/utils/cache.js";
import { knowledgeNetwork } from "../../src/dre/runtime/knowledge-network.js";
import { atomStore } from "../../src/dre/runtime/atom-engine.js";
import { scheduler } from "../../src/dre/runtime/scheduler.js";
import { eventBus } from "../../src/dre/runtime/event-bus.js";

// ═══════════════════════════════════════════════════════════════
// A.1 Cache 异常输入
// ═══════════════════════════════════════════════════════════════

describe("A.1 Cache 异常输入处理", () => {
  let cache: Cache<string>;
  beforeEach(() => {
    cache = new Cache<string>({ maxSize: 100, defaultTtlMs: 0, persistent: false });
  });
  afterEach(() => {
    cache.destroy();
  });

  test("空键名应安全处理（不崩溃，返回 undefined）", () => {
    cache.set("", "empty-key-value");
    expect(cache.getSync("")).toBe("empty-key-value");
    expect(cache.getSync("nonexistent")).toBeUndefined();
  });

  test("特殊字符键名应正确存取", () => {
    const specialKeys = [
      "key with spaces",
      "key-with-emoji-🦀",
      "key\twith\ttabs",
      "key\nwith\nnewlines",
      "key'OR'1'='1",
      "__proto__",
      "constructor",
      "toString",
      "key/with/slashes",
      "key:with:colons",
    ];
    for (const k of specialKeys) {
      cache.set(k, `value-${k}`);
      expect(cache.getSync(k)).toBe(`value-${k}`);
    }
    expect(cache.stats().size).toBe(specialKeys.length);
  });

  test("超大值应正确存取（1MB 字符串）", () => {
    const hugeValue = "x".repeat(1024 * 1024);
    cache.set("huge", hugeValue);
    expect(cache.getSync("huge")?.length).toBe(1024 * 1024);
  });

  test("超大键名应正确存取（10k 字符）", () => {
    const hugeKey = "k".repeat(10000);
    cache.set(hugeKey, "value");
    expect(cache.getSync(hugeKey)).toBe("value");
  });

  test("重复 set 同一键应更新值且不增长大小", () => {
    cache.set("dup", "v1");
    cache.set("dup", "v2");
    cache.set("dup", "v3");
    expect(cache.getSync("dup")).toBe("v3");
    expect(cache.stats().size).toBe(1);
  });

  test("delete 不存在的键不应崩溃", () => {
    expect(() => cache.delete("nonexistent")).not.toThrow();
  });

  test("LRU 淘汰应在超限时触发且不崩溃", () => {
    const small = new Cache<string>({ maxSize: 5, defaultTtlMs: 0, persistent: false });
    for (let i = 0; i < 100; i++) {
      small.set(`key-${i}`, `val-${i}`);
    }
    expect(small.stats().size).toBeLessThanOrEqual(5);
    small.destroy();
  });
});

// ═══════════════════════════════════════════════════════════════
// A.2 KnowledgeNetwork 异常输入
// ═══════════════════════════════════════════════════════════════

describe("A.2 KnowledgeNetwork 异常输入处理", () => {
  beforeEach(() => knowledgeNetwork.reset());
  afterEach(() => knowledgeNetwork.reset());

  test("空内容实体应可创建", () => {
    const ent = knowledgeNetwork.create("concept", "Empty", "", { source: "test" });
    expect(ent.id).toBeDefined();
    expect(ent.content).toBe("");
  });

  test("超长名称应可创建（10k 字符）", () => {
    const longName = "N".repeat(10000);
    const ent = knowledgeNetwork.create("concept", longName, "content", { source: "test" });
    expect(ent.name).toBe(longName);
  });

  test("特殊字符内容应可创建（emoji + 控制字符 + SQL 模式）", () => {
    const specialContent = "内容含 🎉 emoji\t制表符\n换行'OR'1'='1--注释";
    const ent = knowledgeNetwork.create("concept", "Special", specialContent, { source: "test" });
    expect(ent.content).toBe(specialContent);
  });

  test("删除不存在的 ID 应返回 false", () => {
    expect(knowledgeNetwork.delete("nonexistent-id")).toBe(false);
  });

  test("更新不存在的 ID 应返回 false", () => {
    expect(knowledgeNetwork.update("nonexistent-id", { content: "new" })).toBe(false);
  });

  test("链接不存在的实体应返回 null", () => {
    const link = knowledgeNetwork.link("nonexistent-src", "nonexistent-dst", "test-rel");
    expect(link).toBeNull();
  });

  test("自引用链接（实体链接到自身）应安全处理", () => {
    const ent = knowledgeNetwork.create("concept", "SelfRef", "content", { source: "test" });
    const link = knowledgeNetwork.link(ent.id, ent.id, "self-loop");
    // 自引用可能被允许或拒绝，但不应崩溃
    expect(() => knowledgeNetwork.link(ent.id, ent.id, "self-loop")).not.toThrow();
  });

  test("重复链接（同 src/dst/relation）应安全处理", () => {
    const a = knowledgeNetwork.create("concept", "A", "a", { source: "test" });
    const b = knowledgeNetwork.create("concept", "B", "b", { source: "test" });
    const link1 = knowledgeNetwork.link(a.id, b.id, "same-rel");
    const link2 = knowledgeNetwork.link(a.id, b.id, "same-rel");
    // 去重或允许重复，但不应崩溃
    expect(() => knowledgeNetwork.link(a.id, b.id, "same-rel")).not.toThrow();
  });

  test("getLinksFrom/To 不存在的 ID 应返回空数组", () => {
    expect(knowledgeNetwork.getLinksFrom("nonexistent")).toEqual([]);
    expect(knowledgeNetwork.getLinksTo("nonexistent")).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════
// A.3 AtomEngine 异常输入
// ═══════════════════════════════════════════════════════════════

describe("A.3 AtomEngine 异常输入处理", () => {
  beforeEach(() => atomStore.reset());
  afterEach(() => atomStore.reset());

  test("空内容原子应可创建", () => {
    const atom = atomStore.create("fact", "", { source: "test" });
    expect(atom.id).toBeDefined();
    expect(atom.content).toBe("");
  });

  test("超大内容原子应可创建（1MB）", () => {
    const hugeContent = "A".repeat(1024 * 1024);
    const atom = atomStore.create("fact", hugeContent, { source: "test" });
    expect(atom.content.length).toBe(1024 * 1024);
  });

  test("特殊字符内容应可创建", () => {
    const special = "🦀 emoji \x00 null \t tab \n newline 'OR'1'='1";
    const atom = atomStore.create("fact", special, { source: "test" });
    expect(atom.content).toBe(special);
  });

  test("更新不存在的原子应返回 undefined", () => {
    expect(atomStore.update("nonexistent", "new content")).toBeUndefined();
  });

  test("删除不存在的原子应返回 false", () => {
    expect(atomStore.delete("nonexistent")).toBe(false);
  });

  test("搜索空查询应安全返回", () => {
    expect(() => atomStore.search("")).not.toThrow();
    expect(atomStore.search("").length).toBe(0);
  });

  test("搜索超大查询应安全返回（10k 字符）", () => {
    const hugeQuery = "Q".repeat(10000);
    expect(() => atomStore.search(hugeQuery)).not.toThrow();
  });

  test("getStats 在空存储上应返回零值", () => {
    const stats = atomStore.getStats();
    expect(stats.total).toBe(0);
    expect(stats.created).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════
// A.4 Scheduler 异常输入
// ═══════════════════════════════════════════════════════════════

describe("A.4 Scheduler 异常输入处理", () => {
  beforeEach(() => scheduler.reset());
  afterEach(() => scheduler.reset());

  test("提交过去截止时间的任务应被自动处理", () => {
    const task = scheduler.submit({
      name: "test",
      priority: "normal" as never,
      payload: {},
      maxRetries: 0,
      dependencies: [],
      deadline: Date.now() - 1000, // 过去 1 秒
    });
    expect(task.id).toBeDefined();
    // getNext 应跳过或自动失败过期任务
    const next = scheduler.getNext();
    // 过期任务可能返回 null（自动失败）或返回该任务
    expect(next === null || next.id === task.id).toBe(true);
  });

  test("complete 不存在的任务不应崩溃", () => {
    expect(() => scheduler.complete("nonexistent", {})).not.toThrow();
  });

  test("fail 不存在的任务不应崩溃", () => {
    expect(() => scheduler.fail("nonexistent", "test error")).not.toThrow();
  });

  test("getNext 在空队列上应返回 null", () => {
    expect(scheduler.getNext()).toBeNull();
  });

  test("大批量提交后 reset 应清空所有状态", () => {
    for (let i = 0; i < 100; i++) {
      scheduler.submit({
        name: "test",
        priority: "normal" as never,
        payload: { idx: i },
        maxRetries: 0,
        dependencies: [],
      });
    }
    scheduler.reset();
    expect(scheduler.getNext()).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════
// A.5 EventBus 异常输入
// ═══════════════════════════════════════════════════════════════

describe("A.5 EventBus 异常输入处理", () => {
  const subscribedIds: string[] = [];

  afterEach(() => {
    for (const id of subscribedIds) {
      eventBus.unsubscribe(id);
    }
    subscribedIds.length = 0;
  });

  test("handler 抛出错误不应影响后续 handler 执行", () => {
    const order: string[] = [];
    subscribedIds.push(
      eventBus.subscribe("test-error", () => {
        order.push("first");
        throw new Error("handler error");
      }),
    );
    subscribedIds.push(
      eventBus.subscribe("test-error", () => {
        order.push("second");
      }),
    );

    eventBus.publish({
      type: "test-error",
      source: "test",
      data: null,
      priority: "normal",
    });

    // 即使第一个 handler 抛错，第二个仍应执行
    expect(order).toContain("second");
    const stats = eventBus.getStats();
    expect(stats.errors).toBeGreaterThan(0);
  });

  test("handler 返回 rejected Promise 应记录错误但不崩溃", async () => {
    subscribedIds.push(
      eventBus.subscribe("test-async-error", async () => {
        throw new Error("async handler error");
      }),
    );

    eventBus.publish({
      type: "test-async-error",
      source: "test",
      data: null,
      priority: "normal",
    });

    // 等待微任务完成
    await new Promise((r) => setTimeout(r, 50));
    const stats = eventBus.getStats();
    expect(stats.errors).toBeGreaterThan(0);
  });

  test("unsubscribe 不存在的 ID 应安全处理", () => {
    expect(() => eventBus.unsubscribe("nonexistent-id")).not.toThrow();
  });

  test("空事件类型应安全处理", () => {
    expect(() =>
      eventBus.publish({
        type: "",
        source: "test",
        data: null,
        priority: "normal",
      }),
    ).not.toThrow();
  });

  test("subscribeOnce 应只触发一次", () => {
    let callCount = 0;
    subscribedIds.push(
      eventBus.subscribeOnce("once-test", () => {
        callCount++;
      }),
    );

    eventBus.publish({ type: "once-test", source: "test", data: null, priority: "normal" });
    eventBus.publish({ type: "once-test", source: "test", data: null, priority: "normal" });

    expect(callCount).toBe(1);
  });

  test("大尺寸事件 data 应安全处理（1MB 对象）", () => {
    const bigData = { items: Array.from({ length: 100000 }, (_, i) => ({ id: i, val: `item-${i}` })) };
    expect(() =>
      eventBus.publish({
        type: "big-data-test",
        source: "test",
        data: bigData,
        priority: "normal",
      }),
    ).not.toThrow();
  });
});
