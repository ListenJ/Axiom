/**
 * 智能代码检索路由器 (Code Retrieval Router)
 *
 * 结合 CodeGraph 代码分析 + 廉价模型路由决策，实现高效的代码检索策略。
 *
 * 核心流程:
 *   1. analyzeQuery    — 分析用户查询，提取关键符号和意图
 *   2. selectStrategy  — 选择最优检索策略 (symbol/dependency/impact/fulltext)
 *   3. executeRetrieval — 执行检索，聚合结果
 *   4. buildContext    — 构建结构化上下文返回给 Agent
 *
 * 廉价模型用于路由决策 (decision 角色):
 *   - minimax-m25 / minimax-m27 (国内直连)
 *   - deepseek-v3 (推理强)
 *   - siliconflow/Qwen/Qwen2.5-7B-Instruct
 *   - ofx/llama3.1-8b (通过 openrouter)
 */

import { logger } from "../utils/logger.js";
import {
  searchSymbols,
  getCallers,
  getCallees,
  getImpact,
  buildContext,
  type CodeGraphSearchResult,
  type CodeGraphNode,
} from "../memory/codegraph-index.js";
import { router, type ChatMessage } from "./model-router.js";
import { assignModel } from "./model-capability-registry.js";
import { findModelsForRole, type TaskRole } from "./models.js";
import { PiAgentAdapter } from "../pi-agent/pi-agent-adapter.js";

// ═══════════════════════════════════════════════════════════════
// Type Definitions
// ═══════════════════════════════════════════════════════════════

export type RetrievalStrategy =
  | "symbol"       // 基于符号名称精确搜索
  | "dependency"   // 基于调用关系 (callers/callees)
  | "impact"       // 基于影响半径分析
  | "fulltext"     // 全文本搜索 (CodeGraph buildContext)
  | "hybrid"       // 混合策略
  | "pi-agent";    // 使用 Pi Agent 本地工具（零 token 消耗）

export interface QueryAnalysis {
  intent: string;           // 用户意图: "find_definition", "understand_flow", "refactor", etc.
  keywords: string[];       // 提取的关键词
  symbols: string[];        // 检测到的符号名称
  fileHints: string[];      // 文件路径提示
  complexity: "low" | "medium" | "high";  // 查询复杂度
  suggestedStrategy: RetrievalStrategy;
  confidence: number;       // 分析置信度 0-1
}

export interface RetrievalResult {
  strategy: RetrievalStrategy;
  symbols: CodeGraphSearchResult[];
  callers: CodeGraphSearchResult[];
  callees: CodeGraphSearchResult[];
  impact: string;
  context: string;
  metadata: {
    totalNodes: number;
    totalRelationships: number;
    executionTimeMs: number;
    modelUsed?: string;
  };
}

export interface ContextBuildOptions {
  maxTokens?: number;       // 最大 token 限制
  includeCode?: boolean;    // 是否包含代码片段
  format?: "markdown" | "json" | "structured";
  prioritySymbols?: string[]; // 优先包含的符号
}

// ═══════════════════════════════════════════════════════════════
// 路由决策提示词模板
// ═══════════════════════════════════════════════════════════════

const ROUTING_PROMPT = `你是一个代码检索策略路由专家。分析用户的代码查询，输出最优的检索策略。

可用策略:
- symbol: 用户明确提到了函数/类/变量名，需要精确定位定义
- dependency: 用户想了解调用关系、数据流、依赖链
- impact: 用户想修改/重构某个符号，需要了解影响范围
- fulltext: 用户描述的是概念、功能，没有明确符号名
- hybrid: 查询复杂，需要多种策略结合

复杂度评估:
- low: 单一符号查找，简单明确
- medium: 涉及调用关系或少量符号
- high: 跨模块分析、重构影响评估

输出格式 (JSON):
{
  "intent": "find_definition|understand_flow|refactor|debug|explore",
  "keywords": ["关键词列表"],
  "symbols": ["检测到的符号名"],
  "fileHints": ["文件路径提示"],
  "complexity": "low|medium|high",
  "suggestedStrategy": "symbol|dependency|impact|fulltext|hybrid",
  "confidence": 0.95
}`;

// ═══════════════════════════════════════════════════════════════
// CodeRetrievalRouter 主类
// ═══════════════════════════════════════════════════════════════

export class CodeRetrievalRouter {
  private piAgent: PiAgentAdapter;

  constructor(cwd?: string) {
    this.piAgent = new PiAgentAdapter(cwd);
  }

  /**
   * 分析用户查询，确定检索策略
   *
   * 使用廉价 decision 模型做意图识别，避免浪费主力模型 token。
   */
  async analyzeQuery(query: string): Promise<QueryAnalysis> {
    const startTime = Date.now();

    // 1. 先进行轻量级的关键词/符号提取 (正则 + 启发式)
    const heuristic = this.heuristicAnalysis(query);

    // 2. 如果启发式分析置信度高，直接返回
    if (heuristic.confidence > 0.85) {
      logger.info("[CodeRetrieval] Heuristic analysis sufficient", {
        confidence: heuristic.confidence,
        strategy: heuristic.suggestedStrategy,
      });
      return heuristic;
    }

    // 3. 使用廉价模型做 deeper analysis
    try {
      const decisionModel = assignModel("decision");
      if (!decisionModel) {
        logger.warn("[CodeRetrieval] No decision model, using heuristic");
        return heuristic;
      }

      const messages: ChatMessage[] = [
        { role: "system", content: ROUTING_PROMPT },
        { role: "user", content: `分析以下代码查询:\n\n${query}` },
      ];

      const response = await router.executeWithRole("decision", messages, {
        temperature: 0.3,
        maxTokens: 500,
      });

      const parsed = this.parseRoutingResponse(response.content);
      if (parsed) {
        logger.info("[CodeRetrieval] Model-based routing", {
          strategy: parsed.suggestedStrategy,
          confidence: parsed.confidence,
          latency: Date.now() - startTime,
        });
        return { ...parsed, confidence: Math.min(parsed.confidence, 0.95) };
      }
    } catch (error) {
      logger.warn("[CodeRetrieval] Model routing failed, fallback to heuristic", {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    return heuristic;
  }

  /**
   * 选择并执行最优检索策略
   */
  async selectStrategy(analysis: QueryAnalysis): Promise<RetrievalStrategy> {
    // 基于分析结果选择策略，考虑复杂度
    if (analysis.complexity === "high" || analysis.symbols.length > 3) {
      return "hybrid";
    }
    if (analysis.symbols.length === 1 && analysis.intent === "find_definition") {
      return "symbol";
    }
    if (analysis.intent === "understand_flow" || analysis.intent === "debug") {
      return "dependency";
    }
    if (analysis.intent === "refactor") {
      return "impact";
    }
    if (analysis.symbols.length === 0) {
      return "fulltext";
    }
    return analysis.suggestedStrategy;
  }

  /**
   * 执行代码检索
   *
   * 根据策略选择不同的检索路径，支持并行执行和结果聚合。
   */
  async executeRetrieval(
    query: string,
    analysis: QueryAnalysis,
    strategy: RetrievalStrategy
  ): Promise<RetrievalResult> {
    const startTime = Date.now();
    const result: RetrievalResult = {
      strategy,
      symbols: [],
      callers: [],
      callees: [],
      impact: "",
      context: "",
      metadata: {
        totalNodes: 0,
        totalRelationships: 0,
        executionTimeMs: 0,
      },
    };

    try {
      switch (strategy) {
        case "symbol":
          await this.executeSymbolStrategy(analysis, result);
          break;
        case "dependency":
          await this.executeDependencyStrategy(analysis, result);
          break;
        case "impact":
          await this.executeImpactStrategy(analysis, result);
          break;
        case "fulltext":
          await this.executeFulltextStrategy(query, result);
          break;
        case "hybrid":
          await this.executeHybridStrategy(query, analysis, result);
          break;
        case "pi-agent":
          await this.executePiAgentStrategy(query, result);
          break;
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      logger.error(`[CodeRetrieval] Strategy ${strategy} execution failed: ${errMsg}`);
    }

    result.metadata.executionTimeMs = Date.now() - startTime;
    logger.info("[CodeRetrieval] Retrieval completed", {
      strategy,
      nodes: result.metadata.totalNodes,
      relationships: result.metadata.totalRelationships,
      timeMs: result.metadata.executionTimeMs,
    });

    return result;
  }

  /**
   * 构建最终上下文
   *
   * 将检索结果格式化为 Agent 可用的上下文字符串。
   */
  async buildContext(
    result: RetrievalResult,
    options: ContextBuildOptions = {}
  ): Promise<string> {
    const { format = "markdown", maxTokens = 8000, includeCode = true } = options;

    if (format === "json") {
      return JSON.stringify({
        strategy: result.strategy,
        symbols: result.symbols.map((s) => ({
          name: s.node.name,
          kind: s.node.kind,
          file: s.node.filePath,
          line: s.node.startLine,
        })),
        callers: result.callers.map((c) => c.node.name),
        callees: result.callees.map((c) => c.node.name),
        impact: result.impact,
        context: result.context,
      }, null, 2);
    }

    // Markdown 格式 (默认)
    const sections: string[] = [];

    // 1. 检索策略说明
    sections.push(`## Code Retrieval Result (${result.strategy})\n`);

    // 2. 符号定义
    if (result.symbols.length > 0) {
      sections.push("### Symbols Found\n");
      for (const s of result.symbols.slice(0, 10)) {
        sections.push(
          `- **${s.node.name}** (${s.node.kind}) — \`${s.node.filePath}:${s.node.startLine}\``
        );
      }
      sections.push("");
    }

    // 3. 调用关系
    if (result.callers.length > 0 || result.callees.length > 0) {
      sections.push("### Call Relationships\n");
      if (result.callers.length > 0) {
        sections.push(`**Callers:** ${result.callers.slice(0, 5).map((c) => c.node.name).join(", ")}`);
      }
      if (result.callees.length > 0) {
        sections.push(`**Callees:** ${result.callees.slice(0, 5).map((c) => c.node.name).join(", ")}`);
      }
      sections.push("");
    }

    // 4. 影响分析
    if (result.impact) {
      sections.push("### Impact Analysis\n");
      sections.push(result.impact.slice(0, 2000));
      sections.push("");
    }

    // 5. 代码上下文
    if (includeCode && result.context) {
      sections.push("### Code Context\n");
      sections.push("```");
      sections.push(result.context.slice(0, maxTokens * 2)); // 粗略字符限制
      sections.push("```");
    }

    // 6. 元数据
    sections.push("\n---");
    sections.push(
      `*Retrieved ${result.metadata.totalNodes} nodes, ${result.metadata.totalRelationships} relationships in ${result.metadata.executionTimeMs}ms*`
    );

    return sections.join("\n");
  }

  // ═══════════════════════════════════════════════════════════════
  // 策略执行实现
  // ═══════════════════════════════════════════════════════════════

  private async executeSymbolStrategy(
    analysis: QueryAnalysis,
    result: RetrievalResult
  ): Promise<void> {
    // 并行搜索所有检测到的符号
      const searches = analysis.symbols.map((sym: string) =>
      searchSymbols(sym, { limit: 5 }).then((res: CodeGraphSearchResult[]) => ({ sym, res }))
    );

    const searchResults = await Promise.all(searches);
    for (const { res } of searchResults) {
      result.symbols.push(...res);
    }

    result.metadata.totalNodes = result.symbols.length;
  }

  private async executeDependencyStrategy(
    analysis: QueryAnalysis,
    result: RetrievalResult
  ): Promise<void> {
    // 先搜索符号
    await this.executeSymbolStrategy(analysis, result);

    // 再获取调用关系
    const primarySymbol = result.symbols[0]?.node.name;
    if (primarySymbol) {
      const [callers, callees] = await Promise.all([
        getCallers(primarySymbol, { limit: 10 }),
        getCallees(primarySymbol, { limit: 10 }),
      ]);
      result.callers = callers;
      result.callees = callees;
    }

    result.metadata.totalNodes = result.symbols.length + result.callers.length + result.callees.length;
    result.metadata.totalRelationships = result.callers.length + result.callees.length;
  }

  private async executeImpactStrategy(
    analysis: QueryAnalysis,
    result: RetrievalResult
  ): Promise<void> {
    // 获取符号和影响分析
    await this.executeSymbolStrategy(analysis, result);

    const primarySymbol = result.symbols[0]?.node.name;
    if (primarySymbol) {
      const [callers, callees, impact] = await Promise.all([
        getCallers(primarySymbol, { limit: 10 }),
        getCallees(primarySymbol, { limit: 10 }),
        getImpact(primarySymbol, { depth: 2 }),
      ]);
      result.callers = callers;
      result.callees = callees;
      result.impact = impact;
    }

    result.metadata.totalNodes = result.symbols.length + result.callers.length + result.callees.length;
    result.metadata.totalRelationships = result.callers.length + result.callees.length;
  }

  private async executeFulltextStrategy(query: string, result: RetrievalResult): Promise<void> {
    const context = await buildContext(query, {
      maxNodes: 15,
      includeCode: true,
      format: "markdown",
    });

    result.context = context;
    result.metadata.totalNodes = 15; // 估算
  }

  private async executeHybridStrategy(
    query: string,
    analysis: QueryAnalysis,
    result: RetrievalResult
  ): Promise<void> {
    // 混合策略：并行执行 symbol + fulltext，然后合并
    const [symbolRes, fulltextRes] = await Promise.all([
      this.executeSymbolStrategyWithResults(analysis),
      buildContext(query, { maxNodes: 10, includeCode: true, format: "markdown" }),
    ]);

    result.symbols = symbolRes.symbols;
    result.callers = symbolRes.callers;
    result.callees = symbolRes.callees;
    result.context = fulltextRes;

    result.metadata.totalNodes = result.symbols.length + result.callers.length + result.callees.length;
    result.metadata.totalRelationships = result.callers.length + result.callees.length;
  }

  private async executePiAgentStrategy(
    query: string,
    result: RetrievalResult
  ): Promise<void> {
    // 使用 Pi Agent 本地工具执行检索（零 token 消耗）
    const piResult = await this.piAgent.retrieveCodeContext(query);

    if (piResult.success) {
      result.context = piResult.content;
      result.metadata.totalNodes = 1; // Pi Agent 返回聚合结果
      result.metadata.modelUsed = `pi-agent:${piResult.toolUsed}`;

      logger.info("[CodeRetrieval] Pi Agent retrieval completed", {
        toolUsed: piResult.toolUsed,
        executionTime: piResult.executionTimeMs,
        tokenSaved: piResult.tokenSaved,
      });
    } else {
      // Pi Agent 失败，回退到 fulltext
      logger.warn("[CodeRetrieval] Pi Agent failed, falling back to fulltext", {
        error: piResult.error,
      });
      await this.executeFulltextStrategy(query, result);
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // 辅助方法
  // ═══════════════════════════════════════════════════════════════

  private heuristicAnalysis(query: string): QueryAnalysis {
    const lower = query.toLowerCase();

    // 提取潜在符号名 (CamelCase, snake_case, PascalCase)
    const symbolPattern = /\b([A-Z][a-zA-Z0-9]*|[a-z_][a-z0-9_]*|[A-Z][A-Z0-9_]*)\b/g;
    const potentialSymbols = [...query.matchAll(symbolPattern)]
      .map((m) => m[1])
      .filter((s) => s.length > 2 && !this.isCommonWord(s));

    // 提取文件路径提示
    const filePattern = /[\w\/\\.-]+\.(ts|tsx|js|jsx|mjs|cjs|py|rs|go)\b/g;
    const fileHints = [...query.matchAll(filePattern)].map((m) => m[0]);

    // 意图检测
    let intent = "explore";
    if (/\b(defin|find|where|locate|look)\b/.test(lower)) intent = "find_definition";
    else if (/\b(call|use|invoke|depend|flow)\b/.test(lower)) intent = "understand_flow";
    else if (/\b(refactor|chang|modif|updat|renam)\b/.test(lower)) intent = "refactor";
    else if (/\b(bug|error|fix|debug|issue)\b/.test(lower)) intent = "debug";

    // 复杂度评估
    let complexity: "low" | "medium" | "high" = "low";
    if (potentialSymbols.length > 3 || fileHints.length > 2) complexity = "high";
    else if (potentialSymbols.length > 1 || intent === "refactor") complexity = "medium";

    // 策略选择
    let suggestedStrategy: RetrievalStrategy = "fulltext";
    if (potentialSymbols.length === 1 && complexity === "low") suggestedStrategy = "symbol";
    else if (intent === "understand_flow" || intent === "debug") suggestedStrategy = "dependency";
    else if (intent === "refactor") suggestedStrategy = "impact";
    else if (complexity === "high") suggestedStrategy = "hybrid";

    // 置信度：符号越多越不确定
    const confidence = Math.max(0.5, 1 - potentialSymbols.length * 0.1);

    return {
      intent,
      keywords: this.extractKeywords(query),
      symbols: [...new Set(potentialSymbols)],
      fileHints: [...new Set(fileHints)],
      complexity,
      suggestedStrategy,
      confidence,
    };
  }

  private isCommonWord(word: string): boolean {
    const common = new Set([
      "the", "and", "for", "are", "but", "not", "you", "all", "can", "had", "her", "was", "one", "our",
      "out", "day", "get", "has", "him", "his", "how", "its", "may", "new", "now", "old", "see", "two",
      "who", "boy", "did", "she", "use", "her", "way", "many", "oil", "sit", "set", "run", "eat", "far",
      "sea", "eye", "ago", "off", "too", "any", "say", "man", "try", "ask", "end", "why", "let", "put",
      "say", "she", "try", "way", "own", "say", "too", "old", "tell", "very", "when", "much", "would",
      "there", "their", "what", "said", "each", "which", "will", "about", "if", "up", "out", "many",
      "then", "them", "these", "could", "other", "after", "first", "well", "water", "been", "call",
      "who", "now", "find", "long", "down", "day", "did", "get", "come", "made", "may", "part",
      "this", "that", "with", "have", "from", "they", "know", "want", "been", "good", "much", "some",
      "time", "very", "when", "come", "here", "just", "like", "long", "make", "over", "such", "take",
      "than", "them", "well", "were",
    ]);
    return common.has(word.toLowerCase());
  }

  private extractKeywords(query: string): string[] {
    // 简单的关键词提取：去除停用词后的名词/动词
    const words = query.toLowerCase().split(/\s+/);
    return words.filter((w) => w.length > 3 && !this.isCommonWord(w));
  }

  private parseRoutingResponse(content: string | null): QueryAnalysis | null {
    if (!content) return null;

    try {
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return null;

      const parsed = JSON.parse(jsonMatch[0]);
      return {
        intent: parsed.intent || "explore",
        keywords: parsed.keywords || [],
        symbols: parsed.symbols || [],
        fileHints: parsed.fileHints || [],
        complexity: parsed.complexity || "medium",
        suggestedStrategy: parsed.suggestedStrategy || "fulltext",
        confidence: typeof parsed.confidence === "number" ? parsed.confidence : 0.7,
      };
    } catch {
      return null;
    }
  }

  private async executeSymbolStrategyWithResults(
    analysis: QueryAnalysis
  ): Promise<{ symbols: CodeGraphSearchResult[]; callers: CodeGraphSearchResult[]; callees: CodeGraphSearchResult[] }> {
    const result: RetrievalResult = {
      strategy: "symbol",
      symbols: [],
      callers: [],
      callees: [],
      impact: "",
      context: "",
      metadata: { totalNodes: 0, totalRelationships: 0, executionTimeMs: 0 },
    };

    await this.executeDependencyStrategy(analysis, result);

    return {
      symbols: result.symbols,
      callers: result.callers,
      callees: result.callees,
    };
  }
}

export const codeRetrievalRouter = new CodeRetrievalRouter();
