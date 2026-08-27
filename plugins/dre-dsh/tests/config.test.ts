import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, test, expect } from 'bun:test'
import { normalizeConfig, resolvePluginRoot, configSummary } from '../src/config.js'

const HERE = 'file:///C:/repo/plugins/dre-dsh/src/index.ts'

describe('resolvePluginRoot', () => {
  test('源码布局 plugins/dre-dsh/src → 上溯 1 层（平台无关）', () => {
    const root = resolvePluginRoot(HERE)
    const expected = path.resolve(path.dirname(fileURLToPath(HERE)), '..')
    expect(root).toBe(expected)
  })
})

describe('normalizeConfig', () => {
  test('缺省值完整且可运行（dre 前缀 + DRE 默认白名单）', () => {
    const c = normalizeConfig({}, HERE)
    expect(c.mcpEnabled).toBe(true)
    expect(c.mcpCommand).toBe('bun')
    expect(c.mcpServerName).toBe('dre')
    expect(c.mcpToolCallTimeoutMs).toBe(60_000)
    expect(c.mcpFailOnStartupError).toBe(false)
    expect(c.synapseEnabled).toBe(true)
    expect(c.toolFilter).toEqual([])
    expect(c.mcpArgs.length).toBe(2)
    expect(c.mcpArgs[1]).toBe('--stdio')
  })
  test('dataDir 默认指向 <插件根>/data', () => {
    const c = normalizeConfig({}, HERE)
    const pluginRoot = path.resolve(path.dirname(fileURLToPath(HERE)), '..')
    expect(c.dataDir).toBe(path.join(pluginRoot, 'data'))
  })
  test('数值/布尔非法时回退默认', () => {
    const c = normalizeConfig({ mcpToolCallTimeoutMs: 'abc', mcpEnabled: 'yes', mcpServerName: '' }, HERE)
    expect(c.mcpToolCallTimeoutMs).toBe(60_000)
    expect(c.mcpEnabled).toBe(true)
    expect(c.mcpServerName).toBe('dre')
  })
  test('toolFilter 显式提供时保留（前缀/全名混合）', () => {
    const c = normalizeConfig({ toolFilter: ['dre_', 'task_graph_execute', 'web_'] }, HERE)
    expect(c.toolFilter).toEqual(['dre_', 'task_graph_execute', 'web_'])
  })
  test('toolFilter 非字符串数组时回退空数组', () => {
    const c = normalizeConfig({ toolFilter: ['dre_', 42] }, HERE)
    expect(c.toolFilter).toEqual([])
  })
  test('synapseEnabled 默认 true 且可关闭', () => {
    expect(normalizeConfig({}, HERE).synapseEnabled).toBe(true)
    expect(normalizeConfig({ synapseEnabled: false }, HERE).synapseEnabled).toBe(false)
  })
  test('mcpEnv 保留字符串值并过滤非字符串', () => {
    const c = normalizeConfig({ mcpEnv: { DRE_LLM_API_KEY: 'D:/key', BAD: 42 } }, HERE)
    expect(c.mcpEnv).toEqual({ DRE_LLM_API_KEY: 'D:/key' })
  })
  test('configSummary 不含密钥类字段', () => {
    const c = normalizeConfig({ mcpEnv: { AXIOM_AUTH_TOKEN: 'sk-secret' }, serverApiKey: 'sk-secret' }, HERE)
    const summary = JSON.stringify(configSummary(c))
    expect(summary).not.toContain('sk-secret')
  })
  test('configSummary 包含关键诊断字段', () => {
    const c = normalizeConfig({ synapseEnabled: false, toolFilter: ['dre_'] }, HERE)
    const summary = configSummary(c)
    expect(summary.synapseEnabled).toBe(false)
    expect(summary.toolFilter).toEqual(['dre_'])
    expect(summary.mcpServerName).toBe('dre')
    expect(summary.dataDir).toBe(c.dataDir)
  })
})
