/**
 * RuleEngine 增强测试
 *
 * 验证 5 项改进:
 * 1. AND/OR 复合条件支持 (之前只支持单条件)
 * 2. successCount 仅在 dispatched=true 时递增 (之前无条件递增)
 * 3. update() 方法 + 版本递增 (之前无更新机制)
 * 4. learnFromMemory() 优雅降级 (memory-engine 不存在时返回 0)
 * 5. `in` 运算符块级作用域修复
 *
 * 注意: ruleEngine 是单例, 测试后需清理添加的规则。
 */

import { describe, test, expect, afterEach } from "bun:test";
import { ruleEngine, type Rule } from "../../src/dre/runtime/rule-engine.js";

const ADDED_RULE_IDS: string[] = [];

afterEach(() => {
  for (const id of ADDED_RULE_IDS.splice(0)) {
    ruleEngine.remove(id);
  }
});

function track(rule: Rule): Rule {
  ADDED_RULE_IDS.push(rule.id);
  return rule;
}

// ========== AND/OR 复合条件 ==========

describe("RuleEngine: compound conditions (AND/OR)", () => {
  test("AND condition: both parts must match", () => {
    const rule = track(ruleEngine.addRule({
      type: "inference",
      name: "and-test",
      description: "AND compound test",
      condition: "intent == code AND complexity == simple",
      action: "use_local_model",
      priority: 10,
      confidence: 0.9,
      source: "test",
    }));

    const matches1 = ruleEngine.evaluate({ intent: "code", complexity: "simple" });
    expect(matches1.some((m) => m.rule.id === rule.id)).toBe(true);

    const matches2 = ruleEngine.evaluate({ intent: "code", complexity: "complex" });
    expect(matches2.some((m) => m.rule.id === rule.id)).toBe(false);

    const matches3 = ruleEngine.evaluate({ intent: "research", complexity: "simple" });
    expect(matches3.some((m) => m.rule.id === rule.id)).toBe(false);
  });

  test("OR condition: either part can match", () => {
    const rule = track(ruleEngine.addRule({
      type: "inference",
      name: "or-test",
      description: "OR compound test",
      condition: "intent == debug OR intent == test",
      action: "route_to_coding_role",
      priority: 10,
      confidence: 0.9,
      source: "test",
    }));

    const matches1 = ruleEngine.evaluate({ intent: "debug" });
    expect(matches1.some((m) => m.rule.id === rule.id)).toBe(true);

    const matches2 = ruleEngine.evaluate({ intent: "test" });
    expect(matches2.some((m) => m.rule.id === rule.id)).toBe(true);

    const matches3 = ruleEngine.evaluate({ intent: "research" });
    expect(matches3.some((m) => m.rule.id === rule.id)).toBe(false);
  });

  test("triple AND condition: all three must match", () => {
    const rule = track(ruleEngine.addRule({
      type: "constraint",
      name: "triple-and-test",
      description: "Triple AND test",
      condition: "mode == plan AND user == admin AND env == production",
      action: "block_write_operations",
      priority: 100,
      confidence: 1.0,
      source: "test",
    }));

    const matches1 = ruleEngine.evaluate({ mode: "plan", user: "admin", env: "production" });
    expect(matches1.some((m) => m.rule.id === rule.id)).toBe(true);

    const matches2 = ruleEngine.evaluate({ mode: "plan", user: "admin", env: "staging" });
    expect(matches2.some((m) => m.rule.id === rule.id)).toBe(false);
  });

  test("mixed AND/OR: A AND B OR C", () => {
    const rule = track(ruleEngine.addRule({
      type: "routing",
      name: "mixed-test",
      description: "Mixed AND/OR test",
      // Left-to-right evaluation: (intent == code AND complexity == simple) OR intent == debug
      condition: "intent == code AND complexity == simple OR intent == debug",
      action: "route_to_coding_role",
      priority: 10,
      confidence: 0.9,
      source: "test",
    }));

    // First AND matches → OR matches
    const m1 = ruleEngine.evaluate({ intent: "code", complexity: "simple" });
    expect(m1.some((m) => m.rule.id === rule.id)).toBe(true);

    // First AND fails, OR part matches
    const m2 = ruleEngine.evaluate({ intent: "debug" });
    expect(m2.some((m) => m.rule.id === rule.id)).toBe(true);

    // Neither matches
    const m3 = ruleEngine.evaluate({ intent: "code", complexity: "complex" });
    expect(m3.some((m) => m.rule.id === rule.id)).toBe(false);
  });

  test("single condition still works (backward compat)", () => {
    const rule = track(ruleEngine.addRule({
      type: "inference",
      name: "single-test",
      description: "Single condition test",
      condition: "intent == code",
      action: "route_to_coding_role",
      priority: 10,
      confidence: 0.9,
      source: "test",
    }));

    const matches1 = ruleEngine.evaluate({ intent: "code" });
    expect(matches1.some((m) => m.rule.id === rule.id)).toBe(true);

    const matches2 = ruleEngine.evaluate({ intent: "research" });
    expect(matches2.some((m) => m.rule.id === rule.id)).toBe(false);
  });

  test("lowercase and/or should also work", () => {
    const rule = track(ruleEngine.addRule({
      type: "inference",
      name: "lowercase-test",
      description: "Lowercase and/or test",
      condition: "intent == code and complexity == simple",
      action: "use_local_model",
      priority: 10,
      confidence: 0.9,
      source: "test",
    }));

    const matches = ruleEngine.evaluate({ intent: "code", complexity: "simple" });
    expect(matches.some((m) => m.rule.id === rule.id)).toBe(true);
  });
});

// ========== successCount 仅在 dispatched=true 时递增 ==========

describe("RuleEngine: successCount only on dispatched", () => {
  test("handled action should increment successCount", () => {
    const rule = track(ruleEngine.addRule({
      type: "action",
      name: "handled-action-test",
      description: "Handled action",
      condition: "success == true",
      action: "save_to_memory",
      priority: 5,
      confidence: 0.7,
      source: "test",
    }));

    expect(rule.successCount).toBe(0);
    expect(rule.fireCount).toBe(0);

    ruleEngine.execute({ success: "true" });

    const updated = ruleEngine.list().find((r) => r.id === rule.id)!;
    expect(updated.fireCount).toBe(1);
    expect(updated.successCount).toBe(1);
  });

  test("unhandled action should NOT increment successCount", () => {
    const rule = track(ruleEngine.addRule({
      type: "action",
      name: "unhandled-action-test",
      description: "Unhandled action",
      condition: "success == true",
      action: "nonexistent_action_xyz",
      priority: 5,
      confidence: 0.7,
      source: "test",
    }));

    expect(rule.successCount).toBe(0);

    ruleEngine.execute({ success: "true" });

    const updated = ruleEngine.list().find((r) => r.id === rule.id)!;
    expect(updated.fireCount).toBe(1);
    expect(updated.successCount).toBe(0); // ← dispatched=false, no successCount
  });
});

// ========== update() 方法 ==========

describe("RuleEngine: update() with version bump", () => {
  test("update should bump version and modify fields", () => {
    const rule = track(ruleEngine.addRule({
      type: "inference",
      name: "update-test",
      description: "Original description",
      condition: "intent == code",
      action: "route_to_coding_role",
      priority: 10,
      confidence: 0.9,
      source: "test",
    }));

    expect(rule.version).toBe(1);

    const updated = ruleEngine.update(rule.id, {
      priority: 50,
      confidence: 0.95,
      description: "Updated description",
    });

    expect(updated).not.toBeNull();
    expect(updated!.version).toBe(2);
    expect(updated!.priority).toBe(50);
    expect(updated!.confidence).toBe(0.95);
    expect(updated!.description).toBe("Updated description");
    // Preserved fields
    expect(updated!.id).toBe(rule.id);
    expect(updated!.createdAt).toBe(rule.createdAt);
    expect(updated!.fireCount).toBe(rule.fireCount);
  });

  test("update non-existent rule should return null", () => {
    const result = ruleEngine.update("nonexistent-rule-id", { priority: 100 });
    expect(result).toBeNull();
  });

  test("multiple updates should keep bumping version", () => {
    const rule = track(ruleEngine.addRule({
      type: "inference",
      name: "multi-update-test",
      description: "Multi update test",
      condition: "intent == code",
      action: "route_to_coding_role",
      priority: 10,
      confidence: 0.9,
      source: "test",
    }));

    const u1 = ruleEngine.update(rule.id, { priority: 20 });
    const u2 = ruleEngine.update(rule.id, { priority: 30 });
    const u3 = ruleEngine.update(rule.id, { priority: 40 });

    expect(u1!.version).toBe(2);
    expect(u2!.version).toBe(3);
    expect(u3!.version).toBe(4);
    expect(u3!.priority).toBe(40);
  });
});

// ========== learnFromMemory() 优雅降级 ==========

describe("RuleEngine: learnFromMemory graceful degradation", () => {
  test("should return 0 when memory-engine module is unavailable", async () => {
    const result = await ruleEngine.learnFromMemory();
    // memory-engine.js 不存在, 应返回 0 而非抛异常
    expect(result).toBe(0);
  });

  test("should not crash the engine when called", async () => {
    // 连续调用多次, 确保不会崩溃
    for (let i = 0; i < 5; i++) {
      const result = await ruleEngine.learnFromMemory();
      expect(result).toBe(0);
    }
    // 引擎仍可用
    expect(ruleEngine.getStats()).toBeDefined();
  });
});

// ========== `in` 运算符块级作用域 ==========

describe("RuleEngine: `in` operator", () => {
  test("in operator should match comma-separated values", () => {
    const rule = track(ruleEngine.addRule({
      type: "routing",
      name: "in-operator-test",
      description: "In operator test",
      condition: "intent in code,debug,test",
      action: "route_to_coding_role",
      priority: 10,
      confidence: 0.9,
      source: "test",
    }));

    expect(ruleEngine.evaluate({ intent: "code" }).some((m) => m.rule.id === rule.id)).toBe(true);
    expect(ruleEngine.evaluate({ intent: "debug" }).some((m) => m.rule.id === rule.id)).toBe(true);
    expect(ruleEngine.evaluate({ intent: "test" }).some((m) => m.rule.id === rule.id)).toBe(true);
    expect(ruleEngine.evaluate({ intent: "research" }).some((m) => m.rule.id === rule.id)).toBe(false);
  });

  test("in operator combined with AND", () => {
    const rule = track(ruleEngine.addRule({
      type: "routing",
      name: "in-and-test",
      description: "In + AND test",
      condition: "intent in code,debug AND mode == plan",
      action: "block_write_operations",
      priority: 100,
      confidence: 1.0,
      source: "test",
    }));

    expect(ruleEngine.evaluate({ intent: "code", mode: "plan" }).some((m) => m.rule.id === rule.id)).toBe(true);
    expect(ruleEngine.evaluate({ intent: "debug", mode: "plan" }).some((m) => m.rule.id === rule.id)).toBe(true);
    expect(ruleEngine.evaluate({ intent: "code", mode: "execute" }).some((m) => m.rule.id === rule.id)).toBe(false);
    expect(ruleEngine.evaluate({ intent: "research", mode: "plan" }).some((m) => m.rule.id === rule.id)).toBe(false);
  });
});
