/**
 * axiom-kb-dsh —— Axiom 知识库（Vault 记忆 + 知识图谱）作为 DeepSeek Harness 的独立插件。
 *
 * 插件装载后提供：
 *  1. MCP 工具桥：以 stdio 拉起插件内置后端（Vault 记忆 + 知识图谱引擎 + MCP 服务器），
 *     按 KB 白名单（memory_/code_index/kg_/kal_/dip_ 前缀）过滤，以 `kb__<tool>`
 *     注册进 dsh（默认开启）。联网检索工具（web_*）不在此列。
 *  2. `kb_plugin_status` 诊断工具（始终可用）：桥连接状态 + 生效配置摘要。
 *  3. 生命周期：`ctx.effect` 清理（卸载工具 / 关闭 transport），支持 dsh 热卸载。
 *
 * 配置经 cordis.patch.yml 行 id `kb` 覆盖；数据目录见 config.ts。
 */
import { mkdirSync } from 'node:fs'
import { normalizeConfig, configSummary, type NormalizedConfig } from './config.js'
import { createMcpBridge, DEFAULT_KB_FILTER, type McpBridge } from './mcp-bridge.js'
import type { DshContext, DshToolDefinition } from './types.js'

export const name = 'kb'
/** 必需服务：tools。 */
export const inject = ['tools']

/** 计算生效白名单：config.toolFilter（非空时完全替换默认 KB 白名单）。 */
function resolveToolFilter(config: NormalizedConfig): string[] {
  return config.toolFilter.length > 0 ? config.toolFilter : DEFAULT_KB_FILTER
}

/** 构造始终可用的插件诊断工具。 */
function makeStatusTool(getState: () => Record<string, unknown>): DshToolDefinition {
  return {
    name: 'kb_plugin_status',
    description: 'axiom-kb-dsh 插件运行状态：MCP 桥（kb__* 工具数）与生效配置（诊断用）。',
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

  // ── 1) KB 工具桥（默认开启） ──
  if (config.mcpEnabled) {
    // 始终使用插件内置后端（Vault 记忆 + 知识图谱 + MCP 服务器，cwd=dataDir，自动创建）
    mkdirSync(config.dataDir, { recursive: true })
    ctx.logger?.info?.('[axiom-kb-dsh] backend: built-in (' + config.mcpArgs[0] + ')')
    bridge = createMcpBridge({
      command: config.mcpCommand,
      args: config.mcpArgs,
      cwd: config.dataDir,
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
          ctx.logger?.error?.('[axiom-kb-dsh] mcpFailOnStartupError=true, bridge failed', err)
          throw err
        },
      )
    }
    connectPromise.catch((err) => {
      ctx.logger?.warn?.('[axiom-kb-dsh] MCP bridge failed (tolerant mode)', err)
    })
  }

  registerStatusAndEffect(ctx, config, () => bridge, toolFilter)
  ctx.logger?.info?.(`[axiom-kb-dsh] KB filter: ${toolFilter.join(', ') || '(none)'}`)
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
