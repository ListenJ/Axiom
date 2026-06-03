/**
 * OpenClaw IDE Plugin Core
 * 
 * Provides IDE-agnostic integration for programming assistance.
 * Uses LSP-like protocol for real-time code analysis and suggestions.
 * 
 * Architecture:
 * - IDE Adapter: Handles IDE-specific communication (VSCode, IntelliJ, etc.)
 * - Code Context Extractor: Extracts current code context from IDE
 * - Analysis Engine: Uses AST for code understanding
 * - Suggestion Provider: Generates code completions and refactoring
 */

import { AstEngine } from "./ast-engine.js";
import type { ContentType, ParseResult } from "./types.js";
import { logger } from "../utils/logger.js";

/** Code position in a file */
export interface CodePosition {
  line: number;      // 0-based
  character: number; // 0-based
}

/** Code range in a file */
export interface CodeRange {
  start: CodePosition;
  end: CodePosition;
}

/** Current code context from IDE */
export interface CodeContext {
  /** Current file path */
  filePath: string;
  /** File content */
  content: string;
  /** Cursor position */
  cursor: CodePosition;
  /** Selected range (if any) */
  selection?: CodeRange;
  /** Programming language */
  language: string;
  /** Project root path */
  projectPath?: string;
  /** Open files in workspace */
  openFiles?: string[];
}

/** Code analysis result */
export interface CodeAnalysis {
  /** AST parse result */
  ast: ParseResult;
  /** Current function/class scope */
  currentScope?: string;
  /** Available variables in scope */
  variables: Array<{ name: string; type: string }>;
  /** Function signatures */
  functions: Array<{ name: string; signature: string; docs?: string }>;
  /** Import statements */
  imports: string[];
  /** Code complexity metrics */
  complexity: {
    cyclomatic: number;
    cognitive: number;
  };
}

/** Code suggestion */
export interface CodeSuggestion {
  /** Suggestion type */
  type: "completion" | "refactoring" | "documentation" | "error_fix";
  /** Suggested code */
  code: string;
  /** Description */
  description: string;
  /** Confidence score (0-1) */
  confidence: number;
  /** Range to replace (if applicable) */
  range?: CodeRange;
  /** Additional details */
  details?: string;
}

/** IDE action request */
export interface IdeAction {
  /** Action type */
  type: "analyze" | "complete" | "refactor" | "explain" | "fix";
  /** Current code context */
  context: CodeContext;
  /** Additional parameters */
  params?: Record<string, unknown>;
}

/** IDE action response */
export interface IdeActionResponse {
  /** Success flag */
  success: boolean;
  /** Suggestions */
  suggestions: CodeSuggestion[];
  /** Analysis result */
  analysis?: CodeAnalysis;
  /** Error message (if failed) */
  error?: string;
}

/** IDE adapter interface */
export interface IdeAdapter {
  readonly name: string;
  readonly supportedLanguages: string[];
  
  /** Initialize adapter */
  initialize(): Promise<void>;
  
  /** Handle action from IDE */
  handleAction(action: IdeAction): Promise<IdeActionResponse>;
  
  /** Send suggestion to IDE */
  sendSuggestion(suggestion: CodeSuggestion): Promise<void>;
  
  /** Check if adapter is connected */
  isConnected(): boolean;
}

/**
 * Code Context Extractor
 * Extracts relevant code context for analysis
 */
export class CodeContextExtractor {
  private astEngine = new AstEngine();

  /** Extract context from current cursor position */
  extractContext(context: CodeContext): CodeContext {
    // Enhance context with project-wide information
    const enhanced = { ...context };
    
    // Add surrounding lines for better context
    const lines = context.content.split("\n");
    const startLine = Math.max(0, context.cursor.line - 5);
    const endLine = Math.min(lines.length, context.cursor.line + 5);
    
    return enhanced;
  }

  /** Get current scope information */
  getCurrentScope(context: CodeContext): string | undefined {
    const ast = this.astEngine.parse(context.content, {
      contentType: this.detectContentType(context.language),
    });

    // Find the innermost node containing cursor position
    for (const [, node] of ast.nodes) {
      if (node.type === "function" || node.type === "class") {
        // Check if cursor is within this node's range
        // Simplified: just return the first function/class for now
        return node.label;
      }
    }

    return undefined;
  }

  private detectContentType(language: string): ContentType {
    switch (language.toLowerCase()) {
      case "typescript":
      case "ts":
        return "typescript";
      case "javascript":
      case "js":
        return "javascript";
      case "python":
      case "py":
        return "python";
      default:
        return "text";
    }
  }
}

/**
 * Analysis Engine
 * Performs code analysis using AST
 */
export class AnalysisEngine {
  private astEngine = new AstEngine();

  /** Analyze code and return structured analysis */
  analyze(context: CodeContext): CodeAnalysis {
    const contentType = this.detectContentType(context.language);
    const ast = this.astEngine.parse(context.content, { contentType });

    const variables: Array<{ name: string; type: string }> = [];
    const functions: Array<{ name: string; signature: string; docs?: string }> = [];
    const imports: string[] = [];

    // Extract information from AST
    for (const [, node] of ast.nodes) {
      switch (node.type) {
        case "function":
          functions.push({
            name: node.label,
            signature: this.extractSignature(node.content),
            docs: node.metadata?.docs as string,
          });
          break;
        case "import":
          imports.push(node.content);
          break;
        case "comment":
          // Extract JSDoc/type info from comments
          break;
      }
    }

    return {
      ast,
      currentScope: undefined, // Will be filled by context extractor
      variables,
      functions,
      imports,
      complexity: this.calculateComplexity(ast),
    };
  }

  private detectContentType(language: string): ContentType {
    switch (language.toLowerCase()) {
      case "typescript":
      case "ts":
        return "typescript";
      case "javascript":
      case "js":
        return "javascript";
      case "python":
      case "py":
        return "python";
      default:
        return "text";
    }
  }

  private extractSignature(content: string): string {
    // Extract function signature from content
    const match = content.match(/(?:function|const|let|var)\s+(\w+)\s*\(([^)]*)\)/);
    if (match) {
      return `${match[1]}(${match[2]})`;
    }
    return content.slice(0, 50);
  }

  private calculateComplexity(ast: ParseResult): { cyclomatic: number; cognitive: number } {
    let cyclomatic = 1;
    let cognitive = 0;

    for (const [, node] of ast.nodes) {
      if (node.type === "function") {
        // Count branches in function
        const branches = (node.content.match(/if|while|for|switch|catch/g) || []).length;
        cyclomatic += branches;
        cognitive += branches * 2;
      }
    }

    return { cyclomatic, cognitive };
  }
}

/**
 * Suggestion Provider
 * Generates code suggestions based on analysis
 */
export class SuggestionProvider {
  private analysisEngine = new AnalysisEngine();

  /** Generate suggestions for current context */
  async generateSuggestions(context: CodeContext): Promise<CodeSuggestion[]> {
    const analysis = this.analysisEngine.analyze(context);
    const suggestions: CodeSuggestion[] = [];

    // Generate completion suggestions
    const completions = await this.generateCompletions(context, analysis);
    suggestions.push(...completions);

    // Generate refactoring suggestions
    const refactorings = this.generateRefactorings(context, analysis);
    suggestions.push(...refactorings);

    return suggestions;
  }

  private async generateCompletions(
    context: CodeContext,
    analysis: CodeAnalysis
  ): Promise<CodeSuggestion[]> {
    const suggestions: CodeSuggestion[] = [];

    // Suggest available functions
    for (const func of analysis.functions) {
      suggestions.push({
        type: "completion",
        code: func.name,
        description: `Function: ${func.signature}`,
        confidence: 0.8,
        details: func.docs,
      });
    }

    return suggestions;
  }

  private generateRefactorings(
    context: CodeContext,
    analysis: CodeAnalysis
  ): CodeSuggestion[] {
    const suggestions: CodeSuggestion[] = [];

    // Suggest extracting long functions
    if (analysis.complexity.cyclomatic > 10) {
      suggestions.push({
        type: "refactoring",
        code: "// Extract into smaller functions",
        description: "Function is too complex. Consider breaking it down.",
        confidence: 0.9,
      });
    }

    return suggestions;
  }
}

/**
 * IDE Plugin Core
 * Main entry point for IDE integration
 */
export class IdePluginCore {
  private contextExtractor = new CodeContextExtractor();
  private analysisEngine = new AnalysisEngine();
  private suggestionProvider = new SuggestionProvider();
  private adapters = new Map<string, IdeAdapter>();

  /** Register an IDE adapter */
  registerAdapter(adapter: IdeAdapter): void {
    this.adapters.set(adapter.name, adapter);
    logger.info(`[IdePlugin] Registered adapter: ${adapter.name}`);
  }

  /** Handle action from any IDE */
  async handleAction(action: IdeAction): Promise<IdeActionResponse> {
    try {
      logger.info(`[IdePlugin] Handling action: ${action.type}`, {
        file: action.context.filePath,
        language: action.context.language,
      });

      // Extract enhanced context
      const enhancedContext = this.contextExtractor.extractContext(action.context);

      // Perform analysis
      const analysis = this.analysisEngine.analyze(enhancedContext);

      // Generate suggestions
      const suggestions = await this.suggestionProvider.generateSuggestions(enhancedContext);

      return {
        success: true,
        suggestions,
        analysis,
      };
    } catch (error: unknown) {
      logger.error("[IdePlugin] Action handling failed", error instanceof Error ? error : new Error(String(error)));
      return {
        success: false,
        suggestions: [],
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /** Get registered adapters */
  getAdapters(): IdeAdapter[] {
    return Array.from(this.adapters.values());
  }
}

/** Global IDE plugin instance */
export const idePlugin = new IdePluginCore();
