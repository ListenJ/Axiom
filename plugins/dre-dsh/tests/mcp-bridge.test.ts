import { describe, test, expect } from 'bun:test'
import {
  publicToolName,
  matchTool,
  applySynapseGate,
  DEFAULT_DRE_FILTER,
  extractText,
  toToolDefinition,
  type McpToolMeta,
} from '../src/mcp-bridge.js'

const OPTS = {
  command: 'bun',
  args: ['run', 'src/mcp/server.ts', '--stdio'],
  cwd: process.cwd(),
  serverName: 'dre',
  toolCallTimeoutMs: 5000,
}

describe('publicToolName（dre 前缀）', () => {
  test('干净名字 → dre__<tool>', () => {
    expect(publicToolName('dre', 'dre_status')).toBe('dre__dre_status')
    expect(publicToolName('dre', 'cognitive_loop')).toBe('dre__cognitive_loop')
  })
  test('非法字符替换为 _ 并追加哈希（防塌缩）', () => {
    const name = publicToolName('dre', 'vault search/2')
    expect(name.startsWith('dre__vault_search_2_')).toBe(true)
    expect(name.length).toBeLessThanOrEqual(64)
  })
  test('超长截断且追加哈希，不同身份不塌缩', () => {
    const longA = 'a'.repeat(80)
    const longB = 'b'.repeat(80)
    const na = publicToolName('dre', longA)
    const nb = publicToolName('dre', longB)
    expect(na.length).toBeLessThanOrEqual(64)
    expect(na).not.toBe(nb)
  })
  test('不同 serverName 不塌缩', () => {
    expect(publicToolName('dre', 'dre_status')).not.toBe(publicToolName('axiom', 'dre_status'))
  })
})

describe('matchTool / DEFAULT_DRE_FILTER（白名单）', () => {
  test('默认白名单覆盖 DRE 全部能力面', () => {
    const cases: Array<[string, boolean]> = [
      ['dre_write_knowledge', true],
      ['dre_status', true],
      ['dre_constraint_inject', true],
      ['cognitive_loop', true],
      ['cognitive_state', true],
      ['cognitive_pipeline_run_full', true],
      ['reasoning_build', true],
      ['reasoning_fill_gap', true],
      ['constraint_check', true],
      ['constraint_select_best', true],
      ['actor_list', true],
      ['actor_send', true],
      ['mental_model_match', true],
      ['mind_synapse_activate', true],
      ['mind_synapse_verify', true],
      ['mind_suggest', true],
      ['task_graph_execute', true],
      // 非 DRE 族必须被过滤
      ['web_search', false],
      ['memory_write', false],
      ['github_create_pr', false],
      ['token_stats', false],
      ['kg_search', false],
      ['browser_launch', false],
    ]
    for (const [name, expected] of cases) {
      expect(matchTool(name, DEFAULT_DRE_FILTER), name).toBe(expected)
    }
  })
  test('自定义 filter 支持前缀与全名', () => {
    const f = ['dre_', 'task_graph_execute']
    expect(matchTool('dre_read_knowledge', f)).toBe(true)
    expect(matchTool('task_graph_execute', f)).toBe(true)
    expect(matchTool('cognitive_loop', f)).toBe(false)
    expect(matchTool('task_graph_x', f)).toBe(false) // 全名不做前缀匹配
  })
  test('synapseEnabled=false 剔除突触', () => {
    const gated = applySynapseGate(DEFAULT_DRE_FILTER, false)
    expect(gated).not.toContain('mind_synapse_')
    expect(gated).not.toContain('mind_suggest')
    expect(matchTool('mind_synapse_create', gated)).toBe(false)
    expect(matchTool('dre_write_knowledge', gated)).toBe(true)
    expect(applySynapseGate(DEFAULT_DRE_FILTER, true)).toEqual(DEFAULT_DRE_FILTER)
  })
})

describe('extractText', () => {
  test('提取 text 块', () => {
    const content = [
      { type: 'text', text: 'a' },
      { type: 'image', data: 'x' },
      { type: 'text', text: 'b' },
    ]
    expect(extractText(content, 'dre_status')).toBe('a\nb')
  })
  test('无 text 块时给出占位', () => {
    expect(extractText([{ type: 'resource', data: 'x' }], 'dre_status')).toContain('(no text content)')
    expect(extractText(null, 'dre_status')).toContain('no text content')
  })
})

describe('toToolDefinition', () => {
  test('名称/描述/参数透传，execute 未连接时抛错', async () => {
    const tool: McpToolMeta = {
      name: 'dre_status',
      description: 'DRE 引擎状态',
      inputSchema: { type: 'object', properties: {} },
    }
    const def = toToolDefinition(tool, OPTS, () => null)
    expect(def.name).toBe('dre__dre_status')
    expect(def.description).toBe('DRE 引擎状态')
    await expect(def.execute({})).rejects.toThrow('not connected')
  })
  test('render 输出纯文本', () => {
    const tool: McpToolMeta = { name: 'dre_status' }
    const def = toToolDefinition(tool, OPTS, () => null)
    const rendered = def.output.render?.({}, { content: [{ type: 'text', text: '{"ok":true}' }] })
    expect(rendered).toEqual([{ type: 'text', text: '{"ok":true}' }])
  })
})
