/**
 * Unified MCP Tool Registry
 * 
 * Eliminates duplication between stdio and HTTP transport registrations.
 * Each tool is defined once and registered for both transports automatically.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

/** Raw handler: receives parsed args, returns raw result */
export type ToolHandler = (args: Record<string, unknown>) => Promise<unknown>;

/** Tool definition */
export interface ToolDef {
  name: string;
  description: string;
  /** Zod schema or plain object schema */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  inputSchema: any;
  /** Handler that produces raw result */
  handler: ToolHandler;
  /** Output format for stdio transport */
  format?: "json" | "text";
  /** 工具分组标签 (用于懒加载) */
  tags?: string[];
}

/** Tool registry that manages dual transport registration */
export class ToolRegistry {
  private tools: ToolDef[] = [];

  /** Add a tool definition */
  add(tool: ToolDef): this {
    this.tools.push(tool);
    return this;
  }

  /** Register all tools with MCP stdio server */
  registerWithMcp(mcp: McpServer): void {
    for (const tool of this.tools) {
      mcp.registerTool(
        tool.name,
        {
          description: tool.description,
          inputSchema: tool.inputSchema,
        },
        async (args: Record<string, unknown>) => {
          const result = await tool.handler(args);
          const text =
            tool.format === "text"
              ? String(result)
              : JSON.stringify(result, null, 2);
          return {
            content: [{ type: "text" as const, text }],
          };
        }
      );
    }
  }

  /** Build HTTP tool handlers mapping */
  buildHttpHandlers(): Record<string, ToolHandler> {
    const handlers: Record<string, ToolHandler> = {};
    for (const tool of this.tools) {
      handlers[tool.name] = tool.handler;
    }
    return handlers;
  }

  /** Build tools metadata array */
  getToolsMeta(): Array<{ name: string; description: string }> {
    return this.tools.map((t) => ({ name: t.name, description: t.description }));
  }

  /** Get all registered tool names */
  getToolNames(): string[] {
    return this.tools.map((t) => t.name);
  }

  /** Get count */
  get size(): number {
    return this.tools.length;
  }

  /** 按标签过滤工具 */
  getToolsByTags(tags: string[]): ToolDef[] {
    const tagSet = new Set(tags);
    return this.tools.filter((t) => t.tags?.some((tag) => tagSet.has(tag)));
  }

  /** 获取工具元数据 (按标签过滤) */
  getToolsMetaFiltered(tags?: string[]): Array<{ name: string; description: string }> {
    if (!tags || tags.length === 0) return this.getToolsMeta();
    const filtered = this.getToolsByTags(tags);
    return filtered.map((t) => ({ name: t.name, description: t.description }));
  }
}

/** Helper to create a registry and populate it in one call */
export function createRegistry(tools: ToolDef[]): ToolRegistry {
  const registry = new ToolRegistry();
  for (const tool of tools) registry.add(tool);
  return registry;
}
