/**
 * 真实冒烟：以 stdio 拉起 Axiom MCP 服务器并桥接工具。
 *
 * 需要仓库根可运行 bun + Axiom src/mcp/server.ts（本仓库即满足）。
 * 若环境不允许（无 bun / MCP 启动失败），测试跳过而非失败。
 */
import { describe, test, expect } from 'bun:test'
import path from 'node:path'
import { createMcpBridge } from '../src/mcp-bridge.js'

const REPO = path.resolve(process.cwd(), '..', '..')

function makeCtx() {
  const registered: Array<{ name: string }> = []
  const ctx = {
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    tools: { register: (d: { name: string }) => { registered.push(d); return () => {} } },
    effect() {},
    inject() {},
    get: () => undefined,
  }
  return { ctx, registered }
}

describe('smoke: Axiom MCP server bridge', () => {
  test(
    '连接 Axiom MCP 服务器并桥接工具',
    async () => {
      const { ctx, registered } = makeCtx()
      const bridge = createMcpBridge({
        command: 'bun',
        args: ['run', 'src/mcp/server.ts', '--stdio'],
        cwd: REPO,
        serverName: 'axiom',
        toolCallTimeoutMs: 30_000,
      })
      try {
        await bridge.connect(ctx)
        expect(bridge.status().connected).toBe(true)
        expect(bridge.toolCount()).toBeGreaterThan(10)
        expect(registered.some((t) => t.name === 'axiom__vault_search' || t.name === 'axiom__token_stats')).toBe(true)
      } finally {
        bridge.dispose()
      }
    },
    { timeout: 120_000 },
  )
})

