/**
 * MCP Direct Tool Calling Module
 * 
 * Enables direct tool invocation without LLM routing when requirements are clear.
 * Implements "条件触发" (conditional triggering) pattern:
 * - Intent classification with confidence threshold
 * - Direct tool execution for high-confidence matches
 * - LLM fallback for low-confidence or ambiguous requests
 * 
 * Philosophy: MCP tools should be callable directly when the intent is unambiguous.
 * LLM is only needed for complex reasoning, not simple tool dispatch.
 */

import { ToolRegistry, ToolDef } from "../mcp/tool-registry.js";
import { logger } from "../utils/logger.js";

/** Intent classification result */
export interface IntentClassification {
  intent: string;
  confidence: number;  // 0.0 - 1.0
  tool: string;
  args: Record<string, unknown>;
  reasoning: string;
}

/** Direct tool call result */
export interface DirectToolResult {
  success: boolean;
  tool: string;
  result: unknown;
  latencyMs: number;
  fallbackNeeded: boolean;  // Whether LLM fallback is needed
}

/** Intent pattern for direct matching */
export interface IntentPattern {
  /** Unique intent identifier */
  id: string;
  /** Tool to invoke when matched */
  tool: string;
  /** Required keywords (ALL must match) */
  requiredKeywords: string[];
  /** Optional keywords (boost confidence) */
  optionalKeywords?: string[];
  /** Minimum confidence threshold (0.0 - 1.0) */
  minConfidence: number;
  /** Argument extraction rules */
  argExtractors?: Array<{
    param: string;
    /** Regex or position-based extractor */
    pattern: RegExp | ((text: string) => string | undefined);
  }>;
  /** Whether this intent requires LLM confirmation */
  requireConfirmation?: boolean;
}

/**
 * Direct Tool Caller - Fast path for unambiguous tool invocations
 * 
 * Bypasses LLM routing when intent is clear:
 * - "打开文件 x.txt" → filesystem.read_file (confidence: 0.95)
 * - "搜索 Git 历史" → git.log (confidence: 0.88)
 * - "分析代码复杂度" → code_analysis.complexity (confidence: 0.82)
 */
export class DirectToolCaller {
  private patterns: IntentPattern[] = [];
  private registry: ToolRegistry;
  private confidenceThreshold = 0.75;

  constructor(registry: ToolRegistry, options?: { confidenceThreshold?: number }) {
    this.registry = registry;
    if (options?.confidenceThreshold !== undefined) {
      this.confidenceThreshold = options.confidenceThreshold;
    }
  }

  /** Register an intent pattern for direct matching */
  registerPattern(pattern: IntentPattern): void {
    this.patterns.push(pattern);
    logger.info(`[DirectTool] Registered pattern: ${pattern.id} → ${pattern.tool}`);
  }

  /** Register multiple patterns at once */
  registerPatterns(patterns: IntentPattern[]): void {
    for (const p of patterns) this.registerPattern(p);
  }

  /**
   * Classify user intent from natural language request.
   * Returns best match or null if no clear intent detected.
   */
  classifyIntent(request: string): IntentClassification | null {
    const normalized = request.toLowerCase().trim();
    let bestMatch: IntentClassification | null = null;
    let bestScore = 0;

    for (const pattern of this.patterns) {
      const score = this.calculateMatchScore(normalized, pattern);
      if (score >= pattern.minConfidence && score > bestScore) {
        bestScore = score;
        const args = this.extractArgs(normalized, pattern);
        bestMatch = {
          intent: pattern.id,
          confidence: score,
          tool: pattern.tool,
          args,
          reasoning: `Matched keywords: ${pattern.requiredKeywords.join(", ")}`,
        };
      }
    }

    return bestMatch;
  }

  /**
   * Execute a tool directly if intent is clear.
   * Returns result with fallback flag if confidence is too low.
   */
  async tryDirectCall(request: string): Promise<DirectToolResult> {
    const startTime = performance.now();
    const classification = this.classifyIntent(request);

    // No clear intent - fallback to LLM
    if (!classification || classification.confidence < this.confidenceThreshold) {
      return {
        success: false,
        tool: "",
        result: { error: "Intent unclear, LLM routing needed" },
        latencyMs: Math.round(performance.now() - startTime),
        fallbackNeeded: true,
      };
    }

    // Check if confirmation is required
    const pattern = this.patterns.find((p) => p.id === classification.intent);
    if (pattern?.requireConfirmation) {
      return {
        success: false,
        tool: classification.tool,
        result: { 
          error: "Confirmation required",
          intent: classification.intent,
          args: classification.args,
        },
        latencyMs: Math.round(performance.now() - startTime),
        fallbackNeeded: true,
      };
    }

    // Execute tool directly
    try {
      const handlers = this.registry.buildHttpHandlers();
      const handler = handlers[classification.tool];
      
      if (!handler) {
        throw new Error(`Tool not found: ${classification.tool}`);
      }

      const result = await handler(classification.args);
      
      return {
        success: true,
        tool: classification.tool,
        result,
        latencyMs: Math.round(performance.now() - startTime),
        fallbackNeeded: false,
      };
    } catch (error: any) {
      return {
        success: false,
        tool: classification.tool,
        result: { error: error.message },
        latencyMs: Math.round(performance.now() - startTime),
        fallbackNeeded: true,
      };
    }
  }

  /**
   * Execute tool directly with explicit tool name and args.
   * For programmatic use when intent is already known.
   */
  async executeTool(toolName: string, args: Record<string, unknown>): Promise<DirectToolResult> {
    const startTime = performance.now();
    
    try {
      const handlers = this.registry.buildHttpHandlers();
      const handler = handlers[toolName];
      
      if (!handler) {
        throw new Error(`Tool not found: ${toolName}`);
      }

      const result = await handler(args);
      
      return {
        success: true,
        tool: toolName,
        result,
        latencyMs: Math.round(performance.now() - startTime),
        fallbackNeeded: false,
      };
    } catch (error: any) {
      return {
        success: false,
        tool: toolName,
        result: { error: error.message },
        latencyMs: Math.round(performance.now() - startTime),
        fallbackNeeded: true,
      };
    }
  }

  private calculateMatchScore(text: string, pattern: IntentPattern): number {
    // Check required keywords
    const requiredMatches = pattern.requiredKeywords.filter((kw) => text.includes(kw.toLowerCase()));
    if (requiredMatches.length < pattern.requiredKeywords.length) {
      return 0; // Not all required keywords matched
    }

    // Base score from required keywords
    let score = 0.5 + (requiredMatches.length / pattern.requiredKeywords.length) * 0.3;

    // Boost from optional keywords
    if (pattern.optionalKeywords) {
      const optionalMatches = pattern.optionalKeywords.filter((kw) => text.includes(kw.toLowerCase()));
      score += (optionalMatches.length / pattern.optionalKeywords.length) * 0.2;
    }

    return Math.min(score, 1.0);
  }

  private extractArgs(text: string, pattern: IntentPattern): Record<string, unknown> {
    const args: Record<string, unknown> = {};
    
    if (!pattern.argExtractors) return args;

    for (const extractor of pattern.argExtractors) {
      if (extractor.pattern instanceof RegExp) {
        const match = text.match(extractor.pattern);
        if (match && match[1]) {
          args[extractor.param] = match[1];
        }
      } else {
        const value = extractor.pattern(text);
        if (value !== undefined) {
          args[extractor.param] = value;
        }
      }
    }

    return args;
  }
}

/** Pre-built intent patterns for common operations */
export const COMMON_INTENT_PATTERNS: IntentPattern[] = [
  {
    id: "read_file",
    tool: "filesystem.read_file",
    requiredKeywords: ["打开", "读取", "read", "open"],
    optionalKeywords: ["文件", "file", "内容", "content"],
    minConfidence: 0.75,
    argExtractors: [
      { param: "path", pattern: /(?:打开|读取|read|open)\s+(?:文件\s+)?["']?([^"'\s]+)/i },
    ],
  },
  {
    id: "write_file",
    tool: "filesystem.write_file",
    requiredKeywords: ["写入", "保存", "write", "save"],
    optionalKeywords: ["文件", "file", "内容", "content"],
    minConfidence: 0.75,
    argExtractors: [
      { param: "path", pattern: /(?:写入|保存|write|save)\s+(?:到\s+)?["']?([^"'\s]+)/i },
    ],
  },
  {
    id: "search_files",
    tool: "filesystem.search",
    requiredKeywords: ["搜索", "查找", "search", "find"],
    optionalKeywords: ["文件", "file", "目录", "folder"],
    minConfidence: 0.7,
    argExtractors: [
      { param: "query", pattern: /(?:搜索|查找|search|find)\s+["']?([^"'\n]+)/i },
    ],
  },
  {
    id: "git_log",
    tool: "git.log",
    requiredKeywords: ["git", "历史", "提交", "commit", "log"],
    optionalKeywords: ["查看", "显示", "show", "history"],
    minConfidence: 0.7,
  },
  {
    id: "git_status",
    tool: "git.status",
    requiredKeywords: ["git", "状态", "status"],
    optionalKeywords: ["查看", "显示", "show"],
    minConfidence: 0.8,
  },
  {
    id: "terminal_execute",
    tool: "terminal.execute",
    requiredKeywords: ["执行", "运行", "execute", "run"],
    optionalKeywords: ["命令", "command", "脚本", "script"],
    minConfidence: 0.75,
    argExtractors: [
      { param: "command", pattern: /(?:执行|运行|execute|run)\s+["']?([^"'\n]+)/i },
    ],
  },
  {
    id: "code_analysis",
    tool: "code_analysis.analyze",
    requiredKeywords: ["分析", "代码", "analyze", "analysis"],
    optionalKeywords: ["复杂度", "complexity", "质量", "quality"],
    minConfidence: 0.7,
    argExtractors: [
      { param: "path", pattern: /(?:分析|analyze)\s+(?:代码\s+)?["']?([^"'\s]+)/i },
    ],
  },
  {
    id: "workspace_snapshot",
    tool: "workspace.snapshot",
    requiredKeywords: ["快照", "snapshot", "工作区", "workspace"],
    optionalKeywords: ["生成", "create", "保存", "save"],
    minConfidence: 0.75,
  },
];

/** Factory function to create a configured DirectToolCaller */
export function createDirectToolCaller(registry: ToolRegistry): DirectToolCaller {
  const caller = new DirectToolCaller(registry);
  caller.registerPatterns(COMMON_INTENT_PATTERNS);
  return caller;
}
