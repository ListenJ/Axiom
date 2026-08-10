/**
 * Unified MCP Tool Registry
 * 
 * Eliminates duplication between stdio and HTTP transport registrations.
 * Each tool is defined once and registered for both transports automatically.
 *
 * 安全（2026-07-26 R1 修复）：registry 是全部 MCP 工具的唯一收口点，
 * 在此统一接入双层复核监视（边缘初筛→主模型复核→强制审批），
 * 修复 executeWithModeGuard/checkToolPermission 无调用方的死代码问题。
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolSurfaceLike } from "../utils/tool-surface.js";

/** 工具可见性：internal 仅内部 Agent，external 可被外部 MCP 使用 */
export type ToolExposure = "internal" | "external" | "safe-external";

/** Raw handler: receives parsed args, returns raw result */
export type ToolHandler = (args: Record<string, unknown>) => Promise<unknown>;

/** 安全守卫：工具执行前调用，抛出异常即阻止执行（导出供测试注入） */
export type ToolGuard = (toolName: string, args: Record<string, unknown>) => Promise<void>;

/**
 * 生产守卫（默认）：双层复核监视。
 * 边缘初筛 low → 直接放行（~1s，fail-open）；
 * 确认危险 → 强制审批（WS 客户端 15s 内确认，无订阅者 fail-closed 自动拒绝）。
 * 懒加载 import 避免 registry 在启动早期拉入 router 依赖链。
 */
async function defaultToolGuard(toolName: string, args: Record<string, unknown>): Promise<void> {
  const { monitorToolPayload } = await import("../agents/risk-monitor.js");
  const verdict = await monitorToolPayload(toolName, args);
  if (verdict === "require-approval") {
    const { getApprovalBridge } = await import("../utils/approval-bridge.js");
    const approved = await getApprovalBridge().request(toolName, args, {
      risk: "destructive",
      timeoutMs: 15000,
    });
    if (!approved) {
      throw new Error(`[RiskMonitor] 双层复核判定为高危操作且未获批准，已阻止执行: ${toolName}`);
    }
  }
}

/** Tool definition */
export interface ToolDef extends ToolSurfaceLike {
  /** 工具分组标签 (用于懒加载) */
  tags?: string[];
  /** 工具可见性标签；缺省为 internal */
  exposure?: ToolExposure[];
}

/** Tool registry that manages dual transport registration */
export class ToolRegistry {
  private tools: ToolDef[] = [];
  private guard: ToolGuard;

  constructor(opts?: { guard?: ToolGuard }) {
    this.guard = opts?.guard ?? defaultToolGuard;
  }

  /** Add a tool definition（handler 自动包裹安全守卫：先复核后执行） */
  add(tool: ToolDef): this {
    const guard = this.guard;
    const exposures: ToolExposure[] = tool.exposure?.length ? [...tool.exposure] : ["internal"];
    const wrapped: ToolDef = {
      ...tool,
      exposure: exposures,
      handler: async (args: Record<string, unknown>) => {
        await guard(tool.name, args);
        return tool.handler(args);
      },
    };
    this.tools.push(wrapped);
    return this;
  }

  /** Register all tools with MCP stdio server */
  registerWithMcp(mcp: McpServer, tools?: readonly ToolDef[]): void {
    const selected = tools ?? this.tools;
    for (const tool of selected) {
      mcp.registerTool(
        tool.name,
        {
          description: tool.description,
          inputSchema: tool.inputSchema as any,
        },
        async (args: Record<string, unknown>) => {
          try {
            const result = await tool.handler(args);
            const text =
              tool.format === "text"
                ? String(result)
                : JSON.stringify(result, null, 2);
            return {
              content: [{ type: "text" as const, text }],
            };
          } catch (e) {
            const errMsg = e instanceof Error ? e.message : String(e);
            const errStack = e instanceof Error ? e.stack ?? "" : "";
            return {
              content: [{
                type: "text" as const,
                text: JSON.stringify({
                  error: true,
                  message: `工具 "${tool.name}" 执行失败: ${errMsg}`,
                  stack: errStack || undefined,
                }, null, 2),
              }],
              isError: true,
            };
          }
        }
      );
    }
  }

  /** Build HTTP tool handlers mapping (with error wrapping) */
  buildHttpHandlers(tools?: readonly ToolDef[]): Record<string, ToolHandler> {
    const handlers: Record<string, ToolHandler> = {};
    const selected = tools ?? this.tools;
    for (const tool of selected) {
      const originalHandler = tool.handler;
      handlers[tool.name] = async (args: Record<string, unknown>) => {
        try {
          return await originalHandler(args);
        } catch (e) {
          const errMsg = e instanceof Error ? e.message : String(e);
          return {
            error: true,
            message: `工具 "${tool.name}" 执行失败: ${errMsg}`,
          };
        }
      };
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

  /** 移除指定名称的工具（2026-07-26 W3：插件 disable / MCP 断开需要）。
   *  @returns true 表示有工具被移除 */
  remove(name: string): boolean {
    const before = this.tools.length;
    this.tools = this.tools.filter((t) => t.name !== name);
    return this.tools.length < before;
  }

  /** 按可见性过滤工具（外部 MCP 使用） */
  filterByExposure(allow: ToolExposure[]): ToolDef[] {
    const allowSet = new Set(allow);
    return this.tools
      .filter((t) => t.exposure?.some((e) => allowSet.has(e)))
      .sort((a, b) => a.name.localeCompare(b.name));
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
