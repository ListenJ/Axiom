import { describe, test, expect } from 'bun:test'
import {
  publicToolName,
  matchTool,
  DEFAULT_KB_FILTER,
  extractText,
  toToolDefinition,
  type McpToolMeta,
} from '../src/mcp-bridge.js'

const OPTS = {
  command: 'bun',
  args: ['backend/server.js', '--stdio'],
  cwd: process.cwd(),
  serverName: 'kb',
  toolCallTimeoutMs: 5000,
  toolFilter: DEFAULT_KB_FILTER,
}

describe('publicToolName（kb 前缀）', () => {
  test('干净名字 → kb__<tool>', () => {
    expect(publicToolName('kb', 'memory_search')).toBe('kb__memory_search')
    expect(publicToolName('kb', 'kg_search')).toBe('kb__kg_search')
    expect(publicToolName('kb', 'kal_query')).toBe('kb__kal_query')
  })
  test('非法字符替换为 _ 并追加哈希（防塌缩）', () => {
    const name = publicToolName('kb', 'vault search/2')
    expect(name.startsWith('kb__vault_search_2_')).toBe(true)
    expect(name.length).toBeLessThanOrEqual(64)
  })
  test('超长截断且追加哈希，不同身份不塌缩', () => {
    const longA = 'a'.repeat(80)
    const longB = 'b'.repeat(80)
    const na = publicToolName('kb', longA)
    const nb = publicToolName('kb', longB)
    expect(na.length).toBeLessThanOrEqual(64)
    expect(na).not.toBe(nb)
  })
  test('不同 serverName 不塌缩', () => {
    expect(publicToolName('kb', 'memory_search')).not.toBe(publicToolName('dre', 'memory_search'))
  })
})

describe('matchTool / DEFAULT_KB_FILTER（白名单）', () => {
  test('默认白名单覆盖 KB 全部能力面（记忆 + 图谱）', () => {
    const cases: Array<[string, boolean]> = [
      ['memory_search', true],
      ['memory_read', true],
      ['memory_write', true],
      ['memory_atomic', true],
      ['memory_browse', true],
      ['memory_network', true],
      ['memory_stats', true],
      ['code_index', true],
      ['kg_search', true],
      ['kg_add_node', true],
      ['kg_graph', true],
      ['kg_nl_query', true],
      ['kal_query', true],
      ['kal_references', true],
      ['dip_ingest_document', true],
      ['dip_query_ast', true],
      // 非 KB 族必须被过滤
      ['web_search', false],
      ['web_fetch', false],
      ['search_engines_list', false],
      ['dre_status', false],
      ['github_create_pr', false],
      ['token_stats', false],
      ['browser_launch', false],
    ]
    for (const [name, expected] of cases) {
      expect(matchTool(name, DEFAULT_KB_FILTER), name).toBe(expected)
    }
  })
  test('自定义 filter 支持前缀与全名', () => {
    const f = ['memory_', 'code_index']
    expect(matchTool('memory_write', f)).toBe(true)
    expect(matchTool('code_index', f)).toBe(true)
    expect(matchTool('kg_search', f)).toBe(false)
    expect(matchTool('code_index_x', f)).toBe(false) // 全名不做前缀匹配
  })
})

describe('extractText', () => {
  test('提取 text 块', () => {
    const content = [
      { type: 'text', text: 'a' },
      { type: 'image', data: 'x' },
      { type: 'text', text: 'b' },
    ]
    expect(extractText(content, 'memory_stats')).toBe('a\nb')
  })
  test('无 text 块时给出占位', () => {
    expect(extractText([{ type: 'resource', data: 'x' }], 'memory_stats')).toContain('(no text content)')
    expect(extractText(null, 'memory_stats')).toContain('no text content')
  })
})

describe('toToolDefinition', () => {
  test('名称/描述/参数透传，execute 未连接时抛错', async () => {
    const tool: McpToolMeta = {
      name: 'memory_stats',
      description: 'Vault 记忆库统计',
      inputSchema: { type: 'object', properties: {} },
    }
    const def = toToolDefinition(tool, OPTS, () => null)
    expect(def.name).toBe('kb__memory_stats')
    expect(def.description).toBe('Vault 记忆库统计')
    await expect(def.execute({})).rejects.toThrow('not connected')
  })
  test('render 输出纯文本', () => {
    const tool: McpToolMeta = { name: 'kg_stats' }
    const def = toToolDefinition(tool, OPTS, () => null)
    const rendered = def.output.render?.({}, { content: [{ type: 'text', text: '{"nodes":1}' }] })
    expect(rendered).toEqual([{ type: 'text', text: '{"nodes":1}' }])
  })
})
