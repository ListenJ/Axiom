/**
 * axiom-dsh 配置解析 —— 纯函数，便于单元测试。
 *
 * 所有可调项都有默认值；dsh 侧可经 cordis.patch.yml 或 $DSH_HOME/cordis.patch.yml
 * 按行 id `axiom` 覆盖整段 config。Axiom 仓库根目录解析顺序：
 * config.axiomHome → 环境变量 AXIOM_HOME → 相对本插件源码/产物上溯 3 层。
 */
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export interface AxiomPluginConfig {
  /** Axiom 仓库根目录（含 src/main.ts 与 src/mcp/server.ts）。 */
  axiomHome: string
  /** 是否拉起 Axiom MCP 服务器（stdio）并把工具桥接进 dsh。 */
  mcpEnabled: boolean
  mcpCommand: string
  mcpArgs: string[]
  mcpEnv: Record<string, string>
  /** MCP 工具公开名前缀（axiom__<tool>）。 */
  mcpServerName: string
  mcpToolCallTimeoutMs: number
  /** 初始连接/工具同步失败时是否让插件 fiber 失败（默认容忍并记录）。 */
  mcpFailOnStartupError: boolean
  /** 是否自动拉起 Axiom HTTP 服务器（OpenAI-compat 路由 / 统计 / /axiom 代理）。 */
  autoStartServer: boolean
  serverCommand: string
  serverArgs: string[]
  serverPort: number
  serverStartTimeoutMs: number
  serverHealthPath: string
  serverApiKey: string
  serverEnv: Record<string, string>
  proxyEnabled: boolean
  proxyPath: string
  /** 是否启用磨砂玻璃主题（透明度分层 + backdrop-filter 磨砂效果）。 */
  frostedGlass: boolean
}

export interface NormalizedConfig extends AxiomPluginConfig {
  /** 校验 Axiom 仓库根是否包含必需入口。 */
  homeCheck: { ok: boolean; missing: string[] }
}

const DEFAULT_SERVER_PORT = 18789
const DEFAULT_MCP_TOOL_TIMEOUT_MS = 60_000
const DEFAULT_SERVER_START_TIMEOUT_MS = 30_000

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
  // 源码布局 plugins/dsh/src、产物布局 plugins/dsh/lib → 仓库根 = 上溯 3 层
  const here = fileURLToPath(importMetaUrl)
  return path.resolve(path.dirname(here), '..', '..', '..')
}

/** 规范化代理前缀：保证以 / 开头、无尾部斜杠。 */
export function normalizeProxyPath(v: unknown): string {
  const raw = str(v, '/axiom')
  const withSlash = raw.startsWith('/') ? raw : `/${raw}`
  return withSlash.replace(/\/+$/, '') || '/'
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
    mcpServerName: str(cfg.mcpServerName, 'axiom'),
    mcpToolCallTimeoutMs: num(cfg.mcpToolCallTimeoutMs, DEFAULT_MCP_TOOL_TIMEOUT_MS),
    mcpFailOnStartupError: bool(cfg.mcpFailOnStartupError, false),
    autoStartServer: bool(cfg.autoStartServer, false),
    serverCommand: str(cfg.serverCommand, 'bun'),
    serverArgs: strArr(cfg.serverArgs, ['run', 'src/main.ts']),
    serverPort: num(cfg.serverPort, DEFAULT_SERVER_PORT),
    serverStartTimeoutMs: num(cfg.serverStartTimeoutMs, DEFAULT_SERVER_START_TIMEOUT_MS),
    serverHealthPath: str(cfg.serverHealthPath, '/health'),
    serverApiKey: str(cfg.serverApiKey, ''),
    serverEnv: strDict(cfg.serverEnv, {}),
    proxyEnabled: bool(cfg.proxyEnabled, true),
    proxyPath: normalizeProxyPath(cfg.proxyPath),
    frostedGlass: bool(cfg.frostedGlass, true),
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
    autoStartServer: config.autoStartServer,
    serverPort: config.serverPort,
    proxyEnabled: config.proxyEnabled,
    proxyPath: config.proxyPath,
    frostedGlass: config.frostedGlass,
  }
}

