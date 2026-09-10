import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, test, expect } from 'bun:test'
import { normalizeConfig, resolvePluginRoot, configSummary } from '../src/config.js'

const HERE = 'file:///C:/repo/plugins/kb-dsh/src/index.ts'

describe('resolvePluginRoot', () => {
  test('源码布局 plugins/kb-dsh/src → 上溯 1 层', () => {
    const root = resolvePluginRoot(HERE)
    const expected = path.resolve(path.dirname(fileURLToPath(HERE)), '..')
    expect(root).toBe(expected)
  })
})

describe('normalizeConfig', () => {
  test('缺省值完整且可运行（kb 前缀 + KB 默认白名单）', () => {
    const c = normalizeConfig({}, HERE)
    expect(c.mcpEnabled).toBe(true)
    expect(c.mcpCommand).toBe('bun')
    expect(c.mcpServerName).toBe('kb')
    expect(c.mcpToolCallTimeoutMs).toBe(60_000)
    expect(c.mcpFailOnStartupError).toBe(false)
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
    expect(c.mcpServerName).toBe('kb')
  })
  test('toolFilter 显式提供时保留（前缀/全名混合）', () => {
    const c = normalizeConfig({ toolFilter: ['memory_', 'code_index', 'web_'] }, HERE)
    expect(c.toolFilter).toEqual(['memory_', 'code_index', 'web_'])
  })
  test('toolFilter 非字符串数组时回退空数组', () => {
    const c = normalizeConfig({ toolFilter: ['memory_', 42] }, HERE)
    expect(c.toolFilter).toEqual([])
  })
  test('mcpEnv 保留字符串值并过滤非字符串', () => {
    const c = normalizeConfig({ mcpEnv: { OBSIDIAN_VAULT_PATH: 'D:/vault', BAD: 42 } }, HERE)
    expect(c.mcpEnv).toEqual({ OBSIDIAN_VAULT_PATH: 'D:/vault' })
  })
  test('configSummary 不含密钥类字段且含关键诊断字段', () => {
    const c = normalizeConfig({ mcpEnv: { OBSIDIAN_API_TOKEN: 'sk-secret' }, toolFilter: ['memory_'] }, HERE)
    const summary = JSON.stringify(configSummary(c))
    expect(summary).not.toContain('sk-secret')
    const s = configSummary(c)
    expect(s.mcpServerName).toBe('kb')
    expect(s.toolFilter).toEqual(['memory_'])
    expect(s.mcpEnabled).toBe(true)
  })
})
