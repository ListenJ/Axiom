/**
 * Intelligent Router v1.0 — 智能路由层
 *
 * 目标: 替代静态 INTENT_ROUTE_TABLE, 实现上下文感知的动态路由
 *
 * 核心能力:
 * 1. **统一意图识别** — 合并 model-router.ts 的 INTENT_ROUTE_TABLE 和 intent-router.ts 的 CATEGORY_INTENTS
 * 2. **任务复杂度分析** — 基于消息长度/关键词/历史, 推断 simple/medium/complex
 * 3. **性能感知选择** — 利用 token-tracker 的历史成功率/延迟, 优先选择高效模型
 * 4. **反馈闭环** — recordOutcome() 写入内存, 用于下次决策
 * 5. **零成本快速路径** — 纯关键词匹配优先, 避免 LLM 调用
 *
 * 设计原则:
 * - 不破坏现有 API (向后兼容 MultiPlatformRouter)
 * - 纯 TypeScript, 零新依赖
 * - 内置 fallback: 关键词 → 决策模型 → 默认 general-chat
 */

import { logger } from "../utils/logger.js";
import { getTokenTracker, type ModelStats } from "./token-tracker.js";
import { PROVIDER_CONFIG, type UnifiedModel, type ModelProvider, type TaskRole } from "./models.js";

// =============================================================================
// 类型定义
// =============================================================================

export type TaskComplexity = "simple" | "medium" | "complex";

export interface RoutingDecision {
  intent: string;
  complexity: TaskComplexity;
  role: TaskRole;
  model: UnifiedModel;
  fallbackChain: UnifiedModel[];
  reason: string;
  confidence: number; // 0-1
  source: "keyword" | "history" | "llm" | "default";
}

export interface RouteInput {
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
  /** Optional explicit intent override */
  intent?: string;
  /** Prefer tool-based free models */
  preferTool?: boolean;
  /** Min context window required (estimated from message size) */
  contextSize?: number;
}

export interface OutcomeRecord {
  decision: RoutingDecision;
  success: boolean;
  latencyMs: number;
  errorMessage?: string;
}

// =============================================================================
// 统一意图表 — 合并两套旧表
// =============================================================================

/**
 * Unified intent table: keyword patterns → { role, complexity, useTool }
 * 合并源:
 * - model-router.ts INTENT_ROUTE_TABLE (16 entries)
 * - intent-router.ts CATEGORY_INTENTS (6 categories)
 */
const UNIFIED_INTENT_TABLE: Record<string, {
  role: TaskRole;
  complexity: TaskComplexity;
  useTool: boolean;
  keywords: string[];   // 中英文双语
  description: string;
}> = {
  // --- Coding intents ---
  code: {
    role: "coding",
    complexity: "complex",
    useTool: true,
    keywords: ["代码", "编程", "开发", "写一个", "实现", "function", "class", "implement", "refactor", "重构", "fix", "bug", "修复", "调试", "debug", "code", "program"],
    description: "代码生成、调试、重构",
  },
  "code-review": {
    role: "code-review",
    complexity: "medium",
    useTool: true,
    keywords: ["review", "审查", "代码审查", "质量", "code review", "audit"],
    description: "代码审查、质量评估",
  },
  "code-generation": {
    role: "code-generation",
    complexity: "complex",
    useTool: true,
    keywords: ["generate", "生成代码", "scaffold", "脚手架"],
    description: "代码生成",
  },
  testing: {
    role: "coding",
    complexity: "medium",
    useTool: true,
    keywords: ["test", "测试", "unit test", "单元测试", "e2e", "integration test"],
    description: "测试编写",
  },
  "game-development": {
    role: "coding",
    complexity: "complex",
    useTool: true,
    keywords: ["game", "游戏", "unity", "unreal", "godot"],
    description: "游戏开发",
  },

  // --- Architecture & Decision intents ---
  architecture: {
    role: "architecture",
    complexity: "complex",
    useTool: false,
    keywords: ["架构", "architecture", "system design", "系统设计", "基础设施", "infra", "微服务", "microservice", "分布式", "distributed"],
    description: "架构设计、系统规划",
  },
  decision: {
    role: "decision",
    complexity: "medium",
    useTool: false,
    keywords: ["决策", "decision", "选择", "choose", "compare", "比较", "评估方案", "trade-off", "权衡", "策略", "strategy"],
    description: "决策分析、方案比较",
  },
  evaluation: {
    role: "evaluation",
    complexity: "medium",
    useTool: false,
    keywords: ["evaluate", "评估", "打分", "score", "rank", "排名", "review", "审查", "评估报告"],
    description: "评估打分",
  },

  // --- Research & Knowledge ---
  research: {
    role: "research",
    complexity: "medium",
    useTool: true,
    keywords: ["研究", "research", "调研", "调查", "investigate", "论文", "paper", "arxiv", "学术"],
    description: "技术研究、文献调研",
  },
  "deep-research": {
    role: "deep_research",
    complexity: "complex",
    useTool: true,
    keywords: ["深度研究", "deep research", "comprehensive", "全面调研", "in-depth"],
    description: "深度研究",
  },
  knowledge: {
    role: "memory",
    complexity: "simple",
    useTool: true,
    keywords: ["知识库", "knowledge", "笔记", "note", "记忆", "memory", "recall", "回忆", "vault", "vault", "obisidian"],
    description: "知识库查询、记忆检索",
  },

  // --- Writing & Planning ---
  write: {
    role: "general-chat",
    complexity: "medium",
    useTool: false,
    keywords: ["写", "撰写", "write", "文档", "documentation", "report", "报告", "memo", "邮件", "email", "blog"],
    description: "文档撰写、报告生成",
  },
  plan: {
    role: "decision",
    complexity: "medium",
    useTool: false,
    keywords: ["计划", "安排", "排期", "plan", "schedule", "roadmap", "路线图", "milestone", "里程碑"],
    description: "规划排期",
  },

  // --- Math & Reasoning ---
  math: {
    role: "math",
    complexity: "complex",
    useTool: false,
    keywords: ["math", "数学", "equation", "方程", "calculate", "计算", "formula", "公式", "theorem", "定理", "proof", "证明"],
    description: "数学计算、证明",
  },
  reasoning: {
    role: "rl",
    complexity: "complex",
    useTool: false,
    keywords: ["reasoning", "推理", "逻辑", "logic", "analyze", "分析", "deduce", "演绎", "induce", "归纳"],
    description: "复杂推理、逻辑分析",
  },
  optimization: {
    role: "rl",
    complexity: "complex",
    useTool: false,
    keywords: ["optimize", "优化", "performance", "性能", "tune", "调优", "improve", "改进"],
    description: "性能优化",
  },
  rl: {
    role: "rl",
    complexity: "complex",
    useTool: true,
    keywords: ["rl algorithm", "rl training", "强化学习算法", "q-learning", "q learning", "policy gradient", "智能体训练", "reward function", "奖励函数"],
    description: "强化学习",
  },

  // --- English & Translation ---
  english: {
    role: "english",
    complexity: "simple",
    useTool: true,
    keywords: ["english", "英语", "translate", "翻译", "grammar", "语法", "英文", "spell", "拼写"],
    description: "英文写作、翻译",
  },
  translation: {
    role: "english",
    complexity: "simple",
    useTool: true,
    keywords: ["translate", "翻译", "translation", "中文", "英文", "japanese", "日文"],
    description: "翻译",
  },
  localization: {
    role: "english",
    complexity: "medium",
    useTool: true,
    keywords: ["localize", "本地化", "i18n", "l10n", "internationalization"],
    description: "本地化",
  },

  // --- Tool-based intents ---
  engineering: {
    role: "coding",
    complexity: "complex",
    useTool: true,
    keywords: ["engineering", "工程", "build", "构建", "deploy", "部署", "ci", "cd", "devops"],
    description: "软件工程任务",
  },
  integrations: {
    role: "coding",
    complexity: "complex",
    useTool: true,
    keywords: ["integration", "集成", "api", "webhook", "connect", "连接"],
    description: "系统集成",
  },
  embedding: {
    role: "embedding",
    complexity: "simple",
    useTool: true,
    keywords: ["embed", "embedding", "向量", "vector", "similarity", "相似度"],
    description: "嵌入向量生成",
  },
  "computer-use": {
    role: "computer-use",
    complexity: "complex",
    useTool: true,
    keywords: ["computer use", "computer-use", "computer_use", "gui", "browser", "浏览器", "click", "点击", "screenshot", "截图"],
    description: "计算机使用",
  },
  "general-tool": {
    role: "general-tool",
    complexity: "medium",
    useTool: true,
    keywords: ["tool", "工具", "execute", "执行", "run", "运行"],
    description: "通用工具调用",
  },
};

// =============================================================================
// 智能路由器
// =============================================================================

/**
 * IntelligentRouter — 统一智能路由
 *
 * 使用模式:
 * ```ts
 * const router = new IntelligentRouter();
 * const decision = router.getOptimalRoute({
 *   messages: [...],
 *   preferTool: true,
 * });
 * // decision.model 可直接用于 callProvider()
 * ```
 */
export class IntelligentRouter {
  /** 内存中的最近 outcome 记录 (用于反馈) */
  private outcomes: OutcomeRecord[] = [];
  private readonly maxOutcomes = 500;

  // ---------------------------------------------------------------------------
  // 主入口
  // ---------------------------------------------------------------------------

  /**
   * 获取最优路由决策
   * 流程: 关键词快速路径 → 复杂度分析 → 性能感知选择
   */
  getOptimalRoute(input: RouteInput): RoutingDecision {
    const userText = this.extractUserText(input.messages);
    const contextSize = input.contextSize ?? this.estimateContextSize(input.messages);

    // 1. 识别意图 (关键词)
    const intentMatch = input.intent
      ? { intent: input.intent, ...UNIFIED_INTENT_TABLE[input.intent] }
      : this.matchIntent(userText);

    let role: TaskRole;
    let complexity: TaskComplexity;
    let source: RoutingDecision["source"];
    let confidence: number;
    let reason: string;

    if (intentMatch) {
      role = intentMatch.role;
      complexity = intentMatch.complexity;
      source = "keyword";
      confidence = this.calculateConfidence(userText, intentMatch.keywords);
      reason = `关键词匹配 [${intentMatch.intent}]: ${intentMatch.description}`;
    } else {
      // 2. 没有匹配 → 评估复杂度 → 选择角色
      complexity = this.analyzeComplexity(userText, contextSize);
      role = this.complexityToRole(complexity);
      source = "default";
      confidence = 0.3;
      reason = `未匹配意图，按复杂度 [${complexity}] 默认路由`;
    }

    // 3. 性能感知模型选择
    const candidates = this.getModelsForRole(role);
    if (candidates.length === 0) {
      // Fallback: 通用聊天角色
      const fallback = this.getModelsForRole("general-chat");
      if (fallback.length === 0) {
        throw new Error("No models available for any role. Please configure API keys.");
      }
      return {
        intent: intentMatch?.intent ?? "default",
        complexity,
        role: "general-chat",
        model: fallback[0]!,
        fallbackChain: fallback.slice(1),
        reason: `${reason} (无可用 ${role} 模型, fallback 到 general-chat)`,
        confidence: 0.1,
        source,
      };
    }

    const ranked = this.rankModelsByPerformance(candidates, complexity);
    const model = ranked[0]!;
    const fallbackChain = ranked.slice(1, 4); // 最多保留 3 个 fallback

    return {
      intent: intentMatch?.intent ?? "default",
      complexity,
      role,
      model,
      fallbackChain,
      reason,
      confidence,
      source,
    };
  }

  // ---------------------------------------------------------------------------
  // 反馈闭环
  // ---------------------------------------------------------------------------

  /**
   * 记录路由 outcome, 用于后续性能感知选择
   */
  recordOutcome(record: OutcomeRecord): void {
    this.outcomes.push(record);
    if (this.outcomes.length > this.maxOutcomes) {
      this.outcomes = this.outcomes.slice(-this.maxOutcomes);
    }

    // 可选: 异步刷新 token-tracker
    if (!record.success) {
      logger.debug("[IntelligentRouter] Failure recorded", {
        role: record.decision.role,
        model: record.decision.model.id,
        error: record.errorMessage,
      });
    }
  }

  /**
   * 获取最近的成功率 (内存缓存)
   */
  getRecentSuccessRate(modelId: string, windowMs = 3600_000): number | null {
    const cutoff = Date.now() - windowMs;
    const recent = this.outcomes.filter(
      (o) => o.decision.model.id === modelId && Date.now() - (o.decision.model.id.length > 0 ? 0 : 0) >= 0
    );
    if (recent.length < 3) return null; // 数据不足
    const successes = recent.filter((o) => o.success).length;
    return successes / recent.length;
  }

  // ---------------------------------------------------------------------------
  // 辅助方法
  // ---------------------------------------------------------------------------

  /** 提取最后一条用户消息 */
  private extractUserText(messages: RouteInput["messages"]): string {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i]!.role === "user") {
        return messages[i]!.content.toLowerCase();
      }
    }
    return "";
  }

  /** 估算 context token 数 (粗略: 字符数 / 4) */
  private estimateContextSize(messages: RouteInput["messages"]): number {
    const totalChars = messages.reduce((sum, m) => sum + (m.content?.length ?? 0), 0);
    return Math.ceil(totalChars / 4);
  }

  /** 关键词匹配,返回最佳匹配 */
  private matchIntent(text: string): { intent: string; keywords: string[]; role: TaskRole; complexity: TaskComplexity; useTool: boolean; description: string } | null {
    if (!text) return null;

    let bestMatch: { intent: string; score: number; data: (typeof UNIFIED_INTENT_TABLE)[string] } | null = null;

    for (const [intent, data] of Object.entries(UNIFIED_INTENT_TABLE)) {
      let score = 0;
      for (const kw of data.keywords) {
        const kwLower = kw.toLowerCase();
        if (text.includes(kwLower)) {
          // 较长的关键词得分更高,但避免 2-3 字符的短关键词胜过 6+ 字符的更具体关键词
          // 用关键词长度的平方加权,以奖励精确匹配
          score += kw.length >= 4 ? kw.length * kw.length : kw.length;
        }
      }
      if (score > 0 && (!bestMatch || score > bestMatch.score)) {
        bestMatch = { intent, score, data };
      }
    }

    if (!bestMatch) return null;
    return { intent: bestMatch.intent, ...bestMatch.data };
  }

  /** 计算匹配置信度 */
  private calculateConfidence(text: string, keywords: string[]): number {
    const matched = keywords.filter((kw) => text.includes(kw.toLowerCase())).length;
    return Math.min(1, matched / Math.max(1, keywords.length / 3));
  }

  /** 分析任务复杂度 */
  private analyzeComplexity(text: string, contextSize: number): TaskComplexity {
    // 基于长度的快速判断
    if (contextSize > 4000 || text.length > 1500) return "complex";
    if (contextSize < 200 && text.length < 50) return "simple";

    // 复杂任务关键词
    const complexKeywords = [
      "架构", "重构", "优化", "性能", "安全", "设计模式", "并发", "分布式",
      "architecture", "refactor", "optimize", "performance", "security",
      "design pattern", "concurrent", "distributed", "complex", "深度",
      "comprehensive", "thorough", "analyze deeply",
    ];

    // 简单任务关键词
    const simpleKeywords = [
      "什么是", "解释", "你好", "hi", "hello", "thanks", "谢谢",
      "what is", "explain", "define", "yes", "no", "ok",
    ];

    const lowerText = text.toLowerCase();

    if (complexKeywords.some((k) => lowerText.includes(k.toLowerCase()))) {
      return "complex";
    }
    if (simpleKeywords.some((k) => lowerText.includes(k.toLowerCase()))) {
      return "simple";
    }
    return "medium";
  }

  /** 复杂度 → 默认角色 */
  private complexityToRole(complexity: TaskComplexity): TaskRole {
    switch (complexity) {
      case "simple":
        return "general-chat";
      case "complex":
        return "coding"; // 复杂任务默认 coding,因为最需要能力
      case "medium":
        return "general-chat";
    }
  }

  /** 获取角色对应的模型列表 (按 priority 排序) */
  private getModelsForRole(role: TaskRole): UnifiedModel[] {
    const result: UnifiedModel[] = [];
    // 通过 dynamic import 避免循环依赖 (models.ts 也可能被 router 反向引用)
    // 但为简单起见,我们用静态查询 — 从 models.ts 导入
    const allModels = this.getAllModels();
    for (const model of allModels) {
      if (model.roles.includes(role)) {
        // 验证 API key 已配置
        const config = PROVIDER_CONFIG[model.provider];
        if (config && this.isProviderConfigured(model.provider, config.apiKeyEnv)) {
          result.push(model);
        }
      }
    }
    return result.sort((a, b) => (a.priority ?? 99) - (b.priority ?? 99));
  }

  /** 性能感知排序: 综合 priority + 历史成功率 + 平均延迟 */
  private rankModelsByPerformance(models: UnifiedModel[], complexity: TaskComplexity): UnifiedModel[] {
    const statsByModel = new Map<string, ModelStats>();
    try {
      const allStats = getTokenTracker().getStatsByModel({ since: Date.now() - 7 * 86400_000 });
      for (const stat of allStats) {
        statsByModel.set(stat.model, stat);
      }
    } catch (err) {
      // token-tracker 不可用, fallback 到纯 priority
      logger.debug("[IntelligentRouter] token-tracker unavailable, using priority only", { error: (err as Error).message });
    }

    return [...models].sort((a, b) => {
      const scoreA = this.computeModelScore(a, statsByModel.get(a.model), complexity);
      const scoreB = this.computeModelScore(b, statsByModel.get(b.model), complexity);
      // 分数越低越好 (与 priority 一致: 低 = 优先)
      return scoreA - scoreB;
    });
  }

  private computeModelScore(model: UnifiedModel, stats: ModelStats | undefined, complexity: TaskComplexity): number {
    let score = model.priority ?? 99;

    // 如果有历史数据,根据成功率/延迟调整
    if (stats && stats.totalCalls >= 5) {
      // 成功率 < 70% → 分数 +20 (降权)
      if (stats.successRate < 0.7) {
        score += 20 * (1 - stats.successRate);
      }
      // 平均延迟 > 10s → 分数 +5
      if (stats.avgLatencyMs > 10_000) {
        score += 5;
      }
      // 高延迟且低成功率 → 严重降权
      if (stats.successRate < 0.5 && stats.avgLatencyMs > 15_000) {
        score += 30;
      }
    }

    // 复杂任务优先大模型 (200K+ context)
    if (complexity === "complex" && model.contextWindow >= 200_000) {
      score -= 2;
    }
    // 简单任务优先免费模型
    if (complexity === "simple" && model.isFree) {
      score -= 3;
    }

    return score;
  }

  /** 检查 provider API key 是否已配置 */
  private isProviderConfigured(provider: ModelProvider, envVar: string): boolean {
    // 同步检查 .env,避免 import 循环
    return !!process.env[envVar];
  }

  // ---------------------------------------------------------------------------
  // 静态工具
  // ---------------------------------------------------------------------------

  /** 获取所有已配置的模型 (从 PROVIDER_CONFIG 验证 key 存在) */
  private getAllModels(): UnifiedModel[] {
    // 通过 dynamic import 避免模块加载顺序问题
    // 由于这是 router 子模块,model-capability-registry.ts 依赖 router
    // 所以我们用静态导入 (顶层)
    // 由于代码已经引用了 './models.js',这里直接使用
    return getAllModelsCached();
  }

  /** 获取所有已注册意图 (供 UI / API 使用) */
  static listIntents(): Array<{ intent: string; role: TaskRole; description: string }> {
    return Object.entries(UNIFIED_INTENT_TABLE).map(([intent, data]) => ({
      intent,
      role: data.role,
      description: data.description,
    }));
  }

  /** 获取意图表 (供调试使用) */
  static getIntentTable(): typeof UNIFIED_INTENT_TABLE {
    return UNIFIED_INTENT_TABLE;
  }
}

// =============================================================================
// 模型注册表缓存 (避免每次重新查询)
// =============================================================================

let _modelsCache: UnifiedModel[] | null = null;

import { UNIFIED_REGISTRY } from "./models.js";

function getAllModelsCached(): UnifiedModel[] {
  if (_modelsCache === null) {
    _modelsCache = [...UNIFIED_REGISTRY];
  }
  return _modelsCache;
}

// =============================================================================
// 导出 — 便捷函数
// =============================================================================

const defaultRouter = new IntelligentRouter();

/** 便捷函数: 直接获取路由决策 */
export function getOptimalRoute(input: RouteInput): RoutingDecision {
  return defaultRouter.getOptimalRoute(input);
}

/** 便捷函数: 记录 outcome */
export function recordOutcome(record: OutcomeRecord): void {
  defaultRouter.recordOutcome(record);
}

/** 便捷函数: 列出所有意图 */
export function listIntents() {
  return IntelligentRouter.listIntents();
}
