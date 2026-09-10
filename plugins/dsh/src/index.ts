/**
 * axiom-dsh —— Axiom AI Agent 作为 DeepSeek Harness 的完整插件。
 *
 * 插件装载后提供：
 *  1. MCP 工具桥：以 stdio 拉起 Axiom MCP 服务器，把知识库/记忆/路由/成本/
 *     提示词池等工具以 `axiom__<tool>` 注册进 dsh（默认开启）。
 *  2. 可选 Axiom HTTP 服务器：提供 OpenAI 兼容端点（/v1/chat/completions，
 *     可作 dsh LLM provider baseURL）、统计端点与 /axiom 代理（默认关闭）。
 *  3. `axiom_status` 诊断工具（始终可用）。
 *  4. 磨砂玻璃主题：通过 CSS 注入为 DSH 添加透明度分层 + backdrop-filter
 *     磨砂效果，替代硬线条分割（默认开启，frostedGlass 配置控制）。
 *
 * 配置经 cordis.patch.yml 行 id `axiom` 覆盖；Axiom 仓库根见 config.ts。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { normalizeConfig, configSummary, type NormalizedConfig } from './config.js'
import { createMcpBridge, type McpBridge } from './mcp-bridge.js'
import { startAxiomServer, createProxyHandler, type AxiomServerHandle } from './server.js'
import type { DshContext, DshToolDefinition, DshWebServerLike } from './types.js'

export const name = 'axiom'
/** 必需服务：tools。webServer 是可选的（经 ctx.inject 惰性挂载）。 */
export const inject = ['tools']

/** 加载磨砂玻璃 CSS。支持源码布局(src/)和产物布局(lib/)两种路径。 */
function loadFrostedGlassCSS(): string {
  const here = path.dirname(fileURLToPath(import.meta.url))
  // 产物布局: lib/index.js → lib/frosted-glass.css (复制) 或 ../src/frosted-glass.css
  // 源码布局: src/index.ts → src/frosted-glass.css
  const candidates = [
    path.resolve(here, 'frosted-glass.css'),       // 同目录
    path.resolve(here, '..', 'src', 'frosted-glass.css'), // 上级 src/
    path.resolve(here, '..', 'frosted-glass.css'), // 上级
  ]
  for (const p of candidates) {
    try {
      return readFileSync(p, 'utf-8')
    } catch { /* continue */ }
  }
  return ''
}

/** 注入磨砂玻璃 CSS 到浏览器。 */
function injectFrostedGlass(
  ctx: DshContext,
  css: string,
  enabled: boolean,
  disposers: Array<() => void>,
): void {
  if (!css || !enabled) return
  ctx.inject(['webServer'], (childCtx) => {
    const ws = childCtx.get?.('webServer') as DshWebServerLike | undefined
    if (!ws?.register) return
    // 通过路由注册注入 CSS，disposer 纳入生命周期清理
    disposers.push(
      ws.register({
        kind: 'prefix',
        path: '/axiom-theme',
        handler: (_req: unknown, res: unknown) => {
          const response = res as { writeHead?: (code: number, headers: Record<string, string>) => void; end?: (data: string) => void }
          response.writeHead?.(200, {
            'Content-Type': 'text/css; charset=utf-8',
            'Cache-Control': 'public, max-age=3600',
          })
          response.end?.(css)
        },
      }),
    )
  })
}

/** 构造始终可用的状态诊断工具。 */
function makeStatusTool(getState: () => Record<string, unknown>): DshToolDefinition {
  return {
    name: 'axiom_status',
    description: 'Axiom dsh 插件运行状态：MCP 桥、HTTP 服务器与生效配置（诊断用）。',
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
  const disposers: Array<() => void> = []
  let bridge: McpBridge | null = null
  let server: AxiomServerHandle | null = null
  let frostedGlassActive = config.frostedGlass
  const log = (...args: unknown[]) => ctx.logger?.info?.(...args)

  // ── 0) 磨砂玻璃主题注入 ──
  if (config.frostedGlass) {
    const css = loadFrostedGlassCSS()
    if (css) {
      injectFrostedGlass(ctx, css, true, disposers)
      log('[axiom-dsh] frosted-glass theme loaded')
    }
  }

  // ── 1) 可选 HTTP 服务器 + /axiom 代理 ──
  if (config.autoStartServer) {
    const pending = startAxiomServer(config, log)
    pending
      .then((handle) => {
        server = handle
        log(`[axiom-dsh] Axiom HTTP server ready at ${handle.url}`)
      })
      .catch((err) => {
        ctx.logger?.warn?.('[axiom-dsh] Axiom HTTP server start failed', err)
      })
    ctx.inject(['webServer'], (childCtx) => {
      const ws = childCtx.get?.('webServer') as DshWebServerLike | undefined
      if (!ws?.register || !config.proxyEnabled) return
      disposers.push(
        ws.register({
          kind: 'prefix',
          path: config.proxyPath,
          handler: createProxyHandler(config),
        }),
      )
    })
  }

  // ── 2) MCP 工具桥（默认开启） ──
  if (config.mcpEnabled) {
    bridge = createMcpBridge({
      command: config.mcpCommand,
      args: config.mcpArgs,
      cwd: config.axiomHome,
      env: config.mcpEnv,
      serverName: config.mcpServerName,
      toolCallTimeoutMs: config.mcpToolCallTimeoutMs,
    })
    const connectPromise = bridge.connect(ctx)
    if (config.mcpFailOnStartupError) {
      // 初始连接失败即让 fiber 失败（严格模式）
      return connectPromise.then(
        () => registerStatusAndEffect(ctx, config, disposers, () => bridge, () => server, () => frostedGlassActive),
        (err) => {
          ctx.logger?.error?.('[axiom-dsh] mcpFailOnStartupError=true, bridge failed', err)
          throw err
        },
      )
    }
    connectPromise.catch((err) => {
      ctx.logger?.warn?.('[axiom-dsh] MCP bridge failed (tolerant mode)', err)
    })
  }

  registerStatusAndEffect(ctx, config, disposers, () => bridge, () => server, () => frostedGlassActive)
}

/** 注册状态工具 + 生命周期清理。 */
function registerStatusAndEffect(
  ctx: DshContext,
  config: NormalizedConfig,
  disposers: Array<() => void>,
  getBridge: () => McpBridge | null,
  getServer: () => AxiomServerHandle | null,
  getFrostedGlass: () => boolean,
): void {
  ctx.tools.register(
    makeStatusTool(() => ({
      mcp: getBridge()?.status() ?? { connected: false, toolCount: 0, serverName: config.mcpServerName },
      server: getServer()?.url ?? (config.autoStartServer ? 'starting' : 'disabled'),
      frostedGlass: getFrostedGlass(),
      config: configSummary(config),
    })),
  )
  ctx.effect(() => {
    return () => {
      for (const d of disposers) {
        try {
          d()
        } catch {
          /* 清理失败不阻塞 */
        }
      }
      disposers.length = 0
      getBridge()?.dispose()
      const s = getServer()
      if (s) {
        s.stop().catch(() => {})
      }
    }
  })
}
