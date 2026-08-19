/**
 * 真实冒烟：以 stdio 拉起插件内置后端（backend/server.js，DRE 引擎 + MCP 服务器），
 * 验证 axiom-dre-dsh 只桥接 DRE 白名单工具（dre__* 前缀），且 dre__dre_status
 * 可真实调用返回 lossless JSON。自包含模式无需外部 Axiom 仓库。
 */
import { describe, test, expect } from 'bun:test'
import path from 'node:path'
import { mkdirSync } from 'node:fs'
import { apply } from '../src/index.js'
import { createMcpBridge, DEFAULT_DRE_FILTER, matchTool, type McpBridge } from '../src/mcp-bridge.js'
import type { DshToolDefinition } from '../src/types.js'

const PLUGIN = path.resolve(import.meta.dir, '..')
// 内置后端：插件 bun build 产物（DRE 引擎 + MCP 服务器），自包含
const BUILTIN_BACKEND = path.join(PLUGIN, 'backend', 'server.js')
const DATA_DIR = path.join(PLUGIN, 'data')

function makeCtx() {
  const registered: DshToolDefinition[] = []
  const ctx = {
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    tools: { register: (d: DshToolDefinition) => { registered.push(d); return () => {} } },
    effect() {},
    inject() {},
    get: () => undefined,
  }
  return { ctx, registered }
}

async function waitFor(cond: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const t0 = Date.now()
  while (!cond()) {
    if (Date.now() - t0 > timeoutMs) throw new Error(`timeout waiting: ${label}`)
    await new Promise((r) => setTimeout(r, 250))
  }
}

describe('smoke: 桥对真实 Axiom MCP 服务器的 DRE 白名单过滤', () => {
  test('只注册 dre__* 工具，且 dre__dre_status 可调用', async () => {
    const { ctx, registered } = makeCtx()
    mkdirSync(DATA_DIR, { recursive: true })
    const bridge: McpBridge = createMcpBridge({
      command: 'bun',
      args: [BUILTIN_BACKEND, '--stdio'],
      cwd: DATA_DIR,
      serverName: 'dre',
      toolCallTimeoutMs: 30_000,
      toolFilter: DEFAULT_DRE_FILTER,
    })
    try {
      await bridge.connect(ctx)
      expect(bridge.status().connected).toBe(true)
      await waitFor(() => registered.some((d) => d.name.startsWith('dre__')), 30_000, 'bridge tools registered')

      // 1) 全部注册工具都是 dre__ 前缀
      for (const d of registered) {
        expect(d.name.startsWith('dre__'), d.name).toBe(true)
      }
      // 2) 数量 > 0 且每个工具名都命中白名单
      expect(registered.length).toBeGreaterThan(0)
      for (const d of registered) {
        const raw = d.name.replace(/^dre__/, '')
        expect(matchTool(raw, DEFAULT_DRE_FILTER), raw).toBe(true)
      }
      // 3) 非 DRE 工具（如 web_search）不应出现
      expect(registered.some((d) => d.name === 'dre__web_search')).toBe(false)
      expect(registered.some((d) => d.name === 'dre__memory_write')).toBe(false)

      // 4) 真实调用 dre__dre_status，返回 lossless JSON（content 数组 + 可解析文本）
      const statusDef = registered.find((d) => d.name === 'dre__dre_status')
      expect(statusDef, 'dre__dre_status 存在').toBeDefined()
      const out = (await statusDef!.execute({})) as { content?: unknown[] }
      expect(Array.isArray(out?.content)).toBe(true)
      const text = (out.content ?? [])
        .map((b) => (b as { text?: string }).text ?? '')
        .join('\n')
        .trim()
      expect(text.length).toBeGreaterThan(0)
      // lossless JSON 契约：不得包含 structuredContent: undefined
      expect(JSON.stringify(out)).not.toContain('structuredContent: undefined')
    } finally {
      bridge.dispose()
    }
  })
})

describe('smoke: apply() 插件入口（容忍模式）', () => {
  test('注册 dre_plugin_status 诊断工具 + dre__* 桥接工具', async () => {
    const { ctx, registered } = makeCtx()
    // 自包含：不配 axiomHome，插件默认拉起内置后端
    apply(ctx, { mcpToolCallTimeoutMs: 30_000, mcpFailOnStartupError: false })
    // dre_plugin_status 同步注册
    expect(registered.some((d) => d.name === 'dre_plugin_status')).toBe(true)
    // 桥接异步完成
    await waitFor(() => registered.some((d) => d.name.startsWith('dre__')), 30_000, 'apply bridge tools')
    expect(registered.some((d) => d.name === 'dre__dre_status')).toBe(true)
    // 诊断工具可调用且无密钥
    const statusDef = registered.find((d) => d.name === 'dre_plugin_status')!
    const out = (await statusDef.execute({})) as Record<string, unknown>
    expect(out).toHaveProperty('bridge')
    expect(JSON.stringify(out)).not.toContain('sk-')
  })
})
