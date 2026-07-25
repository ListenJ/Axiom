/**
 * Prompt Engineer — 提示词工程引擎 (零向量、纯规则驱动)
 *
 * 设计原则:
 * - 禁止任何 embedding/向量操作
 * - 所有匹配基于确定性规则 (关键词、模式、层级结构)
 * - Hermes Agent 负责生成和优化提示词模板
 * - 通过提示词工程而非向量检索提升输出质量
 */

import fs from "fs";
import path from "path";
import { logger } from "../utils/logger.js";
import { runHermesTask, type HermesResult } from "./hermes-agent.js";
import {
  type PromptTemplate,
  type SkillDefinition,
  type PromptMatchResult,
  DEFAULT_SKILL_DIRS,
} from "../skills/types.js";
import { loadSkillsFromDirectories } from "../skills/skill-loader.js";

// Re-export types for backward compatibility
export type { PromptTemplate, SkillDefinition, PromptMatchResult };

// ========== 预定义提示词模板库 ==========

const BUILT_IN_TEMPLATES: PromptTemplate[] = [
  // === 编码场景 ===
  {
    id: "code-review",
    name: "代码审查",
    category: "engineering",
    description: "审查代码质量、安全性和可维护性",
    template: `你是一位资深代码审查专家。请审查以下代码，关注:

## 审查维度
1. **安全性**: SQL注入、XSS、路径遍历、敏感信息泄露
2. **性能**: 时间复杂度、内存使用、N+1查询、死锁风险
3. **可维护性**: 代码重复、命名规范、函数长度、注释质量
4. **架构**: 模块边界、依赖方向、设计模式应用
5. **测试**: 测试覆盖率、边界条件、异常处理

## 输出格式
对每个问题，按以下格式输出:
- **严重程度**: 🔴严重 / 🟡警告 / 🟢建议
- **位置**: 文件路径 + 行号
- **问题描述**: 具体问题
- **修复建议**: 代码示例或重构方案

## 待审查代码

\`\`\`{{language}}
{{code}}
\`\`\`

{{#if context}}
## 上下文
{{context}}
{{/if}}`,
    variables: ["language", "code", "context"],
    tags: ["code", "review", "security", "quality"],
    thinkingIntensity: "medium",
    modelConstraints: { supportsThinking: true },
    version: "1.0",
  },
  {
    id: "code-generation",
    name: "代码生成",
    category: "engineering",
    description: "根据需求生成高质量代码",
    template: `你是一位专业软件工程师。请根据以下需求生成代码:

## 需求
{{requirement}}

## 技术要求
{{#if techStack}}
- 技术栈: {{techStack}}
{{/if}}
- 遵循最佳实践和设计模式
- 包含必要的错误处理
- 编写清晰的注释
- 提供单元测试示例

## 输出要求
1. 先简要说明设计思路
2. 提供完整可运行的代码
3. 解释关键决策点
4. 指出潜在风险和替代方案`,
    variables: ["requirement", "techStack"],
    tags: ["code", "generation", "implementation"],
    thinkingIntensity: "medium",
    version: "1.0",
  },
  {
    id: "refactor",
    name: "代码重构",
    category: "engineering",
    description: "改进代码结构，保持行为不变",
    template: `你是一位重构专家。请对以下代码进行重构，目标:

## 重构目标
{{#if goals}}
{{goals}}
{{else}}
- 提高可读性
- 降低复杂度
- 消除重复
- 改善命名
{{/if}}

## 原则
- 保持行为不变（不改变功能）
- 小步重构，每次一个改进点
- 解释每个重构步骤的理由
- 提供重构前后的对比

## 原始代码

\`\`\`{{language}}
{{code}}
\`\`\``,
    variables: ["language", "code", "goals"],
    tags: ["code", "refactor", "clean-code"],
    thinkingIntensity: "medium",
    version: "1.0",
  },

  // === 研究场景 ===
  {
    id: "deep-research",
    name: "深度研究",
    category: "research",
    description: "对技术主题进行深度调研",
    template: `你是一位技术研究员。请对以下主题进行深度研究:

## 研究主题
{{topic}}

## 研究框架
1. **背景与定义**: 该技术的核心概念和发展历程
2. **技术原理**: 关键机制和工作流程
3. **对比分析**: 与同类技术的优劣对比（表格形式）
4. **应用场景**: 典型使用案例和最佳实践
5. **生态工具**: 相关的库、框架和工具链
6. **发展趋势**: 最新进展和未来方向
7. **风险评估**: 已知局限性和潜在问题

## 输出要求
- 使用结构化 Markdown 格式
- 包含数据来源和参考链接
- 对不确定的信息明确标注
- 提供可操作的结论和建议`,
    variables: ["topic"],
    tags: ["research", "analysis", "deep-dive"],
    thinkingIntensity: "high",
    modelConstraints: { supportsThinking: true, minContextWindow: 128000 },
    version: "1.0",
  },
  {
    id: "architecture-design",
    name: "架构设计",
    category: "engineering",
    description: "设计系统架构方案",
    template: `你是一位系统架构师。请为以下需求设计架构方案:

## 需求描述
{{requirement}}

## 设计约束
{{#if constraints}}
{{constraints}}
{{else}}
- 可扩展性: 支持未来 10x 流量增长
- 可用性: 99.9% SLA
- 安全性: 符合行业安全标准
- 成本: 在满足性能前提下优化成本
{{/if}}

## 输出要求
1. **架构图描述**: 使用文本描述各组件关系
2. **技术选型**: 对比至少 2 种方案，给出推荐理由
3. **数据流**: 关键业务流程的数据流动
4. **接口设计**: 核心 API 定义
5. **部署方案**: 基础设施和部署策略
6. **风险评估**: 单点故障、性能瓶颈、安全漏洞`,
    variables: ["requirement", "constraints"],
    tags: ["architecture", "design", "system"],
    thinkingIntensity: "high",
    modelConstraints: { supportsThinking: true, minContextWindow: 128000 },
    version: "1.0",
  },

  // === 调试场景 ===
  {
    id: "debug",
    name: "调试排错",
    category: "engineering",
    description: "系统性定位和修复问题",
    template: `你是一位调试专家。请帮助诊断和修复以下问题:

## 问题描述
{{problem}}

## 相关代码
\`\`\`{{language}}
{{code}}
\`\`\`

## 错误信息
{{#if error}}
\`\`\`
{{error}}
\`\`\`
{{/if}}

## 调试步骤
请按以下步骤分析:
1. **根因分析**: 定位问题的根本原因
2. **影响评估**: 该问题可能影响的其他部分
3. **修复方案**: 提供具体的代码修复
4. **验证方法**: 如何验证修复是否有效
5. **预防措施**: 如何避免类似问题再次发生`,
    variables: ["problem", "language", "code", "error"],
    tags: ["debug", "troubleshoot", "fix"],
    thinkingIntensity: "high",
    modelConstraints: { supportsThinking: true },
    version: "1.0",
  },

  // === 测试场景 ===
  {
    id: "test-generation",
    name: "测试生成",
    category: "engineering",
    description: "生成全面的测试用例",
    template: `你是一位测试专家。请为以下代码生成测试:

## 待测试代码
\`\`\`{{language}}
{{code}}
\`\`\`

## 测试要求
1. **单元测试**: 覆盖所有分支和边界条件
2. **集成测试**: 关键交互路径
3. **异常测试**: 错误输入和异常情况
4. **性能测试**: 如有性能要求，提供基准测试

## 输出格式
- 使用 {{testFramework}} 框架
- 每个测试包含: 描述、准备、执行、断言
- 标注测试覆盖的功能点`,
    variables: ["language", "code", "testFramework"],
    tags: ["test", "unit-test", "coverage"],
    thinkingIntensity: "medium",
    version: "1.0",
  },

  // === 文档场景 ===
  {
    id: "doc-generation",
    name: "文档生成",
    category: "engineering",
    description: "生成技术文档",
    template: `你是一位技术文档专家。请生成以下技术文档:

## 文档类型
{{docType}}

## 主题
{{topic}}

## 内容要求
{{#if requirements}}
{{requirements}}
{{else}}
- 清晰的结构和导航
- 包含代码示例
- 解释"为什么"而不仅是"怎么做"
- 提供故障排除指南
{{/if}}

## 目标读者
{{#if audience}}
{{audience}}
{{else}}
中级开发者，具备相关技术基础
{{/if}}`,
    variables: ["docType", "topic", "requirements", "audience"],
    tags: ["doc", "documentation", "technical-writing"],
    thinkingIntensity: "low",
    version: "1.0",
  },

  // === 通用场景 ===
  {
    id: "general-chat",
    name: "通用对话",
    category: "general",
    description: "通用问答和对话",
    template: `你是一位 helpful 的 AI 助手。请回答用户的问题:

{{query}}

## 回答原则
- 直接回答核心问题
- 如果不确定，明确说明
- 提供可操作的建议
- 保持简洁但完整`,
    variables: ["query"],
    tags: ["general", "chat", "qa"],
    thinkingIntensity: "low",
    version: "1.0",
  },
];

// ========== 预定义 Skill 定义库 ==========

const BUILT_IN_SKILLS: SkillDefinition[] = [
  {
    id: "web-search",
    name: "网络搜索",
    description: "执行隐私保护的网络搜索",
    triggers: ["搜索", "查找", "查询", "调研", "search", "find", "look up"],
    promptTemplate: `执行网络搜索: {{query}}

要求:
1. 使用隐私保护搜索
2. 返回结构化结果
3. 标注来源可信度`,
    requiredTools: ["search_engines", "proxy_manager"],
    outputFormat: "markdown",
    version: "1.0",
  },
  {
    id: "code-analysis",
    name: "代码分析",
    description: "分析代码质量和安全性",
    triggers: ["审查", "review", "分析代码", "检查", "audit"],
    promptTemplate: `审查以下代码:

{{code}}

关注: 安全性、性能、可维护性、架构设计`,
    requiredTools: ["code_indexer"],
    outputFormat: "markdown",
    version: "1.0",
  },
  {
    id: "knowledge-import",
    name: "知识导入",
    description: "将外部知识导入 Vault",
    triggers: ["导入", "保存", "归档", "import", "archive"],
    promptTemplate: `将以下内容导入知识库:

{{content}}

分类: {{category}}
标签: {{tags}}`,
    requiredTools: ["vault_manager"],
    outputFormat: "markdown",
    version: "1.0",
  },
];

// ========== Prompt Engineer 类 ==========

export class PromptEngineer {
  private templates = new Map<string, PromptTemplate>();
  private skills = new Map<string, SkillDefinition>();

  constructor() {
    // 加载内置模板
    for (const t of BUILT_IN_TEMPLATES) {
      this.templates.set(t.id, t);
    }
    for (const s of BUILT_IN_SKILLS) {
      this.skills.set(s.id, s);
    }

    // 加载外部 skill 文件
    this.reloadSkillsFromDisk();
  }

  /**
   * 从磁盘重新加载动态 skills
   */
  reloadSkillsFromDisk(): void {
    const skillDirs = [...DEFAULT_SKILL_DIRS];

    const loaded = loadSkillsFromDirectories({
      skillDirs,
      extensions: ["json", "yaml", "yml"],
    });

    // 合并动态 skills（不覆盖内置）
    for (const [id, skill] of loaded.skills) {
      if (!this.skills.has(id)) {
        this.skills.set(id, skill);
      }
    }

    // 合并动态模板（不覆盖内置）
    for (const [id, template] of loaded.templates) {
      if (!this.templates.has(id)) {
        this.templates.set(id, template);
      }
    }

    if (loaded.errors.length > 0) {
      logger.warn("[PromptEngineer] Some skill files failed to load", { errors: loaded.errors });
    }

    logger.info("[PromptEngineer] Loaded", {
      templates: this.templates.size,
      skills: this.skills.size,
      fileSkills: loaded.skills.size,
      fileTemplates: loaded.templates.size,
      errors: loaded.errors.length,
    });
  }

  // ===== 模板匹配 (确定性规则, 零向量) =====

  /**
   * 根据任务描述匹配最佳提示词模板
   * 纯确定性匹配: 关键词计数 + 类别映射 + 层级评分
   */
  matchTemplate(taskDescription: string, opts?: {
    category?: string;
    thinkingIntensity?: "none" | "low" | "medium" | "high";
  }): PromptMatchResult | null {
    const lower = taskDescription.toLowerCase();
    const scores = new Map<string, { score: number; reasons: string[] }>();

    for (const [id, template] of this.templates) {
      let score = 0;
      const reasons: string[] = [];

      // 1. 类别关键词匹配 (权重 3x)
      const catKeywords = this.getCategoryKeywords(template.category);
      const catMatches = catKeywords.filter((kw) => lower.includes(kw));
      score += catMatches.length * 3;
      if (catMatches.length > 0) reasons.push(`类别匹配: ${catMatches.join(", ")}`);

      // 2. 标签关键词匹配 (权重 2x)
      const tagMatches = template.tags.filter((tag) => lower.includes(tag));
      score += tagMatches.length * 2;
      if (tagMatches.length > 0) reasons.push(`标签匹配: ${tagMatches.join(", ")}`);

      // 3. 模板名称匹配 (权重 5x)
      if (lower.includes(template.name.toLowerCase())) {
        score += 5;
        reasons.push("名称直接匹配");
      }

      // 4. 描述关键词匹配 (权重 1x)
      // 支持中英文：英文按空格分词(>2字符)，中文提取2-3字短语
      const descLower = template.description.toLowerCase();
      let descScore = 0;
      // 英文分词
      const engWords = descLower.split(/\s+/).filter((w) => w.length > 2 && /^[a-z]/.test(w));
      for (const w of engWords) {
        if (lower.includes(w)) descScore++;
      }
      // 中文提取：滑动窗口提取2-3字短语
      for (let i = 0; i < descLower.length - 1; i++) {
        const ch = descLower[i];
        if (/[\u4e00-\u9fa5]/.test(ch)) {
          for (let len = 2; len <= 3 && i + len <= descLower.length; len++) {
            const substr = descLower.slice(i, i + len);
            if (lower.includes(substr)) {
              descScore++;
              break; // 避免同一位置重复计数
            }
          }
        }
      }
      score += descScore;
      if (descScore > 0) reasons.push(`描述匹配: ${descScore}个词`);

      // 5. 思考强度过滤
      if (opts?.thinkingIntensity && template.thinkingIntensity !== opts.thinkingIntensity) {
        score *= 0.5; // 思考强度不匹配，降低权重
      }

      // 6. 类别过滤
      if (opts?.category && template.category !== opts.category) {
        score *= 0.3; // 类别不匹配，大幅降低权重
      }

      if (score > 0) {
        scores.set(id, { score, reasons });
      }
    }

    // 选择最高分
    let bestId = "";
    let bestScore = 0;
    for (const [id, { score }] of scores) {
      if (score > bestScore) {
        bestScore = score;
        bestId = id;
      }
    }

    if (!bestId || bestScore < 2) return null;

    const template = this.templates.get(bestId)!;
    const matchInfo = scores.get(bestId)!;

    return {
      template,
      score: bestScore,
      reasons: matchInfo.reasons,
    };
  }

  /**
   * 填充模板变量
   */
  fillTemplate(template: PromptTemplate, variables: Record<string, string>): string {
    let result = template.template;

    // 简单变量替换 {{varName}}
    for (const [key, value] of Object.entries(variables)) {
      result = result.replace(new RegExp(`\\{\\{${key}\\}\\}`, "g"), value);
    }

    // 处理条件块 {{#if var}}...{{/if}}
    result = result.replace(/\{\{#if\s+(\w+)\}\}([\s\S]*?)\{\{\/if\}\}/g, (match, varName, content) => {
      return variables[varName] ? content : "";
    });

    // 清理未替换的变量
    result = result.replace(/\{\{\w+\}\}/g, "");

    return result.trim();
  }

  /**
   * 匹配并填充模板 (一键操作)
   */
  matchAndFill(taskDescription: string, variables: Record<string, string>, opts?: {
    category?: string;
    thinkingIntensity?: "none" | "low" | "medium" | "high";
  }): { prompt: string; template: PromptTemplate; matchScore: number } | null {
    const match = this.matchTemplate(taskDescription, opts);
    if (!match) return null;

    const filled = this.fillTemplate(match.template, variables);
    return {
      prompt: filled,
      template: match.template,
      matchScore: match.score,
    };
  }

  // ===== Skill 匹配 =====

  /**
   * 根据触发词匹配 Skill
   */
  matchSkill(trigger: string): SkillDefinition | null {
    const lower = trigger.toLowerCase();
    let bestSkill: SkillDefinition | null = null;
    let bestScore = 0;

    for (const skill of this.skills.values()) {
      const matches = skill.triggers.filter((t) => lower.includes(t.toLowerCase()));
      if (matches.length > bestScore) {
        bestScore = matches.length;
        bestSkill = skill;
      }
    }

    return bestSkill;
  }

  /**
   * 列出所有可用模板
   */
  listTemplates(category?: string): PromptTemplate[] {
    const all = Array.from(this.templates.values());
    if (category) {
      return all.filter((t) => t.category === category);
    }
    return all;
  }

  /**
   * 列出所有可用 Skills
   */
  listSkills(): SkillDefinition[] {
    return Array.from(this.skills.values());
  }

  // ===== Hermes 集成: 生成/优化提示词 =====

  /**
   * 使用 Hermes 生成新的提示词模板
   */
  async generateTemplateWithHermes(
    description: string,
    category: string,
    variables: string[]
  ): Promise<PromptTemplate | null> {
    const result = await runHermesTask({
      prompt: `作为 Prompt Engineering 专家，请为以下场景设计一个高质量的提示词模板:

## 场景描述
${description}

## 要求
1. 模板使用 {{variableName}} 语法表示变量
2. 使用 {{#if variable}}...{{/if}} 表示条件块
3. 包含清晰的指令和输出格式要求
4. 思考强度: 根据场景复杂度选择 low/medium/high
5. 标签: 3-5个关键词标签

## 输出格式
请输出 JSON 格式:
\`\`\`json
{
  "name": "模板名称",
  "description": "简短描述",
  "template": "提示词内容...",
  "thinkingIntensity": "low|medium|high",
  "tags": ["tag1", "tag2"]
}
\`\`\``,
      timeoutMs: 120_000,
    });

    if (!result.success) {
      logger.warn("[PromptEngineer] Hermes template generation failed", { stderr: result.stderr });
      return null;
    }

    try {
      const jsonMatch = result.stdout.match(/```json\n([\s\S]*?)\n```/);
      const jsonStr = jsonMatch ? jsonMatch[1] : result.stdout;
      const data = JSON.parse(jsonStr);

      const template: PromptTemplate = {
        id: `hermes-${Date.now()}`,
        name: data.name,
        category,
        description: data.description,
        template: data.template,
        variables,
        tags: data.tags || [],
        thinkingIntensity: data.thinkingIntensity || "medium",
        version: "1.0-hermes",
      };

      this.templates.set(template.id, template);
      logger.info("[PromptEngineer] Generated template via Hermes", { id: template.id, name: template.name });
      return template;
    } catch (e) {
      logger.warn("[PromptEngineer] Failed to parse Hermes output", { error: (e as Error).message });
      return null;
    }
  }

  /**
   * 使用 Hermes 优化现有提示词
   */
  async optimizePromptWithHermes(prompt: string, goal: string): Promise<string | null> {
    const result = await runHermesTask({
      prompt: `作为 Prompt Optimization 专家，请优化以下提示词:

## 优化目标
${goal}

## 原始提示词
${prompt}

## 优化要求
1. 提高指令清晰度
2. 添加结构化输出要求
3. 减少歧义
4. 保持核心意图不变

请直接输出优化后的提示词，不要添加额外解释。`,
      timeoutMs: 60_000,
    });

    if (!result.success) return null;
    return result.stdout.trim();
  }

  /**
   * 使用 Hermes 生成 Skill 定义
   */
  async generateSkillWithHermes(
    name: string,
    description: string,
    triggers: string[]
  ): Promise<SkillDefinition | null> {
    const result = await runHermesTask({
      prompt: `作为 Skill Designer，请设计一个可复用的 AI Skill:

## Skill 名称
${name}

## 描述
${description}

## 触发词
${triggers.join(", ")}

## 要求
1. 设计清晰的提示词模板
2. 定义所需的工具/能力
3. 指定输出格式

请输出 JSON:
\`\`\`json
{
  "promptTemplate": "提示词模板，使用 {{variable}} 语法",
  "requiredTools": ["tool1", "tool2"],
  "outputFormat": "text|json|markdown|code"
}
\`\`\``,
      timeoutMs: 120_000,
    });

    if (!result.success) return null;

    try {
      const jsonMatch = result.stdout.match(/```json\n([\s\S]*?)\n```/);
      const jsonStr = jsonMatch ? jsonMatch[1] : result.stdout;
      const data = JSON.parse(jsonStr);

      const skill: SkillDefinition = {
        id: `skill-${Date.now()}`,
        name,
        description,
        triggers,
        promptTemplate: data.promptTemplate,
        requiredTools: data.requiredTools || [],
        outputFormat: data.outputFormat || "text",
        version: "1.0-hermes",
      };

      this.skills.set(skill.id, skill);
      return skill;
    } catch {
      return null;
    }
  }

  // ===== 辅助方法 =====

  private getCategoryKeywords(category: string): string[] {
    const map: Record<string, string[]> = {
      engineering: [
        "代码", "编程", "开发", "生成", "实现", "编写", "创建", "构建", "bug", "调试", "重构", "api", "架构", "review",
        "code", "programming", "generate", "implement", "debug", "refactor", "测试", "test", "单元测试",
        "部署", "deploy", "ci/cd", "docker", "k8s", "前端", "后端", "fullstack",
        "算法", "数据结构", "性能", "优化", "安全", "漏洞", "git", "版本控制",
        "函数", "类", "组件", "接口", "模块", "库", "框架", "typescript", "javascript",
        "python", "java", "go", "rust", "sql", "数据库", "redis", "mongodb",
        "微服务", "monolith", "serverless", "lambda", "cloud", "aws", "azure",
      ],
      research: [
        "研究", "调研", "分析", "对比", "评估", "research", "analysis", "compare", "evaluate",
        "论文", "文献", "综述", "survey", "benchmark", "性能测试", "趋势", "trend",
        "最佳实践", "best practice", "方案", "solution", "技术选型", "选型",
        "调研报告", "白皮书", "whitepaper", "案例研究", "case study",
      ],
      general: [
        "问题", "帮助", "咨询", "question", "help", "assist", "建议", "advice",
        "解释", "explain", "说明", "什么是", "how to", "怎么做", "为什么",
        "介绍", "introduce", "概述", "overview", "总结", "summary",
      ],
    };
    return map[category] || [];
  }

  /**
   * 保存模板到文件
   */
  saveTemplateToFile(template: PromptTemplate, dir: string = "./axiom-memory/03-Resources/prompts"): string {
    const filePath = path.join(dir, `${template.id}.json`);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(template, null, 2), "utf-8");
    return filePath;
  }

  /**
   * 从文件加载模板
   */
  loadTemplateFromFile(filePath: string): PromptTemplate | null {
    try {
      const content = fs.readFileSync(filePath, "utf-8");
      const template = JSON.parse(content) as PromptTemplate;
      this.templates.set(template.id, template);
      return template;
    } catch {
      return null;
    }
  }
}

// 全局实例
export const promptEngineer = new PromptEngineer();
