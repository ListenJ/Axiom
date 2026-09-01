/**
 * 真实数据端到端 evolve 特异性（2026-09-01）：
 *   - 走真实数据加载路径（loadRealUsageTraces(.tmp jsonl)）+ 真实归纳引擎（selfInduce）
 *     + promoteInductionsToSkills(fakeDeps)——刻意不调 evolveFromRealUsage，
 *     因其对 promotion 无 deps 注入会写真实 axiom-memory/03-Resources/skills（既有污染源）。
 *   - contract：curated 真实形态样本 → 只创建有语义术语 skill，通用会话词不被提升。
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { loadRealUsageTraces, clearRealUsageTraces, captureRealUsageTrace } from "../../src/agent-evals/real-usage.js";
import { SelfEvolveEngine } from "../../src/self-evolve/engine.js";
import { promoteInductionsToSkills, type InductionPromotionDeps } from "../../src/self-evolve/skill-promotion.js";
import type { SkillDefinition } from "../../src/skills/types.js";

describe("真实数据端到端 evolve 特异性", () => {
  const tmpPath = path.join(process.cwd(), ".tmp", "test-real-usage-evolve-specificity.jsonl");

  beforeEach(async () => {
    await clearRealUsageTraces(tmpPath);
  });

  afterEach(async () => {
    await clearRealUsageTraces(tmpPath);
    try { fs.unlinkSync(tmpPath); } catch {}
  });

  function fakePromotionDeps(): {
    deps: InductionPromotionDeps;
    registered: SkillDefinition[];
  } {
    const registered: SkillDefinition[] = [];
    const existing = new Set<string>();
    return {
      deps: {
        register: (s) => { registered.push(s); existing.add(s.id); },
        has: (id) => existing.has(id),
        persist: () => {},
      },
      registered,
    };
  }

  test("真实形态样本：通用会话词不提升，有语义术语提升", async () => {
    // 同一批样本：6 条通用词任务（写一个/用/函数）+ 各 2 条有语义任务（mcp 超时/redis 缓存）
    const junkTasks = ["写一个 json 处理函数", "用 node 写一个 api 返回", "函数 步骤 不要 一次"];
    for (const task of junkTasks) {
      for (let i = 0; i < 2; i++) {
        await captureRealUsageTrace({ id: `j-${task.slice(0,4)}-${i}`, task, success: true } as any, tmpPath);
      }
    }
    for (let i = 0; i < 2; i++) {
      await captureRealUsageTrace({ id: `mcp-${i}`, task: "调用 mcp 超时处理", success: true } as any, tmpPath);
      await captureRealUsageTrace({ id: `redis-${i}`, task: "优化 redis 缓存命中率", success: true } as any, tmpPath);
    }

    // 真实加载路径（flush pending → 解析 jsonl）
    const traces = await loadRealUsageTraces(tmpPath);
    expect(traces.length).toBeGreaterThanOrEqual(10);

    // 真实归纳引擎（注入 fake deps，不碰 router/磁盘）
    const engine = new SelfEvolveEngine({
      think: async () => '{"goal":"g","assumptions":[],"plan":["p"],"risks":[]}',
      store: { write: async () => {}, list: async () => [] },
    });
    const inductions = engine.selfInduce(traces, 10);
    const { deps, registered } = fakePromotionDeps();
    const created = promoteInductionsToSkills(inductions, deps);

    // 有语义术语被提升（不误杀）
    expect(created).toContain("auto-induce-mcp");
    expect(created).toContain("auto-induce-redis");
    // 通用会话词不提升（特异性生效），且无任何 auto-induce-json/api/写一/函数 等
    const ids = new Set(created);
    for (const junk of ["json", "api", "写一", "一个", "函数", "用", "node"]) {
      expect(ids.has(`auto-induce-${junk}`)).toBe(false);
    }
    const registeredIds = registered.map((s) => s.id);
    expect(registeredIds.some((id) => /auto-induce-(json|api|node|写一|一个|函数|用)/.test(id))).toBe(false);
  });
});