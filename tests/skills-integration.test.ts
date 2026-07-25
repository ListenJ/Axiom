/**
 * Skill 系统集成测试 —— agency-zh 导入产物加载 + Hermes 裸 skill 兼容
 *
 * 验证：
 *   1. skills/agency-zh/*.yaml 被 loadSkillsFromDirectories 正确加载（201 角色）
 *   2. Hermes SkillPromoter 持久化的裸 SkillDefinition JSON 可加载（格式兼容修复）
 *   3. PromptEngineer.matchSkill 能命中 agency 角色
 */
import { describe, test, expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSkillsFromDirectories, clearSkillCache } from "../src/skills/skill-loader.js";

describe("agency-zh skill 库加载", () => {
  test("skills/ 目录加载出全部 agency 角色", () => {
    clearSkillCache();
    const loaded = loadSkillsFromDirectories({ skillDirs: ["./skills"] });
    expect(loaded.errors).toEqual([]);
    expect(loaded.skills.size).toBeGreaterThanOrEqual(200);
    // 抽查关键角色存在
    const ids = [...loaded.skills.keys()];
    expect(ids.some((id) => id.includes("backend-architect"))).toBe(true);
    // 每个 skill 必备字段完整
    const sample = loaded.skills.get("agency-engineering-backend-architect");
    expect(sample).toBeDefined();
    expect(sample!.triggers.length).toBeGreaterThan(0);
    expect(sample!.promptTemplate.length).toBeGreaterThan(100);
  });

  test("matchSkill 命中后端架构师", async () => {
    const { promptEngineer } = await import("../src/agents/prompt-engineer.js");
    const hit = promptEngineer.matchSkill("帮我设计一个高并发的后端 API 架构");
    expect(hit).not.toBeNull();
    expect(hit!.id).toContain("agency-");
  });
});

describe("Hermes 裸 SkillDefinition 兼容", () => {
  test("裸 skill JSON（无 skills 数组包装）可加载", () => {
    const dir = mkdtempSync(join(tmpdir(), "hermes-skills-"));
    try {
      // 模拟 SkillPromoter 持久化格式：单个 SkillDefinition 直接序列化
      writeFileSync(
        join(dir, "auto-test-abc123.json"),
        JSON.stringify({
          id: "auto-test-abc123",
          name: "Hermes 自进化 skill",
          description: "test",
          triggers: ["测试触发词xyz"],
          promptTemplate: "请处理: {{input}}",
          requiredTools: [],
          outputFormat: "text",
          version: "1.0-auto",
          source: "hermes",
        }),
      );
      clearSkillCache();
      const loaded = loadSkillsFromDirectories({ skillDirs: [dir] });
      expect(loaded.errors).toEqual([]);
      expect(loaded.skills.has("auto-test-abc123")).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      clearSkillCache();
    }
  });
});
