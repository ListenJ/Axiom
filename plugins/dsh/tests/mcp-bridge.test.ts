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

