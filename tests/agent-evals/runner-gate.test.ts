import { describe, expect, it } from "bun:test";
import { buildSystemPrompt } from "../../src/agent-evals/runner.js";
import { getTasksByFamily } from "../../src/agent-evals/tasks.js";

const codingTask = getTasksByFamily().find((t) => t.id === "CODING-01")!;
const knowledgeTask = getTasksByFamily().find((t) => t.id === "KNOW-01")!;
// 门控 override：允许所有 auto-fix（测试过滤结构而非真实增益数据）
const gain = { shouldInject: () => true };
const quality = { getSkillQuality: () => undefined };

describe("runner buildSystemPrompt gating (P2 coverage)", () => {
  it("returns empty injected list when injectSkills disabled", () => {
    const r = buildSystemPrompt(codingTask, false, { gain, quality });
    expect(r.injectedSkillIds).toEqual([]);
    expect(r.prompt).toBeUndefined();
  });

  it("injects only auto-* skills for coding family (family matching)", () => {
    const r = buildSystemPrompt(codingTask, true, { gain, quality });
    for (const id of r.injectedSkillIds) {
      expect(id.startsWith("auto-")).toBe(true);
      // auto-fix 只注入同族
      if (id.startsWith("auto-fix-")) expect(id.startsWith("auto-fix-coding-")).toBe(true);
    }
    // 不注入其他族的 auto-fix
    expect(r.injectedSkillIds.some((id) => id.startsWith("auto-fix-knowledge-"))).toBe(false);
    expect(r.injectedSkillIds.some((id) => id.startsWith("auto-fix-planning-"))).toBe(false);
  });

  it("does not inject auto-fix methodology into knowledge family (dev-only families)", () => {
    const r = buildSystemPrompt(knowledgeTask, true, { gain, quality });
    expect(r.injectedSkillIds.some((id) => id.startsWith("auto-fix-"))).toBe(false);
  });
});
