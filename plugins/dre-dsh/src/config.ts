/**
 * axiom-dre-dsh 配置解析 —— 纯函数，便于单元测试。
 *
 * 所有可调项都有默认值；dsh 侧可经 cordis.patch.yml 或 $DSH_HOME/cordis.patch.yml
 * 按行 id `dre` 覆盖整段 config。插件始终使用内置后端（DRE 引擎 + MCP 服务器，
 * backend/server.js，Bun 单文件构建），数据目录默认 <插件>/data 并自动创建。
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export interface AxiomDreConfig {
  /** 后端数据目录（SQLite/记忆落盘）；默认 <插件>/data，自动创建。 */
  dataDir: string
  /** 是否拉起内置 DRE 后端（stdio）并桥接 DRE 白名单工具。 */
  mcpEnabled: boolean
  mcpCommand: string
  mcpArgs: string[]
  mcpEnv: Record<string, string>
  /** MCP 工具公开名前缀（dre__<tool>）。 */
  mcpServerName: string
  mcpToolCallTimeoutMs: number
  /** 初始连接/工具同步失败时是否让插件 fiber 失败（默认容忍并记录）。 */
  mcpFailOnStartupError: boolean
  /**
   * 工具白名单：前缀（以 `_` 结尾，如 `dre_`）或全名（如 `task_graph_execute`）。
   * 空数组 = 使用内置 DRE 白名单（DEFAULT_DRE_FILTER）。
   */
  toolFilter: string[]
  /** false 时剔除突触工具（mind_synapse_* 与 mind_suggest）。 */
  synapseEnabled: boolean
}

export type NormalizedConfig = AxiomDreConfig

const DEFAULT_MCP_TOOL_TIMEOUT_MS = 60_000

/** 字符串归一化：非空字符串取 trim，否则用默认值。 */
function str(v: unknown, d: string): string {
  return typeof v === 'string' && v.trim().length > 0 ? v.trim() : d
}
/** 布尔归一化：仅接受真实布尔值，否则用默认值。 */
function bool(v: unknown, d: boolean): boolean {
  return typeof v === 'boolean' ? v : d
}
/** 数值归一化：仅接受正有限数（向下取整），否则用默认值。 */
function num(v: unknown, d: number): number {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : d
}
/** 字符串数组归一化：仅接受非空纯字符串数组，否则用默认值。 */
function strArr(v: unknown, d: string[]): string[] {
  return Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === 'string') ? (v as string[]) : d
}
/** 字符串字典归一化：仅保留字符串值，过滤其余类型，否则用默认值。 */
function strDict(v: unknown, d: Record<string, string>): Record<string, string> {
  if (v && typeof v === 'object') {
    const out: Record<string, string> = {}
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (typeof val === 'string') out[k] = val
    }
    return out
  }
  return d
}

/** 解析插件根目录：源码布局 plugins/dre-dsh/src、产物布局 plugins/dre-dsh/lib → 上溯 1 层。 */
export function resolvePluginRoot(importMetaUrl: string): string {
  const here = fileURLToPath(importMetaUrl)
  return path.resolve(path.dirname(here), '..')
}

/** 归一化插件配置（所有字段带默认值）。 */
export function normalizeConfig(raw: unknown, importMetaUrl: string): NormalizedConfig {
  const cfg = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const pluginRoot = resolvePluginRoot(importMetaUrl)
  const dataDir = str(cfg.dataDir, path.join(pluginRoot, 'data'))
  return {
    dataDir,
    mcpEnabled: bool(cfg.mcpEnabled, true),
    mcpCommand: str(cfg.mcpCommand, 'bun'),
    // 默认拉起插件内置后端（DRE 引擎 + MCP 服务器，bun build 产物）
    mcpArgs: strArr(cfg.mcpArgs, [path.join(pluginRoot, 'backend', 'server.js'), '--stdio']),
    mcpEnv: strDict(cfg.mcpEnv, {}),
    mcpServerName: str(cfg.mcpServerName, 'dre'),
    mcpToolCallTimeoutMs: num(cfg.mcpToolCallTimeoutMs, DEFAULT_MCP_TOOL_TIMEOUT_MS),
    mcpFailOnStartupError: bool(cfg.mcpFailOnStartupError, false),
    toolFilter: Array.isArray(cfg.toolFilter) && cfg.toolFilter.every((x) => typeof x === 'string')
      ? (cfg.toolFilter as string[])
      : [],
    synapseEnabled: bool(cfg.synapseEnabled, true),
  }
}

/** 给状态工具用的配置摘要（不含密钥）。 */
export function configSummary(config: NormalizedConfig): Record<string, unknown> {
  return {
    dataDir: config.dataDir,
    mcpEnabled: config.mcpEnabled,
    mcpServerName: config.mcpServerName,
    mcpToolCallTimeoutMs: config.mcpToolCallTimeoutMs,
    synapseEnabled: config.synapseEnabled,
    toolFilter: config.toolFilter,
  }
}
