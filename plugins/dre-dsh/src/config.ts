/**
 * axiom-dre-dsh 配置解析 —— 纯函数，便于单元测试。
 *
 * 所有可调项都有默认值；dsh 侧可经 cordis.patch.yml 或 $DSH_HOME/cordis.patch.yml
 * 按行 id `dre` 覆盖整段 config。Axiom 仓库根目录解析顺序：
 * config.axiomHome → 环境变量 AXIOM_HOME → 相对本插件源码/产物上溯 3 层。
 */
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export interface AxiomDreConfig {
  /** Axiom 仓库根目录（含 src/main.ts 与 src/mcp/server.ts）。 */
  axiomHome: string
  /** 是否拉起 Axiom MCP 服务器（stdio）并桥接 DRE 白名单工具。 */
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

export interface NormalizedConfig extends AxiomDreConfig {
  /** 校验 Axiom 仓库根是否包含必需入口。 */
  homeCheck: { ok: boolean; missing: string[] }
}

const DEFAULT_MCP_TOOL_TIMEOUT_MS = 60_000

function str(v: unknown, d: string): string {
  return typeof v === 'string' && v.trim().length > 0 ? v.trim() : d
}
function bool(v: unknown, d: boolean): boolean {
  return typeof v === 'boolean' ? v : d
}
function num(v: unknown, d: number): number {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : d
}
function strArr(v: unknown, d: string[]): string[] {
  return Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === 'string') ? (v as string[]) : d
}
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

/** 解析 Axiom 仓库根：config → AXIOM_HOME → 相对本文件上溯 3 层。 */
export function resolveAxiomHome(explicit: unknown, importMetaUrl: string): string {
  const explicitStr = str(explicit, '')
  if (explicitStr) return explicitStr
  const envHome = process.env.AXIOM_HOME
  if (envHome && envHome.trim()) return envHome.trim()
  // 源码布局 plugins/dre-dsh/src、产物布局 plugins/dre-dsh/lib → 仓库根 = 上溯 3 层
  const here = fileURLToPath(importMetaUrl)
  return path.resolve(path.dirname(here), '..', '..', '..')
}

/** 校验 Axiom 仓库根是否包含必需入口文件。 */
export function checkAxiomHome(home: string): { ok: boolean; missing: string[] } {
  const required = ['src/main.ts', 'src/mcp/server.ts']
  const missing = required.filter((p) => !existsSync(path.join(home, p)))
  return { ok: missing.length === 0, missing }
}

/** 归一化插件配置（所有字段带默认值）。 */
export function normalizeConfig(raw: unknown, importMetaUrl: string): NormalizedConfig {
  const cfg = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const axiomHome = resolveAxiomHome(cfg.axiomHome, importMetaUrl)
  return {
    axiomHome,
    mcpEnabled: bool(cfg.mcpEnabled, true),
    mcpCommand: str(cfg.mcpCommand, 'bun'),
    mcpArgs: strArr(cfg.mcpArgs, ['run', 'src/mcp/server.ts', '--stdio']),
    mcpEnv: strDict(cfg.mcpEnv, {}),
    mcpServerName: str(cfg.mcpServerName, 'dre'),
    mcpToolCallTimeoutMs: num(cfg.mcpToolCallTimeoutMs, DEFAULT_MCP_TOOL_TIMEOUT_MS),
    mcpFailOnStartupError: bool(cfg.mcpFailOnStartupError, false),
    toolFilter: Array.isArray(cfg.toolFilter) && cfg.toolFilter.every((x) => typeof x === 'string')
      ? (cfg.toolFilter as string[])
      : [],
    synapseEnabled: bool(cfg.synapseEnabled, true),
    homeCheck: checkAxiomHome(axiomHome),
  }
}

/** 给状态工具用的配置摘要（不含密钥）。 */
export function configSummary(config: NormalizedConfig): Record<string, unknown> {
  return {
    axiomHome: config.axiomHome,
    homeOk: config.homeCheck.ok,
    homeMissing: config.homeCheck.missing,
    mcpEnabled: config.mcpEnabled,
    mcpServerName: config.mcpServerName,
    mcpToolCallTimeoutMs: config.mcpToolCallTimeoutMs,
    synapseEnabled: config.synapseEnabled,
    toolFilter: config.toolFilter,
  }
}
