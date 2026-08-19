/**
 * axiom-dre-dsh —— Axiom 确定性推理引擎（DRE）作为 DeepSeek Harness 的独立插件。
 *
 * 插件装载后提供：
 *  1. MCP 工具桥：以 stdio 拉起 Axiom MCP 服务器，按 DRE 白名单（三段甄别知识验证 /
 *     确定性认知闭环 / 推理图 / 约束求解 / Actor / 心智模型 / 突触记忆）过滤，
 *     以 `dre__<tool>` 注册进 dsh（默认开启）。
 *  2. `dre_plugin_status` 诊断工具（始终可用）：桥连接状态 + 引擎状态 + 生效配置摘要。
 *  3. 生命周期：`ctx.effect` 清理（卸载工具 / 关闭 transport），支持 dsh 热卸载。
 *
 * 配置经 cordis.patch.yml 行 id `dre` 覆盖；Axiom 仓库根见 config.ts。
 * 与单块插件 axiom-dsh 的区别：本插件只暴露 DRE 能力面，前缀为 dre__。
 */
import { mkdirSync } from 'node:fs'
import { normalizeConfig, configSummary, type NormalizedConfig } from './config.js'
import { createMcpBridge, DEFAULT_DRE_FILTER, applySynapseGate, type McpBridge } from './mcp-bridge.js'
import type { DshContext, DshToolDefinition } from './types.js'

export const name = 'dre'
/** 必需服务：tools。 */
export const inject = ['tools']

/** 计算生效白名单：config.toolFilter（非空时完全替换默认）→ synapseEnabled 门控。 */
function resolveToolFilter(config: NormalizedConfig): string[] {
  const base = config.toolFilter.length > 0 ? config.toolFilter : DEFAULT_DRE_FILTER
  return applySynapseGate(base, config.synapseEnabled)
}

/** 构造始终可用的插件诊断工具。 */
function makeStatusTool(getState: () => Record<string, unknown>): DshToolDefinition {
  return {
    name: 'dre_plugin_status',
    description: 'axiom-dre-dsh 插件运行状态：MCP 桥（dre__* 工具数）、Axiom 引擎状态与生效配置（诊断用）。',
    parameters: { type: 'object', properties: {} },
    output: {
      schema: { type: 'object', properties: {}, additionalProperties: false },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    execute: async () => getState(),
  }
}

export function apply(ctx: DshContext, rawConfig: unknown): Promise<void> | void {
  const config = normalizeConfig(rawConfig, import.meta.url)
  let bridge: McpBridge | null = null
  const toolFilter = resolveToolFilter(config)

  // ── 1) DRE 工具桥（默认开启） ──
  if (config.mcpEnabled) {
    // 后端选择：axiomHome 指向有效 Axiom 仓库 → 外部后端（cwd=axiomHome）；
    // 否则 → 插件内置后端（bun build 产物 backend/server.js，cwd=dataDir，自动创建）。
    const backendCwd = config.homeCheck.ok ? config.axiomHome : config.dataDir
    if (!config.homeCheck.ok) {
      mkdirSync(config.dataDir, { recursive: true })
    }
    ctx.logger?.info?.(
      '[axiom-dre-dsh] backend: ' + (config.homeCheck.ok ? 'external (' + config.axiomHome + ')' : 'built-in (' + config.mcpArgs[0] + ')'),
    )
    bridge = createMcpBridge({
      command: config.mcpCommand,
      args: config.mcpArgs,
      cwd: backendCwd,
      env: config.mcpEnv,
      serverName: config.mcpServerName,
      toolCallTimeoutMs: config.mcpToolCallTimeoutMs,
      toolFilter,
    })
    const connectPromise = bridge.connect(ctx)
    if (config.mcpFailOnStartupError) {
      // 初始连接失败即让 fiber 失败（严格模式）
      return connectPromise.then(
        () => registerStatusAndEffect(ctx, config, () => bridge, toolFilter),
        (err) => {
          ctx.logger?.error?.('[axiom-dre-dsh] mcpFailOnStartupError=true, bridge failed', err)
          throw err
        },
      )
    }
    connectPromise.catch((err) => {
      ctx.logger?.warn?.('[axiom-dre-dsh] MCP bridge failed (tolerant mode)', err)
    })
  }

  registerStatusAndEffect(ctx, config, () => bridge, toolFilter)
  ctx.logger?.info?.(`[axiom-dre-dsh] DRE filter: ${toolFilter.join(', ') || '(none)'}`)
}

/** 注册诊断工具 + 生命周期清理。 */
function registerStatusAndEffect(
  ctx: DshContext,
  config: NormalizedConfig,
  getBridge: () => McpBridge | null,
  toolFilter: string[],
): void {
  ctx.tools.register(
    makeStatusTool(() => ({
      bridge: getBridge()?.status() ?? { connected: false, toolCount: 0, serverName: config.mcpServerName },
      toolFilter,
      config: configSummary(config),
    })),
  )
  ctx.effect(() => {
    return () => {
      getBridge()?.dispose()
    }
  })
}
