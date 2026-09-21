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
import { zodToJsonSchema } from "../utils/tool-surface.js";
import { CAPABILITY_PAYLOAD, adjudicateCallPayloads } from "../utils/permissions.js";
import { readString } from "../utils/env.js";
import { logger } from "../utils/logger.js";
import type { Capability, PayloadFields } from "../utils/permissions.js";

/** 工具可见性：internal 仅内部 Agent，external 可被外部 MCP 使用 */
export type ToolExposure = "internal" | "external" | "safe-external";
/** Raw handler: receives parsed args, returns raw result */
export type ToolHandler = (args: Record<string, unknown>) => Promise<unknown>;

/** 安全守卫：工具执行前调用，抛出异常即阻止执行（导出供测试注入） */
export type ToolGuard = (
  toolName: string,
  capability: readonly Capability[],
  args: Record<string, unknown>,
  /** 注册处声明的"目标在哪个入参"（R2-D / S-8：命令类负载只能靠声明，不能靠猜） */
  payloadFields?: PayloadFields,
) => Promise<void>;

/**
 * 生产守卫（默认）：能力驱动的复核 → 强制审批。
 *   1. `screenToolCall`：概率层初筛 + 主模型复核（按能力取负载，与工具名无关）
 *   2. `reviewSequence`：确定性层跨调用链路复核（I4；不受概率层开关影响）
 * 任一升级 → 强制审批（WS 客户端 15s 内确认，无订阅者 fail-closed 自动拒绝）。
 * 懒加载 import 避免 registry 在启动早期拉入 router 依赖链。
 */
async function defaultToolGuard(
  toolName: string,
  capability: readonly Capability[],
  args: Record<string, unknown>,
  payloadFields?: PayloadFields,
): Promise<void> {
  // ── ⓪ 执行模式门控（审计 O1，2026-08-25）──
  // Plan 封禁无条件生效（blockedTools/破坏性/未分类工具直接拒绝）；YOLO 直通；
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

  // ── ① 派发前裁决：目标负载的取法与判法全部在判定内核（permissions.ts），本层不持有任何清单 ──
  // 原实现在这里挂了两张**字段名**表（/command|script|cmd/i 与 30 个路径键名的正则），
  // 于是把 `path` 改名成 `vault_path` 就能让同一次写入脱离派发前判定 —— 与 G1 的
  // "改名脱离工具名表"同构，只是这次漏的是参数。现在：
  //   路径/URL 由值形态认出（改名不脱管）；命令由注册处声明（散文与命令行不可区分，不能猜）。
  // 权威判定仍在实际 I/O 点（src/utils/safe-fs.ts，I2），本层只拦派发前的明显越界。
  const adjudicated = adjudicateCallPayloads({
    capabilities: capability,
    args,
    principal: "tool:" + toolName,
    payloadFields,
  });
  if (!adjudicated.allow) {
    throw new Error("[HardFloor] " + (adjudicated.reason ?? "denied") + " (tool=" + toolName + ")");
  }

  // ── ② 能力驱动的双层复核 + 跨调用序列复核（I4：单调用看不出链式提权）──
  const { screenToolCall, reviewSequence } = await import("../agents/risk-monitor.js");
  const call = { capabilities: capability, args, toolName, payloadFields };
  const screened = await screenToolCall(call);
  const sequenced = await reviewSequence(call);
  if (screened !== "require-approval" && sequenced !== "require-approval") return;
  const { getApprovalBridge } = await import("../utils/approval-bridge.js");
  const approved = await getApprovalBridge().request(toolName, args, {
    risk: "destructive",
    timeoutMs: 15000,
  });
  if (!approved) {
    throw new Error(`[RiskMonitor] 复核判定为高危操作且未获批准，已阻止执行: ${toolName}`);
  }
}

/**
 * 声明可裁决门（S-8）。命令类目标无法由值形态认出 —— 散文与命令行不可区分
 * （`snapshot_create` 的 `message`、git 提交说明都是反例），所以声明 `proc.exec` 的工具
 * 必须自己说明目标在哪个入参，或显式声明 "fixed"（目标由实现固定，入参里没有可裁决对象）。
 * 声明的字段名必须是 schema 里真实存在的属性：拼错的声明等于没有声明，
 * 宁可启动期抛错，也不要运行时静默不检查。
 */
export function checkPayloadDeclaration(tool: ToolDef): string | null {
  for (const capability of tool.capability) {
    if (!CAPABILITY_PAYLOAD[capability]?.declaredTargetRequired) continue;
    const declared = tool.payloadFields?.[capability];
    if (declared === undefined) {
      return `工具 '${tool.name}' 声明 ${capability} 但未声明 payloadFields.${capability}：派发前无从取出命令负载`;
    }
    if (declared === "fixed") continue;
    const properties = schemaPropertyNames(tool.inputSchema);
    const unknown = properties && properties.length > 0
      ? declared.filter((field) => !properties.includes(field))
      : [];
    if (unknown.length > 0) {
      return `工具 '${tool.name}' 的 payloadFields.${capability} 引用了 schema 里不存在的入参：${unknown.join(", ")}`;
    }
  }
  return null;
}

/** inputSchema → 属性名；schema 不枚举属性（外部 MCP 透传等）时返回 null = 不可核 */
function schemaPropertyNames(inputSchema: unknown): string[] | null {
  const json = zodToJsonSchema(inputSchema) as { properties?: Record<string, unknown> };
  const props = json?.properties;
  return props && typeof props === "object" ? Object.keys(props) : null;
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
    // I1：能力必须显式声明。空数组等同于未声明 —— 不允许用"什么都不需要"蒙过守卫。
    if (!Array.isArray(tool.capability) || tool.capability.length === 0) {
      throw new Error(
        `[ToolRegistry] 工具 '${tool.name}' 未声明 capability：无声明即不可注册（S3 / I1）`,
      );
    }
    if (this.tools.some((t) => t.name === tool.name)) {
      logger.warn(`[ToolRegistry] tool "${tool.name}" already registered, skipping duplicate add`);
      return this;
    }
    // I1 的另一半：声明了能力还得说清"目标在哪个入参"，否则该声明不可裁决（S-8）
    const declarationIssue = checkPayloadDeclaration(tool);
    if (declarationIssue) {
      throw new Error(`[ToolRegistry] ${declarationIssue}：声明不可裁决即不可注册（S3 / S-8）`);
    }
    const guard = this.guard;
    const capability = tool.capability;
    const payloadFields = tool.payloadFields;
    const exposures: ToolExposure[] = tool.exposure?.length ? [...tool.exposure] : ["internal"];
    const wrapped: ToolDef = {
      ...tool,
      exposure: exposures,
      handler: async (args: Record<string, unknown>) => {
        await guard(tool.name, capability, args, payloadFields);
        return tool.handler(args);
      },
    };
    this.tools.push(wrapped);
    return this;
  }

  /** 已注册工具声明的能力（未注册返回空数组） */
  getCapabilities(name: string): readonly Capability[] {
    return this.tools.find((t) => t.name === name)?.capability ?? [];
  }

  /** 按名派发执行（守卫已包裹在 handler 上）。工具面对象上的 handler 不得被外部直接调用。
   *  async：返回类型是 Promise，未知名字也必须以 rejection 呈现，不得同步抛出。 */
  async execute(name: string, args: Record<string, unknown>): Promise<unknown> {
    const tool = this.tools.find((t) => t.name === name);
    if (!tool) throw new Error(`[ToolRegistry] Unknown tool: ${name}`);
    return tool.handler(args);
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
          // success:false 是调用方唯一能识别"这次没执行"的字段：守卫拒绝（HardFloor /
          // 复核未获批 / 审批超时）以 throw 呈现，若只回 {error,message}，只判
          // result.success 的场景与认知管道会把拒绝读成成功（R2-E）
          return {
            success: false,
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
