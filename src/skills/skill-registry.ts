/**
 * Skill Registry v2.0 — 动态 Skill 匹配与执行
 *
 * 功能:
 *   - 管理所有 Skill（内置 + 文件加载 + Hermes 生成）
 *   - 基于 trigger 关键词的确定性匹配（零向量）
 *   - Skill 模板填充（变量替换）
 *   - Skill 执行（路由到模型 + 工具调用）
 *   - 与 MCP ToolRegistry 桥接
 *
 * 使用:
 *   const registry = getSkillRegistry();
 *   const match = registry.match("帮我写个快速排序");
 *   if (match) {
 *     const result = await registry.execute(match, { input: "..." });
 *   }
 */

import { logger } from "../utils/logger.js";
import { router } from "../router/model-router.js";
import { type SkillDefinition, type PromptTemplate, DEFAULT_SKILL_DIRS } from "./types.js";
import { loadSkillsFromDirectories, type LoadedSkills } from "./skill-loader.js";

// ═══════════════════════════════════════════════════════════════
// 类型
// ═══════════════════════════════════════════════════════════════

export interface SkillMatch {
  skill: SkillDefinition;
  score: number;
  confidence: "high" | "medium" | "low";
  params: Record<string, string>;
}

export interface SkillExecuteResult {
  content: string;
  skillId: string;
  model: string;
  provider: string;
  toolCalls?: Array<{ tool: string; result: unknown }>;
  latencyMs: number;
}

export interface SkillRegistryOptions {
  /** Skill 文件目录 */
  skillDirs?: string[];
  /** 是否启用文件监视（热重载） */
  watch?: boolean;
  /** 匹配阈值 (0-1) */
  matchThreshold?: number;
}

// ═══════════════════════════════════════════════════════════════
// 内置 Skill 库
// ═══════════════════════════════════════════════════════════════

const BUILTIN_SKILLS: SkillDefinition[] = [
  {
    id: "code-generate",
    name: "代码生成",
    description: "根据描述生成代码",
    triggers: ["写代码", "生成", "create", "generate", "implement", "写一个", "实现"],
    promptTemplate: `你是一个资深工程师。请根据以下需求生成高质量代码：

需求: {{input}}

要求:
- 代码简洁、可读性强
- 添加必要的注释
- 考虑边界情况
- 使用 TypeScript (除非特别指定)

请直接输出代码，不需要解释。`,
    requiredTools: [],
    outputFormat: "code",
    version: "1.0",
    source: "builtin",
  },
  {
    id: "code-review",
    name: "代码审查",
    description: "审查代码质量",
    triggers: ["审查", "review", "检查", "code review", "看看这段代码"],
    promptTemplate: `你是一个代码审查专家。请审查以下代码：

\`\`\`
{{input}}
\`\`\`

请从以下维度分析：
1. 代码质量（可读性、可维护性）
2. 潜在 bug 和安全问题
3. 性能优化建议
4. 最佳实践合规性

请以 markdown 格式输出审查报告。`,
    requiredTools: [],
    outputFormat: "markdown",
    version: "1.0",
    source: "builtin",
  },
  {
    id: "refactor",
    name: "代码重构",
    description: "重构代码提升质量",
    triggers: ["重构", "refactor", "优化", "改进", "简化"],
    promptTemplate: `请重构以下代码，提升其质量和可读性：

\`\`\`
{{input}}
\`\`\`

重构目标:
- 消除代码异味
- 提高内聚性，降低耦合
- 遵循 SOLID 原则
- 保持原有功能不变

请输出重构后的代码，并简要说明改动原因。`,
    requiredTools: [],
    outputFormat: "code",
    version: "1.0",
    source: "builtin",
  },
  {
    id: "explain",
    name: "代码解释",
    description: "解释代码工作原理",
    triggers: ["解释", "explain", "说明", "什么意思", "how does", "what does"],
    promptTemplate: `请用通俗易懂的语言解释以下代码：

\`\`\`
{{input}}
\`\`\`

要求:
- 解释整体逻辑和关键步骤
- 解释重要的算法或数据结构
- 用中文回答（除非代码是英文注释）
- 适当举例说明`,
    requiredTools: [],
    outputFormat: "text",
    version: "1.0",
    source: "builtin",
  },
  {
    id: "test-generate",
    name: "测试生成",
    description: "为代码生成测试用例",
    triggers: ["测试", "test", "单元测试", "unittest", "spec", "jest"],
    promptTemplate: `请为以下代码生成完整的单元测试：

\`\`\`
{{input}}
\`\`\`

要求:
- 使用 Bun Test (bun:test)
- 覆盖正常路径和边界情况
- 测试命名清晰
- 包含必要的 mock/stub
- 输出可直接运行的测试文件`,
    requiredTools: [],
    outputFormat: "code",
    version: "1.0",
    source: "builtin",
  },
  {
    id: "doc-generate",
    name: "文档生成",
    description: "生成 API 文档或 README",
    triggers: ["文档", "doc", "readme", "注释", "document"],
    promptTemplate: `请为以下代码生成文档：

\`\`\`
{{input}}
\`\`\`

要求:
- 生成 JSDoc/TSDoc 风格的注释
- 包含参数说明、返回值、示例
- 如果输入是函数/类，生成 API 文档
- 如果输入是模块，生成 README 摘要`,
    requiredTools: [],
    outputFormat: "markdown",
    version: "1.0",
    source: "builtin",
  },
  {
    id: "bug-fix",
    name: "Bug 修复",
    description: "分析并修复代码中的 bug",
    triggers: ["bug", "修复", "fix", "报错", "error", "异常", "crash"],
    promptTemplate: `以下代码存在问题，请分析并修复：

\`\`\`
{{input}}
\`\`\`

要求:
1. 先分析问题原因
2. 给出修复后的代码
3. 解释 bug 的根本原因
4. 提供预防类似问题的建议`,
    requiredTools: [],
    outputFormat: "code",
    version: "1.0",
    source: "builtin",
  },
  {
    id: "architecture-review",
    name: "架构审查",
    description: "审查系统架构设计",
    triggers: ["架构", "architecture", "设计", "design", "系统", "structure"],
    promptTemplate: `请审查以下架构设计/代码结构：

{{input}}

请从以下维度分析：
1. 架构模式是否合理
2. 模块划分是否清晰
3. 依赖关系是否健康
4. 可扩展性和可维护性
5. 潜在的技术债务

请以结构化方式输出审查报告。`,
    requiredTools: [],
    outputFormat: "markdown",
    version: "1.0",
    source: "builtin",
  },
  {
    id: "computer-use",
    name: "计算机自动化",
    description: "通过视觉模型控制计算机",
    triggers: ["截图", "点击", "自动化", "computer", "browser", "网页", "操作"],
    promptTemplate: `请分析当前屏幕截图并决定下一步操作：

任务: {{input}}

当前状态已作为截图提供。请返回结构化的操作指令。`,
    requiredTools: ["computer_use"],
    outputFormat: "json",
    version: "1.0",
    source: "builtin",
  },
];

// ═══════════════════════════════════════════════════════════════
// Skill Registry
// ═══════════════════════════════════════════════════════════════

export class SkillRegistry {
  private skills = new Map<string, SkillDefinition>();
  private templates = new Map<string, PromptTemplate>();
  private options: SkillRegistryOptions;
  private loadedFromFiles = false;

  constructor(options: SkillRegistryOptions = {}) {
    this.options = {
      skillDirs: [...DEFAULT_SKILL_DIRS],
      watch: false,
      matchThreshold: 0.3,
      ...options,
    };

    // 加载内置 skill
    for (const skill of BUILTIN_SKILLS) {
      this.skills.set(skill.id, skill);
    }

    // 尝试加载文件 skill
    this.loadFileSkills();
  }

  // ---------------------------------------------------------------------------
  // 加载
  // ---------------------------------------------------------------------------

  private loadFileSkills(): void {
    try {
      const loaded = loadSkillsFromDirectories({
        skillDirs: this.options.skillDirs || [],
        watch: this.options.watch,
      });

      for (const [id, skill] of loaded.skills) {
        this.skills.set(id, skill);
      }
      for (const [id, template] of loaded.templates) {
        this.templates.set(id, template);
      }

      this.loadedFromFiles = true;
      logger.info("[SkillRegistry] File skills loaded", {
        skills: loaded.skills.size,
        templates: loaded.templates.size,
        errors: loaded.errors.length,
      });
    } catch (e) {
      logger.warn("[SkillRegistry] Failed to load file skills", { error: (e as Error).message });
    }
  }

  /** 重新加载所有 skill（保留运行时注册的 hermes 自进化技能，避免 reload 清空进化成果） */
  reload(): void {
    const runtime = new Map<string, SkillDefinition>();
    for (const [id, skill] of this.skills) {
      if (skill.source === "hermes") runtime.set(id, skill);
    }
    this.skills.clear();
    this.templates.clear();
    for (const skill of BUILTIN_SKILLS) {
      this.skills.set(skill.id, skill);
    }
    this.loadFileSkills();
    for (const [id, skill] of runtime) this.skills.set(id, skill);
    logger.info("[SkillRegistry] Reloaded", { runtimePreserved: runtime.size });
  }

  // ---------------------------------------------------------------------------
  // 匹配
  // ---------------------------------------------------------------------------

  /**
   * 基于 trigger 关键词的确定性匹配
   *
   * 算法:
   *   1. 对每个 skill，计算 trigger 匹配数
   *   2. 按匹配数排序
   *   3. 返回最高分 skill（如果超过阈值）
   */
  match(input: string): SkillMatch | null {
    const normalized = input.toLowerCase();
    const words = new Set(normalized.split(/\s+/));
    let best: SkillMatch | null = null;
    let bestScore = 0;

    for (const skill of this.skills.values()) {
      let score = 0;
      const matchedTriggers: string[] = [];

      for (const trigger of skill.triggers) {
        const triggerLower = trigger.toLowerCase();
        // 完整包含匹配（权重高）
        if (normalized.includes(triggerLower)) {
          score += trigger.length >= 4 ? 3 : 2;
          matchedTriggers.push(trigger);
        }
        // 分词匹配（权重低）
        else if (words.has(triggerLower)) {
          score += 1;
          matchedTriggers.push(trigger);
        }
      }

      // 语言/文件模式匹配
      if (skill.language) {
        const langPattern = new RegExp(`\\b${skill.language}\\b`, "i");
        if (langPattern.test(input)) score += 2;
      }
      if (skill.filePatterns) {
        for (const pattern of skill.filePatterns) {
          const regex = new RegExp(pattern.replace(/\*/g, ".*"), "i");
          if (regex.test(input)) score += 2;
        }
      }

      if (score > bestScore) {
        bestScore = score;
        const totalTriggers = skill.triggers.length || 1;
        const confidenceRatio = matchedTriggers.length / totalTriggers;
        best = {
          skill,
          score,
          confidence: confidenceRatio >= 0.5 ? "high" : confidenceRatio >= 0.2 ? "medium" : "low",
          params: { input, matchedTriggers: matchedTriggers.join(",") },
        };
      }
    }

    const threshold = this.options.matchThreshold || 0.3;
    if (best && bestScore >= threshold) {
      return best;
    }

    return null;
  }

  /**
   * 模糊匹配 — 返回所有可能匹配的 skill（用于建议）
   */
  matchAll(input: string, limit = 5): SkillMatch[] {
    const normalized = input.toLowerCase();
    const words = new Set(normalized.split(/\s+/));
    const matches: SkillMatch[] = [];

    for (const skill of this.skills.values()) {
      let score = 0;
      const matchedTriggers: string[] = [];

      for (const trigger of skill.triggers) {
        const triggerLower = trigger.toLowerCase();
        if (normalized.includes(triggerLower)) {
          score += trigger.length >= 4 ? 3 : 2;
          matchedTriggers.push(trigger);
        } else if (words.has(triggerLower)) {
          score += 1;
          matchedTriggers.push(trigger);
        }
      }

      if (score > 0) {
        matches.push({
          skill,
          score,
          confidence: score >= 3 ? "high" : score >= 2 ? "medium" : "low",
          params: { input, matchedTriggers: matchedTriggers.join(",") },
        });
      }
    }

    matches.sort((a, b) => b.score - a.score);
    return matches.slice(0, limit);
  }

  // ---------------------------------------------------------------------------
  // 执行
  // ---------------------------------------------------------------------------

  /**
   * 执行匹配的 Skill
   *
   * 流程:
   *   1. 填充 prompt 模板
   *   2. 路由到合适的模型
   *   3. 执行（如果 skill 需要工具，通过 MCP 调用）
   */
  async execute(
    match: SkillMatch,
    context?: Record<string, unknown>,
    options: { maxTokens?: number; timeout?: number; signal?: AbortSignal } = {},
  ): Promise<SkillExecuteResult> {
    const startTime = Date.now();
    const skill = match.skill;

    // 1. 填充模板
    const filledPrompt = this.fillTemplate(skill.promptTemplate, {
      ...match.params,
      ...context,
    });

    // 2. 路由模型
    const role = this.mapSkillToRole(skill);
    const messages = [
      { role: "system" as const, content: `You are executing the "${skill.name}" skill. Follow the instructions precisely.` },
      { role: "user" as const, content: filledPrompt },
    ];

    // 需求 4：LLM 调用前自动注入 DRE 实践手册约束词（命中关键词时）
    const { autoInjectDreConstraints } = await import("../dre/constraint-injection.js");
    const injection = autoInjectDreConstraints(messages, filledPrompt);
    const llmMessages = injection.changed ? injection.messages : messages;
    if (injection.changed) logger.info("[SkillRegistry] DRE constraints injected", { injected: injection.injected });

    try {
      const result = await router.executeWithRole(role, llmMessages, {
        ...(options.maxTokens !== undefined ? { maxTokens: options.maxTokens } : {}),
        ...(options.timeout !== undefined ? { timeout: options.timeout } : {}),
        ...(options.signal !== undefined ? { signal: options.signal } : {}),
      });
      const latencyMs = Date.now() - startTime;

      return {
        content: result.content || "",
        skillId: skill.id,
        model: result.model,
        provider: result.provider,
        latencyMs,
      };
    } catch (error) {
      const latencyMs = Date.now() - startTime;
      logger.warn("[SkillRegistry] Execution failed", { skill: skill.id, error: (error as Error).message });
      return {
        content: `[Skill execution failed] ${(error as Error).message}`,
        skillId: skill.id,
        model: "error",
        provider: "error",
        latencyMs,
      };
    }
  }

  /**
   * 快速执行 — 匹配 + 执行一步完成
   */
  async quickExecute(input: string, context?: Record<string, unknown>): Promise<SkillExecuteResult | null> {
    const match = this.match(input);
    if (!match) return null;
    return this.execute(match, context);
  }

  /**
   * 按 id 执行 skill（模型/工具按需调用入口，MCP skill_run 使用）。
   * 返回 null 表示 skill 不存在；执行失败返回 content 含错误信息（与 execute 一致）。
   */
  async executeById(
    skillId: string,
    params: Record<string, string> = {},
    context?: Record<string, unknown>,
    options: { maxTokens?: number; timeout?: number; signal?: AbortSignal } = {},
  ): Promise<SkillExecuteResult | null> {
    const skill = this.skills.get(skillId);
    if (!skill) return null;
    return this.execute({ skill, score: 1, confidence: "high", params }, context, options);
  }

  // ---------------------------------------------------------------------------
  // 管理
  // ---------------------------------------------------------------------------

  register(skill: SkillDefinition): void {
    this.skills.set(skill.id, skill);
    logger.info("[SkillRegistry] Registered skill", { id: skill.id, source: skill.source });
  }

  unregister(skillId: string): boolean {
    const existed = this.skills.delete(skillId);
    if (existed) logger.info("[SkillRegistry] Unregistered skill", { id: skillId });
    return existed;
  }

  get(skillId: string): SkillDefinition | undefined {
    return this.skills.get(skillId);
  }

  list(): SkillDefinition[] {
    return Array.from(this.skills.values());
  }

  listByCategory(): Record<string, SkillDefinition[]> {
    const grouped: Record<string, SkillDefinition[]> = {};
    for (const skill of this.skills.values()) {
      const cat = skill.outputFormat || "other";
      if (!grouped[cat]) grouped[cat] = [];
      grouped[cat].push(skill);
    }
    return grouped;
  }

  stats(): { total: number; builtin: number; file: number; hermes: number } {
    const all = Array.from(this.skills.values());
    return {
      total: all.length,
      builtin: all.filter((s) => s.source === "builtin").length,
      file: all.filter((s) => s.source === "file").length,
      hermes: all.filter((s) => s.source === "hermes").length,
    };
  }

  // ---------------------------------------------------------------------------
  // 私有方法
  // ---------------------------------------------------------------------------

  private fillTemplate(template: string, vars: Record<string, unknown>): string {
    return template.replace(/\{\{(\w+)\}\}/g, (_, key) => {
      const val = vars[key];
      return val !== undefined ? String(val) : `{{${key}}}`;
    });
  }

  private mapSkillToRole(skill: SkillDefinition): import("../router/model-capability-registry.js").TaskRole {
    switch (skill.outputFormat) {
      case "code":
        return "coding";
      case "markdown":
        return skill.id.includes("review") ? "review" : "research";
      case "json":
        return "general-tool";
      default:
        return "general-chat";
    }
  }
}

// ═══════════════════════════════════════════════════════════════
// 全局实例
// ═══════════════════════════════════════════════════════════════

let globalRegistry: SkillRegistry | null = null;

export function getSkillRegistry(options?: SkillRegistryOptions): SkillRegistry {
  if (!globalRegistry) {
    globalRegistry = new SkillRegistry(options);
  }
  return globalRegistry;
}

export function resetSkillRegistry(): void {
  globalRegistry = null;
}
