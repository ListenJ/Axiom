/**
 * runner buildSystemPrompt 门控（P2 覆盖）
 *
 * ⚠️ 本文件曾有一处**静默退化**（2026-09-19 定位）：
 *   原实现读**真实技能目录**（`runner.ts:410` `loadSkillsFromDirectories`），
 *   而断言写在 `for (const id of r.injectedSkillIds)` **循环内** ——
 *   于是断言次数取决于**本机装了多少 auto-* 技能**。
 *   实测：Linux 上该文件 21 次 expect、Windows worktree 上仅 5 次 ——
 *   Windows 上**循环一次都没进**，"家族匹配"那条等于**没断言**。
 *   （这正是双端 expect 差 16 的**全部来源**，不是平台行为差异。）
 *
 * 修法：改为**注入固定技能集**（依赖经参数传入，rule 8），
 *   并用**精确相等**断言替代"循环里看每个 id"，使断言不再依赖环境、也不会静默退化。
 */
import { describe, expect, it } from "bun:test";
import { buildSystemPrompt } from "../../src/agent-evals/runner.js";
import { getTasksByFamily } from "../../src/agent-evals/tasks.js";
import type { LoadedSkills } from "../../src/skills/skill-loader.js";
import type { SkillDefinition } from "../../src/skills/types.js";

function mkSkill(id: string): SkillDefinition {
  return {
    id,
    name: id,
    description: `${id} 描述`,
    triggers: [],
    promptTemplate: "",
    requiredTools: [],
    outputFormat: "text",
    version: "1.0.0",
  };
}

/** 固定技能集：覆盖同族 auto-fix / 异族 auto-fix / auto-induce / 无关技能 */
const FIXED_SKILLS: LoadedSkills = {
  skills: new Map([
    ["auto-fix-coding-alpha", mkSkill("auto-fix-coding-alpha")],
    ["auto-fix-knowledge-beta", mkSkill("auto-fix-knowledge-beta")],
    ["auto-fix-planning-gamma", mkSkill("auto-fix-planning-gamma")],
    ["auto-induce-delta", mkSkill("auto-induce-delta")],
    ["plain-epsilon", mkSkill("plain-epsilon")],
  ]),
  templates: new Map(),
  errors: [],
};

const loadSkills = () => FIXED_SKILLS;
const gain = { shouldInject: () => true };
const quality = { getSkillQuality: () => undefined };

const codingTask = getTasksByFamily().find((t) => t.id === "CODING-01")!;
const knowledgeTask = getTasksByFamily().find((t) => t.id === "KNOW-01")!;

describe("runner buildSystemPrompt gating (P2 coverage)", () => {
  it("injectSkills=false → 不注入任何技能，且不产出 prompt", () => {
    const r = buildSystemPrompt(codingTask, false, { gain, quality, loadSkills });
    expect(r.injectedSkillIds).toEqual([]);
    expect(r.prompt).toBeUndefined();
  });

  it("coding 族：只注入同族 auto-fix 与 auto-induce（精确集合）", () => {
    const r = buildSystemPrompt(codingTask, true, { gain, quality, loadSkills });
    // 精确相等 ⇒ 断言不会因环境而"跑零次"
    expect(r.injectedSkillIds).toEqual(["auto-fix-coding-alpha", "auto-induce-delta"]);
    expect(r.prompt).toContain("auto-fix-coding-alpha");
  });

  it("knowledge 族：方法论 auto-fix 一律不注入，仅 auto-induce", () => {
    const r = buildSystemPrompt(knowledgeTask, true, { gain, quality, loadSkills });
    expect(r.injectedSkillIds).toEqual(["auto-induce-delta"]);
    expect(r.injectedSkillIds.some((id) => id.startsWith("auto-fix-"))).toBe(false);
  });

  it("质量门控：被标 deprecated 的技能不注入", () => {
    const deprecatedQuality = { getSkillQuality: (id: string) => (id === "auto-induce-delta" ? { deprecated: true } : undefined) };
    const r = buildSystemPrompt(codingTask, true, { gain, quality: deprecatedQuality, loadSkills });
    expect(r.injectedSkillIds).toEqual(["auto-fix-coding-alpha"]);
  });

  it("增益门控：shouldInject=false 的技能不注入", () => {
    const noGain = { shouldInject: () => false };
    const r = buildSystemPrompt(codingTask, true, { gain: noGain, quality, loadSkills });
    expect(r.injectedSkillIds).toEqual([]);
    expect(r.prompt).toBeUndefined();
  });
});
