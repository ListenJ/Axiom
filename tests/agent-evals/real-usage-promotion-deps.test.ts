/**
 * evolveFromRealUsage 支持 promotionDeps 注入（2026-09-02）：
 *   - 修复前 evolveFromRealUsage 无条件走 defaultDeps() → 每次 evolve 都往真实
 *     axiom-memory/03-Resources/skills 写 auto-induce-* JSON（测试/巡检污染源，
 *     也是 real-usage-evolve-specificity.test.ts 顶部注释标注的"既有污染源"）。
 *   - 修复后 opts.promotionDeps 一路注入到 promoteInductionsToSkills；测试传 fake deps
 *     （register 收进内存数组、persist noop），断言 created/registered 命中且零磁盘写入。
 *   - 走真实数据路径：capture(jsonl) → load(dedup) → selfInduce → promote(deps)。
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  evolveFromRealUsage,
  clearRealUsageTraces,
  captureRealUsageTrace,
} from "../../src/agent-evals/real-usage.js";
import type { InductionPromotionDeps } from "../../src/self-evolve/skill-promotion.js";
import type { SkillDefinition } from "../../src/skills/types.js";

describe("evolveFromRealUsage 支持 promotionDeps 注入", () => {
  const tmpPath = path.join(process.cwd(), ".tmp", "test-real-usage-promotion-deps.jsonl");

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

  test("重复语义任务 → created/registered 含 auto-induce-mcp，不写真实技能目录", async () => {
    // 两条不同任务共享术语（mcp/超时）→ 默认 dedupByTask 后 support 仍 >=2，可归纳
    // （同任务重复会被 dedup 折叠为 1 条，故用"不同任务共享术语"而非"同任务多份"）
    for (let i = 0; i < 2; i++) {
      await captureRealUsageTrace({ id: `mcp-a-${i}`, task: "调用 mcp 超时处理", success: true } as any, tmpPath);
      await captureRealUsageTrace({ id: `mcp-b-${i}`, task: "调用 mcp 超时重试", success: true } as any, tmpPath);
    }

    const { deps, registered } = fakePromotionDeps();
    const result = await evolveFromRealUsage(tmpPath, { promotionDeps: deps });

    // 进化确实发生，且走的是注入的 deps（不是真实 defaultDeps）
    expect(result.inductionCount).toBeGreaterThanOrEqual(1);
    expect(result.created).toContain("auto-induce-mcp");
    expect(registered.map((s) => s.id)).toContain("auto-induce-mcp");
    expect(registered.length).toBe(result.created.length);
  });
});
