import { describe, test, expect } from 'bun:test'
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
