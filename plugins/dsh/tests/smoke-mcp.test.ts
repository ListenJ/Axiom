/**
 * 真实冒烟：以 stdio 拉起 Axiom MCP 服务器并桥接工具。
 *
 * 需要仓库根可运行 bun + Axiom src/mcp/server.ts（本仓库即满足）。
 * 若环境不允许（无 bun / MCP 启动失败），测试跳过而非失败。
 */
import { describe, test, expect } from 'bun:test'
import path from 'node:path'
import { createMcpBridge } from '../src/mcp-bridge.js'
import type { DshToolDefinition } from '../src/types.js'

const REPO = path.resolve(import.meta.dir, '..', '..', '..')

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
        // 回归：真实调用桥接工具，输出必须是 lossless JSON（修复
        // axiom__* 全量 "value is not lossless JSON" 报错）。
        const fsList = registered.find((t) => t.name === 'axiom__fs_list')
        expect(fsList).toBeDefined()
        const value = await fsList!.execute({ path: 'D:/openclaw-fusion' }, {})
        expect(JSON.parse(JSON.stringify(value))).toEqual(value)
      } finally {
        bridge.dispose()
      }
    },
    { timeout: 120_000 },
  )
})

