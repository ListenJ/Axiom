import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, test, expect } from 'bun:test'
import { normalizeConfig, resolveAxiomHome, checkAxiomHome, configSummary } from '../src/config.js'

const REPO = path.resolve(import.meta.dir, '..', '..', '..')
const HERE = 'file:///C:/repo/plugins/dre-dsh/src/index.ts'

describe('resolveAxiomHome', () => {
  test('explicit config 优先', () => {
    expect(resolveAxiomHome('D:/axiom', HERE)).toBe('D:/axiom')
  })
  test('env AXIOM_HOME 其次', () => {
    const old = process.env.AXIOM_HOME
    process.env.AXIOM_HOME = 'C:/axiom-home'
    try {
      expect(resolveAxiomHome('', HERE)).toBe('C:/axiom-home')
    } finally {
      if (old === undefined) delete process.env.AXIOM_HOME
      else process.env.AXIOM_HOME = old
    }
  })
  test('相对插件文件上溯 3 层（源码布局，平台无关）', () => {
    const home = resolveAxiomHome('', HERE)
    const expected = path.resolve(path.dirname(fileURLToPath(HERE)), '..', '..', '..')
    expect(home).toBe(expected)
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
    expect(Array.isArray(c.mcpArgs)).toBe(true)
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
  })
})

describe('checkAxiomHome', () => {
  test('当前仓库根有效', () => {
    const r = checkAxiomHome(REPO)
    expect(r.ok).toBe(true)
    expect(r.missing).toEqual([])
  })
  test('无效目录报告缺失', () => {
    const r = checkAxiomHome('C:/no-such-axiom-repo')
    expect(r.ok).toBe(false)
    expect(r.missing.length).toBeGreaterThan(0)
  })
})
