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
import { readString } from "../utils/env.js";
import { logger } from "../utils/logger.js";

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
  // ── ⓪ 执行模式门控（审计 O1，2026-08-25）──
  // Plan 封禁无条件生效（blockedTools/破坏性/未分类工具直接拒绝）；
  // YOLO 直通；Agent 默认保持现行为不强制审批，
  // 强制审批仅在 AXIOM_ENFORCE_MODE_APPROVAL=1 时经 approval-bridge 启用。
  const { executionMode } = await import("../agents/execution-mode.js");
  const modeCheck = executionMode.canExecute(toolName);
  if (!modeCheck.allowed) {
    throw new Error(`[ModeGate] ${modeCheck.reason ?? `tool "${toolName}" blocked in ${executionMode.getMode()} mode`}`);
  }
  if (
    executionMode.getMode() !== "yolo" &&
    readString("AXIOM_ENFORCE_MODE_APPROVAL") === "1" &&
    executionMode.needsApproval(toolName)
  ) {
    const approved = await executionMode.requestApproval(toolName, args);
    if (!approved) {
      throw new Error(`[ModeGate] approval denied for ${toolName}`);
    }
  }

  // ── ① 权限硬底线（审计 C-3，2026-08-24）──
  // permissions.ts 的 HIGH_RISK_PATTERNS / 敏感路径规则此前是零调用方的死代码。
  // 现在所有 MCP 工具执行前统一过闸：高危命令/敏感路径操作直接拒绝，
  // 不进入任何 fail-open 旁路（硬底线不可被 autoAcceptMode 或降级绕过）。
  const { checkCommandPermission, checkFilePermission } = await import("../utils/permissions.js");
  for (const [key, value] of Object.entries(args)) {
    if (typeof value !== "string" || !value.trim()) continue;
    if (/command|script|cmd/i.test(key)) {
      const c = checkCommandPermission(value);
      if (!c.allowed) {
        throw new Error(`[HardFloor] ${c.reason ?? "high-risk command"} (tool=${toolName}, field=${key})`);
      }
    }
    if (
      /^(path|file|filePath|file_path|target|destination|source|url|from|to|repoPath|repo_path|cwd|dir|dirPath|dir_path|folder|directory|absPath|abs_path|newPath|new_path|oldPath|old_path|destPath|dest_path|srcPath|src_path|outputPath|output_path)$/i.test(key)
    ) {
      // L8（2026-08-28 审计）：路径承载字段并集按各工具实际参数名 grep 取得，
      // 覆盖 camelCase/snake_case 常见变体与 url（file:// 等路径型 URL）。
      // 注意：仍非完备——非常规字段名携带路径可绕过本初筛，
      // 最终依赖工具内部路径校验兜底（与 M12 呼应），此处仅为最低保障。
      const op = /delete|remove/i.test(toolName) ? ("delete" as const)
        : /write|create|move/i.test(toolName) ? ("write" as const)
        : ("read" as const);
      const f = checkFilePermission(value, op);
      if (!f.allowed) {
        throw new Error(`[HardFloor] ${f.reason ?? "sensitive path"} (tool=${toolName}, field=${key})`);
      }
    }
  }

  // ── ② 双层风险复核（原有）──
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

  /** Add a tool definition（handler 自动包裹安全守卫：先复核后执行）。
   *  L4（2026-08-28 审计）：同名工具已存在时 warn 并跳过（幂等注册语义），
   *  避免 SDK 层（MCP registerTool）遇重名抛错导致启动期崩溃。 */
  add(tool: ToolDef): this {
    if (this.tools.some((t) => t.name === tool.name)) {
      logger.warn(`[ToolRegistry] tool "${tool.name}" already registered, skipping duplicate add`);
      return this;
    }
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
}

/** Helper to create a registry and populate it in one call */
export function createRegistry(tools: ToolDef[]): ToolRegistry {
  const registry = new ToolRegistry();
  for (const tool of tools) registry.add(tool);
  return registry;
}
