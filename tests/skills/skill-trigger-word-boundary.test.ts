import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { SkillRegistry } from "../../src/skills/skill-registry.js";
import type { SkillDefinition } from "../../src/skills/types.js";

/**
 * 短 ASCII trigger 词边界匹配 — 防子串误命中。
 *
 * 修复前：`match()` 用 `normalized.includes(triggerLower)`，一个 ≤4 字符的 ASCII trigger
 * （如 "doc"）会把 `"docile"` / `"visual"` 这类无关词当命中。修复后对短 ASCII trigger
 * 强制独立成词（词边界）；CJK（无空格分词）与长 trigger 保持 includes。
 *
 * 测试策略：builtin doc-generate 自带短 trigger "doc"（≤4 字符 → 词边界）、
 * test-generate 自带 "test"、"spec"、"jest"（→ 词边界），直接以 builtin 行为验证
 * 词边界生效；另注册独特 CJK 长 trigger 验证 includes 语义不受影响。
 */

function makeSkill(id: string, trigger: string): SkillDefinition {
  return {
    id,
    name: `技能-${id}`,
    description: "测试用技能",
    triggers: [trigger],
    promptTemplate: "prompt {{input}}",
    requiredTools: [],
    outputFormat: "text",
    version: "1.0",
    source: "hermes",
  };
}

describe("skill 短 ASCII trigger 词边界匹配", () => {
  let reg: SkillRegistry;

  beforeEach(() => {
    reg = new SkillRegistry({ skillDirs: [], matchThreshold: 0.3 });
  });

  afterEach(() => {
    reg = null as unknown as SkillRegistry;
  });

  test("短 ASCII trigger 不被长词子串误命中（doc 不命中 docile）", () => {
    // builtin doc-generate 的 trigger "doc"（≤4）→ 词边界；"docile" 中的 doc 非独立词
    expect(reg.match("the docile approach is better")).toBeNull();
    expect(reg.match("a doctrinaire view")).toBeNull();
  });

  test("短 ASCII trigger 独立出现时正常命中", () => {
    // "doc" 独立成词 → doc-generate 命中（输入不含 review 等其他 trigger 干扰）
    const m = reg.match("the doc is on the table");
    expect(m?.skill.id).toBe("doc-generate");
  });

  test("test 不命中 contest/visual 等含 test 子串的词", () => {
    // builtin test-generate trigger "test"（≤4）→ 词边界
    const m1 = reg.match("analyze this contest");
    if (m1) expect(m1.skill.id).not.toBe("test-generate");   // contest 含 test 子串但不独立 → 不命中
    const m2 = reg.match("prestige rankings");
    if (m2) expect(m2.skill.id).not.toBe("test-generate");
  });

  test("test 独立出现时命中 test-generate", () => {
    const m = reg.match("run the unit test");
    expect(m?.skill.id).toBe("test-generate");
  });

  test("长 ASCII trigger（review）仍按包含匹配，子串命中不受限", () => {
    // builtin code-review 的 trigger "review" 为长词（6 字符）→ includes 语义保留
    const m = reg.match("a few review comments");
    expect(m?.skill.id).toBe("code-review");
  });

  test("CJK trigger 不受词边界影响（无空格分词，includes 语义保留）", () => {
    // refactor 的 trigger "优化"（CJK）→ includes；嵌入词"性能优化方案"也能命中
    const m = reg.match("给出性能优化方案");
    // CJK 长短语命中：判断 refactor 被匹配（可能被其他技能压过，但至少被识别为候选）
    const all = reg.matchAll("给出性能优化方案");
    const ids = all.map((x) => x.skill.id);
    expect(ids).toContain("refactor");
    expect(m).not.toBeNull();
  });
});