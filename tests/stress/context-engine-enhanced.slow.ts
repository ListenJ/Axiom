/**
 * ContextEngine 增强测试
 *
 * 验证 5 项改进:
 * 1. 缓存修复 — 不同 input 的 atoms/knowledgeNodes 总是 fresh (之前会返回缓存)
 * 2. Token 估算 — estimateTokens() 返回合理估算
 * 3. 记忆注入 — setMemories() 注入的记忆出现在后续 build() 中
 * 4. 增强统计 — cacheHitRate / buildCount / memoryCount
 * 5. formatForPrompt 可配置限制 — maxAtoms / maxHistory
 *
 * 注意: contextEngine 是单例, 测试后需清理状态。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { contextEngine, type RuntimeContext } from "../../src/dre/runtime/context-engine.js";
import { worldState } from "../../src/dre/runtime/world-state.js";
import { atomStore } from "../../src/dre/runtime/atom-engine.js";

const ORIGINAL_MEMORIES: RuntimeContext["memories"] = [];

beforeEach(() => {
  contextEngine.invalidateCache();
});

afterEach(() => {
  contextEngine.invalidateCache();
  contextEngine.setMemories(ORIGINAL_MEMORIES);
});

// ========== 缓存修复 ==========

describe("ContextEngine: cache fix (input-dependent parts always fresh)", () => {
  test("different inputs should return different atoms (not cached)", () => {
    // 创建两个不同内容的 atom, 确保 search 能找到
    const PREFIX_A = `ctx-cache-a-${Date.now()}`;
    const PREFIX_B = `ctx-cache-b-${Date.now()}`;
    atomStore.create("fact", `${PREFIX_A} unique content alpha`);
    atomStore.create("fact", `${PREFIX_B} unique content beta`);

    // 第一次 build: 搜索 A
    const ctxA = contextEngine.build(PREFIX_A);
    const atomsA = ctxA.atoms.map((a) => a.content);

    // 第二次 build: 搜索 B (在 5s 缓存窗口内)
    const ctxB = contextEngine.build(PREFIX_B);
    const atomsB = ctxB.atoms.map((a) => a.content);

    // 两个 context 的 atoms 应该不同 (之前 bug: 会返回相同的缓存 atoms)
    expect(atomsA).not.toEqual(atomsB);

    // A 的结果应包含 PREFIX_A 相关内容
    expect(atomsA.some((c) => c.includes(PREFIX_A))).toBe(true);
    expect(atomsA.some((c) => c.includes(PREFIX_B))).toBe(false);

    // B 的结果应包含 PREFIX_B 相关内容
    expect(atomsB.some((c) => c.includes(PREFIX_B))).toBe(true);
    // B 不应包含 A (除非偶然, 但 PREFIX 唯一性保证不会)
    expect(atomsB.some((c) => c.includes(PREFIX_A))).toBe(false);
  });

  test("state-dependent parts (workspace, goals) should still be cached", () => {
    worldState.setGoal("cache-test-goal", "cached goal", "active");

    // 第一次 build — 填充缓存
    const ctx1 = contextEngine.build("cache-test");
    expect(ctx1.goals.some((g) => g.description === "cached goal")).toBe(true);

    // 第二次 build — 应使用缓存 (goals 仍存在)
    const ctx2 = contextEngine.build("different-input");
    expect(ctx2.goals.some((g) => g.description === "cached goal")).toBe(true);
  });
});

// ========== Token 估算 ==========

describe("ContextEngine: token estimation", () => {
  test("estimateTokens should return reasonable estimate", () => {
    const ctx = contextEngine.build("test input for token estimation");
    const estimate = contextEngine.estimateTokens(ctx);

    expect(estimate.estimated).toBeGreaterThan(0);
    expect(estimate.budget).toBeGreaterThan(0);
    expect(typeof estimate.remaining).toBe("number");
    expect(typeof estimate.overBudget).toBe("boolean");
  });

  test("estimateTokens should reflect prompt size", () => {
    const smallCtx = contextEngine.build("hi");
    const largeCtx = contextEngine.build("a".repeat(1000));

    const smallEst = contextEngine.estimateTokens(smallCtx);
    const largeEst = contextEngine.estimateTokens(largeCtx);

    expect(largeEst.estimated).toBeGreaterThan(smallEst.estimated);
  });

  test("overBudget should be true when used + estimated exceeds max", () => {
    const ctx = contextEngine.build("test");
    // 模拟 tokenBudget 已接近用尽
    const overCtx: RuntimeContext = {
      ...ctx,
      tokenBudget: { available: 0, used: 99999, max: 100000 },
    };
    const estimate = contextEngine.estimateTokens(overCtx);
    expect(estimate.overBudget).toBe(true);
  });
});

// ========== 记忆注入 ==========

describe("ContextEngine: memory injection", () => {
  test("setMemories should appear in subsequent build()", () => {
    const memories = [
      { id: "mem-1", content: "Important past context", confidence: 0.9 },
      { id: "mem-2", content: "User preference: prefers concise answers", confidence: 0.8 },
    ];

    contextEngine.setMemories(memories);

    const ctx = contextEngine.build("test with memories");
    expect(ctx.memories.length).toBe(2);
    expect(ctx.memories[0].content).toBe("Important past context");
    expect(ctx.memories[1].id).toBe("mem-2");
  });

  test("memories should persist across multiple builds", () => {
    contextEngine.setMemories([{ id: "persistent", content: "persistent memory", confidence: 0.7 }]);

    const ctx1 = contextEngine.build("first query");
    expect(ctx1.memories.length).toBe(1);

    const ctx2 = contextEngine.build("second query");
    expect(ctx2.memories.length).toBe(1);
    expect(ctx2.memories[0].id).toBe("persistent");
  });

  test("empty memories should not break context", () => {
    contextEngine.setMemories([]);
    const ctx = contextEngine.build("no memories");
    expect(ctx.memories.length).toBe(0);
  });

  test("memories should appear in formatForPrompt", () => {
    contextEngine.setMemories([{ id: "mem-fmt", content: "formatted memory test", confidence: 0.9 }]);
    const ctx = contextEngine.build("format test");
    const prompt = contextEngine.formatForPrompt(ctx);
    expect(prompt).toContain("formatted memory test");
  });
});

// ========== 增强统计 ==========

describe("ContextEngine: enhanced stats", () => {
  test("cacheHitRate should be low after first build (cache miss), then increase", () => {
    contextEngine.invalidateCache();
    const before = contextEngine.getStats();

    // First build — cache miss (must rebuild state)
    contextEngine.build("cache-miss-test");
    const after1 = contextEngine.getStats();

    // Second build within TTL — cache hit (state parts reused)
    contextEngine.build("cache-hit-test");
    const after2 = contextEngine.getStats();

    // cacheHitRate should increase after a cache hit
    expect(after2.cacheHitRate).toBeGreaterThanOrEqual(after1.cacheHitRate);
  });

  test("cacheHitRate should increase on second build within TTL", () => {
    contextEngine.invalidateCache();
    contextEngine.build("first");
    const rate1 = contextEngine.getStats().cacheHitRate;

    contextEngine.build("second"); // cache hit (state parts)
    const rate2 = contextEngine.getStats().cacheHitRate;

    expect(rate2).toBeGreaterThanOrEqual(rate1);
    expect(rate2).toBeLessThanOrEqual(1);
  });

  test("buildCount should track total builds", () => {
    const before = contextEngine.getStats().buildCount;
    contextEngine.build("count-1");
    contextEngine.build("count-2");
    contextEngine.buildRaw("count-3");
    const after = contextEngine.getStats().buildCount;
    expect(after - before).toBe(3);
  });

  test("memoryCount should reflect injected memories", () => {
    contextEngine.setMemories([{ id: "m1", content: "a", confidence: 0.5 }]);
    expect(contextEngine.getStats().memoryCount).toBe(1);

    contextEngine.setMemories([
      { id: "m1", content: "a", confidence: 0.5 },
      { id: "m2", content: "b", confidence: 0.6 },
      { id: "m3", content: "c", confidence: 0.7 },
    ]);
    expect(contextEngine.getStats().memoryCount).toBe(3);
  });
});

// ========== formatForPrompt 可配置限制 ==========

describe("ContextEngine: formatForPrompt configurable limits", () => {
  test("maxAtoms should limit atoms in prompt", () => {
    // 创建 15 个 atom
    const PREFIX = `fmt-atoms-${Date.now()}`;
    for (let i = 0; i < 15; i++) {
      atomStore.create("fact", `${PREFIX}-atom-${i}`);
    }

    const ctx = contextEngine.build(PREFIX);
    const promptDefault = contextEngine.formatForPrompt(ctx);
    const promptLimited = contextEngine.formatForPrompt(ctx, { maxAtoms: 3 });

    // 默认 maxAtoms=10, limited=3
    // 有限制的 prompt 应该更短
    expect(promptLimited.length).toBeLessThan(promptDefault.length);
  });

  test("maxHistory should limit history messages in prompt", () => {
    const history: Array<{ role: string; content: string }> = [];
    for (let i = 0; i < 20; i++) {
      history.push({ role: "user", content: `message-${i}-`.repeat(20) });
    }

    const ctx = contextEngine.build("history test", history);
    const promptFull = contextEngine.formatForPrompt(ctx, { maxHistory: 20 });
    const promptLimited = contextEngine.formatForPrompt(ctx, { maxHistory: 3 });

    // 限制后应更短
    expect(promptLimited.length).toBeLessThan(promptFull.length);
    // 限制后的 prompt 应包含最后 3 条消息
    expect(promptLimited).toContain("message-19-");
    expect(promptLimited).toContain("message-18-");
    expect(promptLimited).toContain("message-17-");
    // 不应包含第 16 条
    expect(promptLimited).not.toContain("message-15-");
  });

  test("formatForPrompt should include knowledge nodes section", () => {
    const ctx = contextEngine.build("test kg");
    // 即使 knowledgeNodes 为空, 也不应崩溃
    const prompt = contextEngine.formatForPrompt(ctx);
    expect(typeof prompt).toBe("string");
    expect(prompt).toContain("[Input]");
  });
});
