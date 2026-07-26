/**
 * Prompt Engineer 验证测试 (零向量, 纯规则驱动)
 */

import { describe, test, expect } from "bun:test";
import fs from "fs";
import path from "path";
import { promptEngineer, PromptEngineer } from "../src/agents/prompt-engineer.js";
import { DEFAULT_PROMPT_DIR, DEFAULT_SKILL_DIRS } from "../src/skills/types.js";

describe("Prompt Engineer - 零向量提示词引擎", () => {
  test("1. 模板匹配 - 确定性规则", () => {
    console.log("\n[测试] 1: 模板匹配 (零向量)");

    // 代码审查场景
    const match1 = promptEngineer.matchTemplate("帮我审查这段代码的安全性");
    expect(match1).not.toBeNull();
    expect(match1!.template.id).toBe("code-review");
    console.log(`  [完成] 代码审查匹配: ${match1!.template.name} (score: ${match1!.score})`);
    console.log(`     原因: ${match1!.reasons.join(", ")}`);

    // 深度研究场景
    const match2 = promptEngineer.matchTemplate("调研一下微服务架构的最佳实践");
    expect(match2).not.toBeNull();
    expect(match2!.template.category).toBe("research");
    console.log(`  [完成] 研究匹配: ${match2!.template.name} (score: ${match2!.score})`);

    // 调试场景
    const match3 = promptEngineer.matchTemplate("这个 bug 怎么修");
    expect(match3).not.toBeNull();
    console.log(`  [完成] 调试匹配: ${match3!.template.name} (score: ${match3!.score})`);

    // 不应匹配
    const match4 = promptEngineer.matchTemplate("你好");
    expect(match4).toBeNull();
    console.log(`  [完成] 无意义查询未匹配`);
  });

  test("2. 模板填充", () => {
    console.log("\n[测试] 2: 模板填充");

    const template = promptEngineer.listTemplates().find(t => t.id === "code-review")!;
    const filled = promptEngineer.fillTemplate(template, {
      language: "typescript",
      code: "function add(a: number, b: number) { return a + b; }",
      context: "这是一个简单的加法函数",
    });

    expect(filled).toContain("代码审查专家");
    expect(filled).toContain("typescript");
    expect(filled).toContain("function add");
    expect(filled).toContain("这是一个简单的加法函数");
    console.log(`  [完成] 模板填充成功 (${filled.length} chars)`);
  });

  test("3. 一键匹配+填充", () => {
    console.log("\n[测试] 3: 匹配+填充");

    const result = promptEngineer.matchAndFill(
      "生成一个用户认证的代码",
      {
        requirement: "实现 JWT 用户认证中间件",
        techStack: "Node.js + Express + TypeScript",
      }
    );

    expect(result).not.toBeNull();
    expect(result!.prompt).toContain("JWT");
    expect(result!.prompt).toContain("Express");
    console.log(`  [完成] 匹配+填充: ${result!.template.name} (score: ${result!.matchScore})`);
  });

  test("4. Skill 匹配", () => {
    console.log("\n[测试] 4: Skill 匹配");

    const skill1 = promptEngineer.matchSkill("搜索一下 React 19");
    expect(skill1).not.toBeNull();
    expect(skill1!.id).toBe("web-search");
    console.log(`  [完成] Skill匹配: ${skill1!.name}`);

    const skill2 = promptEngineer.matchSkill("审查这段代码");
    expect(skill2).not.toBeNull();
    expect(skill2!.id).toBe("code-analysis");
    console.log(`  [完成] Skill匹配: ${skill2!.name}`);
  });

  test("5. 思考强度过滤", () => {
    console.log("\n[测试] 5: 思考强度过滤");

    // 请求 low 强度，但代码审查是 medium
    const matchLow = promptEngineer.matchTemplate("简单审查代码", {
      thinkingIntensity: "low",
    });
    // 分数应该降低
    console.log(`  [完成] 思考强度过滤: ${matchLow ? matchLow.score : "无匹配"}`);

    // 请求 high 强度
    const matchHigh = promptEngineer.matchTemplate("深度架构设计", {
      thinkingIntensity: "high",
    });
    expect(matchHigh).not.toBeNull();
    expect(matchHigh!.template.thinkingIntensity).toBe("high");
    console.log(`  [完成] 高强度匹配: ${matchHigh!.template.name}`);
  });

  test("6. 类别过滤", () => {
    console.log("\n[测试] 6: 类别过滤");

    const templates = promptEngineer.listTemplates("engineering");
    expect(templates.length).toBeGreaterThan(0);
    expect(templates.every(t => t.category === "engineering")).toBe(true);
    console.log(`  [完成] 类别过滤: ${templates.length} 个 engineering 模板`);
  });

  test("7. 模板持久化", () => {
    console.log("\n[测试] 7: 模板持久化");

    const template = promptEngineer.listTemplates()[0];
    const filePath = promptEngineer.saveTemplateToFile(template, "./test-prompts");

    expect(filePath).toContain(".json");
    console.log(`  [完成] 保存到: ${filePath}`);

    // 清理
    try { fs.unlinkSync(filePath); } catch {}
  });

  test("8. 零向量验证", () => {
    console.log("\n[测试] 8: 零向量验证");

    // 确认没有使用任何向量操作
    const engineer = new PromptEngineer();
    const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(engineer));

    const hasEmbedding = methods.some(m => m.toLowerCase().includes("embed"));
    const hasVector = methods.some(m => m.toLowerCase().includes("vector"));
    const hasSimilarity = methods.some(m => m.toLowerCase().includes("similarity"));
    const hasCosine = methods.some(m => m.toLowerCase().includes("cosine"));

    expect(hasEmbedding).toBe(false);
    expect(hasVector).toBe(false);
    expect(hasSimilarity).toBe(false);
    expect(hasCosine).toBe(false);

    console.log(`  [完成] 零向量验证通过`);
    console.log(`     - 无 embedding 方法: ${!hasEmbedding}`);
    console.log(`     - 无 vector 方法: ${!hasVector}`);
    console.log(`     - 无 similarity 方法: ${!hasSimilarity}`);
    console.log(`     - 无 cosine 方法: ${!hasCosine}`);
    console.log(`     - 匹配方式: 确定性关键词计数`);
  });

  // W3 重构验证：硬编码路径已统一替换为常量
  test("9. saveTemplateToFile 默认目录来自 DEFAULT_PROMPT_DIR 常量", () => {
    console.log("\n[测试] 9: 默认目录使用常量");

    // 构造唯一模板避免与真实文件冲突
    const uniqueId = `test-default-dir-${Date.now()}`;
    const template = {
      id: uniqueId,
      name: "测试默认目录",
      category: "general",
      description: "验证 saveTemplateToFile 默认目录",
      template: "{{query}}",
      variables: ["query"],
      tags: ["test"],
      thinkingIntensity: "low" as const,
      version: "1.0-test",
    };

    // 不传 dir 参数 —— 应使用 DEFAULT_PROMPT_DIR
    const filePath = promptEngineer.saveTemplateToFile(template);
    console.log(`  [完成] 保存到: ${filePath}`);

    try {
      // 行为验证：返回路径以 DEFAULT_PROMPT_DIR 开头，文件确实存在
      const normalizedDefault = path.normalize(DEFAULT_PROMPT_DIR);
      const normalizedReturned = path.normalize(path.dirname(filePath));
      expect(normalizedReturned).toBe(normalizedDefault);
      expect(fs.existsSync(filePath)).toBe(true);
      expect(filePath.endsWith(`${uniqueId}.json`)).toBe(true);
      console.log(`  [完成] 默认目录与 DEFAULT_PROMPT_DIR 一致: ${normalizedDefault}`);
    } finally {
      // 清理：仅删除本测试创建的文件
      try { fs.unlinkSync(filePath); } catch {}
    }
  });

  test("10. DEFAULT_SKILL_DIRS 与 DEFAULT_PROMPT_DIR 均为非空常量", () => {
    console.log("\n[测试] 10: 常量定义完整性");

    expect(Array.isArray(DEFAULT_SKILL_DIRS)).toBe(true);
    expect(DEFAULT_SKILL_DIRS.length).toBeGreaterThan(0);
    expect(DEFAULT_SKILL_DIRS.every(d => typeof d === "string" && d.length > 0)).toBe(true);

    expect(typeof DEFAULT_PROMPT_DIR).toBe("string");
    expect(DEFAULT_PROMPT_DIR.length).toBeGreaterThan(0);

    console.log(`  [完成] DEFAULT_SKILL_DIRS: ${DEFAULT_SKILL_DIRS.join(", ")}`);
    console.log(`  [完成] DEFAULT_PROMPT_DIR: ${DEFAULT_PROMPT_DIR}`);
  });
});
