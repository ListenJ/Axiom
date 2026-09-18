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
import { z } from "zod";
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

  // ── ① 权限硬底线（审计 C-3，2026-08-24；T3 2026-09-18 收敛为唯一收口点）──
  // 原先本函数内联了「字段名启发式」的顶层扫描，tool-registry 自己的注释已承认
  // 「仍非完备——非常规字段名携带路径可绕过本初筛」。
  // 现全部委托给 src/sandbox/execution-guard.ts 的唯一收口点：
  //   - 递归扫描（嵌套对象/数组不再绕过）
  //   - 命令与路径的语义源仍是 utils/permissions.ts（不另立第二套）
  // 硬底线不可被 autoAcceptMode 或任何降级旁路绕过。
  // 动态 import 保持既有"registry 启动早期不拉入额外依赖链"的性质。
  const { guardToolExecution } = await import("../sandbox/execution-guard.js");
  guardToolExecution(toolName, args);

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
/** 构造选项 */
export interface ToolRegistryOptions {
  /** 工具执行前的安全守卫（默认 defaultToolGuard） */
  guard?: ToolGuard;
  /** 真懒加载：tools/list 只下发 meta 工具面，其余工具按需取用（默认 false） */
  lazy?: boolean;
}

/**
 * 真懒加载模式固定下发的 meta 工具名。
 * 这 3 个工具各自都是小 schema，构成"永远在上下文里"的全部成本。
 */
export const LAZY_META_TOOL_NAMES = ["tool_search", "tool_describe", "tool_invoke"] as const;

export class ToolRegistry {
  private tools: ToolDef[] = [];
  private guard: ToolGuard;
  private readonly lazyMode: boolean;
  /** tool_describe 用的 schema 目录（首次调用时按需构建，构造后缓存） */
  private schemaCatalogPromise?: Promise<Map<string, ToolSchemaInfo>>;

  constructor(opts?: ToolRegistryOptions) {
    this.guard = opts?.guard ?? defaultToolGuard;
    this.lazyMode = opts?.lazy === true;
  }

  /** 当前是否处于真懒加载模式 */
  get isLazy(): boolean {
    return this.lazyMode;
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

  /**
   * Register tools with an MCP server.
   *
   * 默认：全部工具定义下发（行为与历史一致）。
   * 懒加载模式（options.lazy）：只下发 LAZY_META_TOOL_NAMES 三个 meta 工具，
   * 其余 188 个工具定义**在客户端显式检索/描述/调用之前不进入 tools/list**，
   * 因此不占用客户端上下文 token。
   */
  registerWithMcp(mcp: McpServer, tools?: readonly ToolDef[]): void {
    const selected = tools ?? this.tools;
    if (this.lazyMode) {
      this.registerLazySurface(mcp, selected);
      return;
    }
    for (const tool of selected) {
      this.registerOne(mcp, tool);
    }
  }

  /** 把单个 ToolDef 注册进 MCP server（含错误包装） */
  private registerOne(mcp: McpServer, tool: ToolDef): void {
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

  /** 懒加载模式：只注册 meta 工具面（其余工具不进 tools/list） */
  private registerLazySurface(mcp: McpServer, selected: readonly ToolDef[]): void {
    const byName = new Map(selected.map((t) => [t.name, t]));

    const metaTools: ToolDef[] = [
      {
        name: "tool_search",
        description:
          "按关键词检索可用工具，返回匹配工具的 name 与 description（不含 inputSchema，体积小）。"
          + "懒加载模式下工具定义不预先下发，先用本工具找到候选，再用 tool_describe 取参数结构。",
        inputSchema: {
          query: z.string().describe("关键词，可空格分隔多个词"),
          limit: z.number().optional().describe("最多返回条数，默认 10"),
        },
        handler: async (args) => {
          const query = String(args.query ?? "").trim();
          if (!query) {
            return { error: true, message: "query 不能为空", total: selected.length, results: [] };
          }
          const limit = typeof args.limit === "number" && args.limit > 0 ? args.limit : 10;
          const scored = rankToolsByQuery(selected, query).slice(0, limit);
          return {
            total: selected.length,
            query,
            results: scored.map((t) => ({ name: t.name, description: t.description })),
          };
        },
      },
      {
        name: "tool_describe",
        description:
          "获取指定工具的完整定义（name/description/inputSchema）。懒加载模式下调用本工具才会把该工具的"
          + "参数结构取回上下文，未调用的工具不占用上下文。",
        inputSchema: {
          name: z.string().describe("由 tool_search 得到的工具名"),
        },
        handler: async (args) => {
          const name = String(args.name ?? "");
          const catalog = await this.getSchemaCatalog(selected);
          const entry = catalog.get(name);
          if (!entry) {
            const known = byName.has(name);
            return {
              error: true,
              message: `未知工具 "${name}"${known ? "（该工具未暴露给当前传输）" : ""}`,
            };
          }
          return entry;
        },
      },
      {
        name: "tool_invoke",
        description:
          "按工具名调用任意已注册工具（懒加载模式下的统一执行入口）。执行链与全量模式完全一致，"
          + "包括安全守卫；参数格式见 tool_describe 返回的 inputSchema。",
        inputSchema: {
          name: z.string().describe("工具名"),
          arguments: z.record(z.any()).optional().describe("按 inputSchema 构造的参数对象"),
        },
        handler: async (args) => {
          const name = String(args.name ?? "");
          const target = byName.get(name);
          if (!target) {
            // 调用不存在的工具是**动作失败**（不是查询结果），按 MCP 语义以 isError 返回，
            // 与 tool_describe（查询语义，返回 error 字段）区分开。
            throw new Error(`未知工具 "${name}"`);
          }
          const toolArgs = (args.arguments ?? {}) as Record<string, unknown>;
          const result = await target.handler(toolArgs);
          return target.format === "text" ? String(result) : result;
        },
      },
    ];

    for (const meta of metaTools) this.registerOne(mcp, meta);
  }

  /**
   * 构建 name -> {description, inputSchema} 目录。
   *
   * 用 SDK 自己的 zod→JSON Schema 转换路径产出 schema：把工具注册到一个**从不连接传输**
   * 的探针 McpServer 上，再经 InMemoryTransport 走一次公开的 tools/list。
   * 这样 describe 的结果与全量模式下客户端看到的定义**逐字段一致**，
   * 而不是在本模块里手写第二套 zod 序列化（会与 SDK 版本漂移）。
   */
  private getSchemaCatalog(selected: readonly ToolDef[]): Promise<Map<string, ToolSchemaInfo>> {
    if (!this.schemaCatalogPromise) {
      this.schemaCatalogPromise = (async () => {
        const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
        const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
        const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
        const probe = new McpServer({ name: "axiom-schema-catalog", version: "0" });
        for (const tool of selected) this.registerOne(probe, tool);
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        const client = new Client({ name: "axiom-schema-catalog", version: "0" });
        await Promise.all([probe.connect(serverTransport), client.connect(clientTransport)]);
        try {
          const res = await client.listTools();
          return new Map(res.tools.map((t) => [t.name, { name: t.name, description: t.description, inputSchema: t.inputSchema }]));
        } finally {
          await client.close();
          await probe.close();
        }
      })();
    }
    return this.schemaCatalogPromise;
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

/** tool_describe 返回的单条工具定义（schema 由 SDK 自身转换产出） */
export interface ToolSchemaInfo {
  name: string;
  description?: string;
  inputSchema: unknown;
}

/**
 * 朴素但确定的工具检索：按 name/description 的词命中打分。
 * 排序规则固定（分数降序，同分按 name 字典序），保证同输入同输出。
 * 不做语义召回——懒加载检索的定位是"缩小候选面"，不是替换确定性检索引擎。
 */
export function rankToolsByQuery(tools: readonly ToolDef[], query: string): ToolDef[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const scored = tools.map((t) => {
    const name = t.name.toLowerCase();
    const desc = (t.description ?? "").toLowerCase();
    let score = 0;
    for (const term of terms) {
      if (name.includes(term)) score += 10;
      if (desc.includes(term)) score += 3;
    }
    return { tool: t, score };
  });
  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => (b.score - a.score) || a.tool.name.localeCompare(b.tool.name))
    .map((s) => s.tool);
}
