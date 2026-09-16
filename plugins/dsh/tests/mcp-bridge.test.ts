import { describe, test, expect } from 'bun:test'
import path from 'node:path'
import { existsSync, unlinkSync } from 'node:fs'
import { publicToolName, extractText, toToolDefinition, createMcpBridge, type McpToolMeta } from '../src/mcp-bridge.js'

const OPTS = {
  command: 'bun',
  args: ['run', 'src/mcp/server.ts'],
  cwd: process.cwd(),
  serverName: 'axiom',
  toolCallTimeoutMs: 5000,
}

describe('publicToolName', () => {
  test('干净名字原样', () => {
    expect(publicToolName('axiom', 'vault_search')).toBe('axiom__vault_search')
  })
  test('非法字符替换为 _ 并追加哈希（防塌缩）', () => {
    const name = publicToolName('axiom', 'vault search/2')
    expect(name.startsWith('axiom__vault_search_2_')).toBe(true)
    expect(name.length).toBeLessThanOrEqual(64)
  })
  test('超长截断且追加哈希，不同身份不塌缩', () => {
    const longA = 'a'.repeat(80)
    const longB = 'b'.repeat(80)
    const na = publicToolName('axiom', longA)
    const nb = publicToolName('axiom', longB)
    expect(na.length).toBeLessThanOrEqual(64)
    expect(na).not.toBe(nb)
  })
})

describe('extractText', () => {
  test('拼接 text 块', () => {
    expect(extractText([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }], 't')).toBe('a\nb')
  })
  test('无 text 块时给出占位', () => {
    expect(extractText([{ type: 'resource', resource: {} }], 't')).toContain('no text content')
    expect(extractText(null, 't')).toContain('no text content')
  })
})

describe('toToolDefinition', () => {
  test('透传 MCP schema 并渲染文本', async () => {
    const tool: McpToolMeta = {
      name: 'token_stats',
      description: '统计',
      inputSchema: { type: 'object', properties: { since: { type: 'number' } } },
    }
    const def = toToolDefinition(tool, OPTS, () => null)
    expect(def.name).toBe('axiom__token_stats')
    expect(def.parameters).toBe(tool.inputSchema as Record<string, unknown>)
    const rendered = def.output!.render!({}, { content: [{ type: 'text', text: 'hello' }] })
    expect(rendered[0].text).toBe('hello')
    await expect(def.execute({}, {})).rejects.toThrow('not connected')
  })
})

describe('createMcpBridge', () => {
  test('未连接时状态与工具数为 0，dispose 幂等', () => {
    const b = createMcpBridge(OPTS)
    expect(b.status().connected).toBe(false)
    expect(b.toolCount()).toBe(0)
    b.dispose()
    b.dispose()
  })

  test('服务器退出后自动摘工具并翻转状态（断连感知）', async () => {
    const fixture = path.resolve(import.meta.dir, 'fixtures', 'echo-mcp.mjs')
    const b = createMcpBridge({
      command: process.execPath,
      args: [fixture, '600'],
      cwd: process.cwd(),
      serverName: 'axiom',
      toolCallTimeoutMs: 5000,
    })
    const events: boolean[] = []
    const off = b.onConnectionChange((connected) => events.push(connected))
    const registrations: string[] = []
    const ctx = {
      logger: { info() {}, warn() {}, error() {} },
      tools: { register: (def: { name: string }) => { registrations.push(def.name); return () => {} } },
    }
    try {
      await b.connect(ctx as never)
      expect(b.status().connected).toBe(true)
      expect(b.toolCount()).toBe(1)
      expect(registrations).toContain('axiom__echo')
      // 等夹具服务器退出 → transport close → 桥自摘工具
      const disconnected = new Promise<void>((resolve) => {
        const tick = () => (b.status().connected ? setTimeout(tick, 100) : resolve())
        tick()
      })
      await disconnected
      expect(b.status().connected).toBe(false)
      expect(b.toolCount()).toBe(0)
      expect(events.at(-1)).toBe(false)
    } finally {
      off()
      b.dispose()
    }
  })

  test('tools/list_changed 通知触发重同步（新增工具被桥接）', async () => {
    const fixture = path.resolve(import.meta.dir, 'fixtures', 'echo-mcp.mjs')
    const registrations: string[] = []
    const b = createMcpBridge({
      command: process.execPath,
      args: [fixture, '8000', '300'],
      cwd: process.cwd(),
      serverName: 'axiom',
      toolCallTimeoutMs: 5000,
    })
    const ctx = {
      logger: { info() {}, warn() {}, error() {} },
      tools: { register: (def: { name: string }) => { registrations.push(def.name); return () => {} } },
    }
    try {
      await b.connect(ctx as never)
      expect(b.toolCount()).toBe(1)
      expect(registrations).toEqual(['axiom__echo'])
      // 夹具在 300ms 后发 list_changed 并多挂一个工具；重同步后应看到 echo2
      const deadline = Date.now() + 4000
      while (Date.now() < deadline && b.toolCount() < 2) {
        await new Promise((r) => setTimeout(r, 100))
      }
      expect(b.toolCount()).toBe(2)
      expect(registrations).toEqual(['axiom__echo', 'axiom__echo', 'axiom__echo2'])
    } finally {
      b.dispose()
    }
  })

  test('dispose 关闭 stdio 子进程（回归：teardown 先于 close 导致孤儿进程）', async () => {
    const fixture = path.resolve(import.meta.dir, 'fixtures', 'echo-mcp.mjs')
    const marker = path.resolve(import.meta.dir, '..', '.dispose-marker')
    try { unlinkSync(marker) } catch { /* 首次运行不存在 */ }
    const b = createMcpBridge({
      command: process.execPath,
      args: [fixture, '60000'],
      cwd: process.cwd(),
      serverName: 'axiom',
      toolCallTimeoutMs: 5000,
      env: { DSH_TEST_MARKER: marker },
    })
    const ctx = {
      logger: { info() {}, warn() {}, error() {} },
      tools: { register: () => () => {} },
    }
    await b.connect(ctx as never)
    expect(b.status().connected).toBe(true)
    b.dispose()
    // transport.close() 关闭 stdin → 夹具写入标记文件后退出；若 close 被跳过，标记永不出现
    const deadline = Date.now() + 4000
    while (Date.now() < deadline && !existsSync(marker)) {
      await new Promise((r) => setTimeout(r, 100))
    }
    expect(existsSync(marker)).toBe(true)
    try { unlinkSync(marker) } catch { /* 并发清理 */ }
  })

  test('dispose 不触发伪断连事件，onConnectionChange 可取消订阅', async () => {
    const fixture = path.resolve(import.meta.dir, 'fixtures', 'echo-mcp.mjs')
    const b = createMcpBridge({
      command: process.execPath,
      args: [fixture, '30000'], // 主动退出晚于本用例，只测 dispose 路径
      cwd: process.cwd(),
      serverName: 'axiom',
      toolCallTimeoutMs: 5000,
    })
    const events: boolean[] = []
    const off = b.onConnectionChange((connected) => events.push(connected))
    const ctx = {
      logger: { info() {}, warn() {}, error() {} },
      tools: { register: () => () => {} } as never,
    }
    await b.connect(ctx as never)
    expect(events.at(-1)).toBe(true)
    off()
    b.dispose()
    // dispose 后不再收到回调（订阅已取消）
    expect(events.at(-1)).toBe(true)
  })
})


describe('toToolDefinition execute — lossless JSON 输出（修复 axiom__* 的 "not lossless JSON" 报错）', () => {
  test('无 structuredContent 时省略该键，输出保持 lossless JSON', async () => {
    const tool: McpToolMeta = { name: 'fs_list', description: '列出目录', inputSchema: { type: 'object' } }
    const fakeClient = {
      request: async () => ({ content: [{ type: 'text', text: '{"ok":true}' }] }),
    }
    const def = toToolDefinition(tool, OPTS, () => fakeClient as never)
    const value = await def.execute!({ path: '.' }, {})
    // dsh 的 lossless-JSON 校验：JSON 往返后应深度相等（无 undefined/NaN/Date 等有损值）
    expect(JSON.parse(JSON.stringify(value))).toEqual(value)
    expect(value).toEqual({ content: [{ type: 'text', text: '{"ok":true}' }] })
    expect(def.output!.render!({}, value)[0].text).toBe('{"ok":true}')
  })

  test('有 structuredContent 时保留，整体仍为 lossless JSON', async () => {
    const tool: McpToolMeta = { name: 'scene_list', description: '场景列表', inputSchema: {} }
    const fakeClient = {
      request: async () => ({ content: [{ type: 'text', text: '[]' }], structuredContent: { scenes: [] } }),
    }
    const def = toToolDefinition(tool, OPTS, () => fakeClient as never)
    const value = await def.execute!({}, {})
    expect(JSON.parse(JSON.stringify(value))).toEqual(value)
    expect(value).toEqual({ content: [{ type: 'text', text: '[]' }], structuredContent: { scenes: [] } })
  })

  test('MCP isError 帧转为真实工具错误（不再当作成功文本）', async () => {
    const tool: McpToolMeta = { name: 'fs_delete', description: '删除', inputSchema: {} }
    const fakeClient = {
      request: async () => ({ content: [{ type: 'text', text: 'denied' }], isError: true }),
    }
    const def = toToolDefinition(tool, OPTS, () => fakeClient as never)
    await expect(def.execute!({ path: 'x' }, {})).rejects.toThrow('denied')
  })
})
