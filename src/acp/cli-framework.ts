/**
 * ACP (Agent Command Protocol) CLI Framework
 *
 * Provides a framework for registering custom programming tools
 * that can be invoked via CLI and integrate with MCP tools.
 *
 * Usage:
 *   const acp = new ACPFramework();
 *   acp.registerTool({
 *     name: "lint",
 *     description: "Run linter on project",
 *     handler: async (args) => { ... },
 *   });
 *   acp.execute(process.argv.slice(2));
 */

import { logger } from "../utils/logger.js";

export interface ACPTool {
  /** Tool name (used as subcommand) */
  name: string;
  /** Human-readable description */
  description: string;
  /** Argument definitions for help text */
  args?: Array<{
    name: string;
    description: string;
    required?: boolean;
    default?: string;
  }>;
  /** Flags definitions */
  flags?: Array<{
    name: string;
    description: string;
    alias?: string;
  }>;
  /** Handler function */
  handler: (args: string[], flags: Record<string, string | boolean>) => Promise<ACPToolResult>;
  /** Category for grouping */
  category?: string;
}

export interface ACPToolResult {
  success: boolean;
  output?: string;
  error?: string;
  /** Suggest follow-up commands */
  suggestions?: string[];
  /** Structured data for programmatic use */
  data?: unknown;
}

export interface ACPFrameworkOptions {
  /** Program name shown in help */
  programName: string;
  /** Version string */
  version?: string;
  /** Default tool to run when no subcommand given */
  defaultTool?: string;
}

export class ACPFramework {
  private tools = new Map<string, ACPTool>();
  private opts: ACPFrameworkOptions;

  constructor(opts: ACPFrameworkOptions) {
    this.opts = opts;
  }

  /**
   * Register a custom tool
   */
  registerTool(tool: ACPTool): void {
    if (this.tools.has(tool.name)) {
      logger.warn("[ACP] Tool already registered, overwriting", { name: tool.name });
    }
    this.tools.set(tool.name, tool);
    logger.debug("[ACP] Registered tool", { name: tool.name, category: tool.category });
  }

  /**
   * Register multiple tools
   */
  registerTools(tools: ACPTool[]): void {
    for (const tool of tools) {
      this.registerTool(tool);
    }
  }

  /**
   * Unregister a tool
   */
  unregisterTool(name: string): boolean {
    return this.tools.delete(name);
  }

  /**
   * List all registered tools
   */
  listTools(): ACPTool[] {
    return Array.from(this.tools.values());
  }

  /**
   * Get a tool by name
   */
  getTool(name: string): ACPTool | undefined {
    return this.tools.get(name);
  }

  /**
   * Parse CLI arguments into args and flags
   *
   * Format: toolName arg1 arg2 --flag --key=value -f
   */
  parseArgs(argv: string[]): {
    toolName: string;
    args: string[];
    flags: Record<string, string | boolean>;
  } {
    if (argv.length === 0) {
      return { toolName: this.opts.defaultTool || "help", args: [], flags: {} };
    }

    const toolName = argv[0];
    const args: string[] = [];
    const flags: Record<string, string | boolean> = {};

    for (let i = 1; i < argv.length; i++) {
      const arg = argv[i];

      if (arg.startsWith("--")) {
        const eqIdx = arg.indexOf("=");
        if (eqIdx > 0) {
          flags[arg.slice(2, eqIdx)] = arg.slice(eqIdx + 1);
        } else {
          flags[arg.slice(2)] = true;
        }
      } else if (arg.startsWith("-") && arg.length > 1) {
        // Short flag(s): -abc or -f value
        if (arg.length === 2) {
          const nextArg = argv[i + 1];
          if (nextArg && !nextArg.startsWith("-")) {
            flags[arg[1]] = nextArg;
            i++; // Skip next as it's the value
          } else {
            flags[arg[1]] = true;
          }
        } else {
          // Multiple short flags: -abc
          for (let j = 1; j < arg.length; j++) {
            flags[arg[j]] = true;
          }
        }
      } else {
        args.push(arg);
      }
    }

    return { toolName, args, flags };
  }

  /**
   * Execute a tool from CLI arguments
   */
  async execute(argv: string[]): Promise<ACPToolResult> {
    const { toolName, args, flags } = this.parseArgs(argv);

    if (toolName === "help" || toolName === "--help" || toolName === "-h") {
      return { success: true, output: this.generateHelp() };
    }

    if (toolName === "version" || toolName === "--version" || toolName === "-v") {
      return { success: true, output: `${this.opts.programName} ${this.opts.version || "unknown"}` };
    }

    const tool = this.tools.get(toolName);
    if (!tool) {
      const suggestions = this.findSimilarTools(toolName);
      return {
        success: false,
        error: `Unknown tool: "${toolName}". ${suggestions.length > 0 ? `Did you mean: ${suggestions.join(", ")}?` : "Use 'help' to list available tools."}`,
        suggestions,
      };
    }

    try {
      logger.info("[ACP] Executing tool", { tool: toolName, args, flags });
      const startTime = Date.now();
      const result = await tool.handler(args, flags);
      const duration = Date.now() - startTime;
      logger.info("[ACP] Tool completed", { tool: toolName, success: result.success, durationMs: duration });
      return result;
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      logger.error("[ACP] Tool execution failed", e instanceof Error ? e : new Error(error), { tool: toolName });
      return { success: false, error };
    }
  }

  /**
   * Generate help text
   */
  generateHelp(): string {
    const lines: string[] = [
      `${this.opts.programName} ${this.opts.version || ""}`,
      "",
      "Usage:",
      `  ${this.opts.programName} <tool> [args...] [flags...]`,
      "",
      "Available tools:",
    ];

    // Group by category
    const categories = new Map<string, ACPTool[]>();
    const uncategorized: ACPTool[] = [];

    for (const tool of this.tools.values()) {
      if (tool.category) {
        const list = categories.get(tool.category) || [];
        list.push(tool);
        categories.set(tool.category, list);
      } else {
        uncategorized.push(tool);
      }
    }

    for (const [category, tools] of categories) {
      lines.push(`\n  [${category}]`);
      for (const tool of tools) {
        lines.push(`    ${tool.name.padEnd(20)} ${tool.description}`);
      }
    }

    if (uncategorized.length > 0) {
      lines.push("\n  [general]");
      for (const tool of uncategorized) {
        lines.push(`    ${tool.name.padEnd(20)} ${tool.description}`);
      }
    }

    lines.push("", "Flags:", "  --help, -h     Show this help", "  --version, -v  Show version");

    return lines.join("\n");
  }

  /**
   * Generate detailed help for a specific tool
   */
  generateToolHelp(toolName: string): string {
    const tool = this.tools.get(toolName);
    if (!tool) {
      return `Unknown tool: ${toolName}`;
    }

    const lines: string[] = [
      `${tool.name} - ${tool.description}`,
      "",
      "Usage:",
      `  ${this.opts.programName} ${tool.name} ${tool.args?.map((a) => (a.required ? `<${a.name}>` : `[${a.name}]`)).join(" ") || ""}`,
    ];

    if (tool.args && tool.args.length > 0) {
      lines.push("", "Arguments:");
      for (const arg of tool.args) {
        const defaultStr = arg.default !== undefined ? ` (default: ${arg.default})` : "";
        lines.push(`  ${arg.name.padEnd(15)} ${arg.description}${defaultStr}`);
      }
    }

    if (tool.flags && tool.flags.length > 0) {
      lines.push("", "Flags:");
      for (const flag of tool.flags) {
        const aliasStr = flag.alias ? `, -${flag.alias}` : "";
        lines.push(`  --${flag.name}${aliasStr.padEnd(12)} ${flag.description}`);
      }
    }

    return lines.join("\n");
  }

  /**
   * Find similar tool names (for typo suggestions)
   */
  private findSimilarTools(input: string): string[] {
    const inputLower = input.toLowerCase();
    const scored: Array<{ name: string; score: number }> = [];

    for (const name of this.tools.keys()) {
      const nameLower = name.toLowerCase();
      let score = 0;

      // Exact substring
      if (nameLower.includes(inputLower)) score += 3;
      if (inputLower.includes(nameLower)) score += 2;

      // Common prefix
      let prefixLen = 0;
      for (let i = 0; i < Math.min(nameLower.length, inputLower.length); i++) {
        if (nameLower[i] === inputLower[i]) prefixLen++;
        else break;
      }
      score += prefixLen;

      if (score > 1) {
        scored.push({ name, score });
      }
    }

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, 3).map((s) => s.name);
  }
}

/**
 * Create a pre-configured ACP instance for OpenClaw
 */
export function createOpenClawACP(): ACPFramework {
  return new ACPFramework({
    programName: "openclaw",
    version: "1.0.0",
    defaultTool: "help",
  });
}
