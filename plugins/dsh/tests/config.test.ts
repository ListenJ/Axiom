import path from 'node:path'
import { describe, test, expect } from 'bun:test'
import { normalizeConfig, resolveAxiomHome, normalizeProxyPath, checkAxiomHome, configSummary } from '../src/config.js'

const REPO = path.resolve(import.meta.dir, '..', '..', '..')
const HERE = 'file:///C:/repo/plugins/dsh/src/index.ts'

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
  test('相对插件文件上溯 3 层（源码布局）', () => {
    const home = resolveAxiomHome('', HERE)
    expect(home.replace(/\\/g, '/')).toBe('C:/repo')
  })
})

describe('normalizeProxyPath', () => {
  test('默认 /axiom', () => expect(normalizeProxyPath(undefined)).toBe('/axiom'))
  test('补前导斜杠', () => expect(normalizeProxyPath('axiom')).toBe('/axiom'))
  test('去尾部斜杠', () => expect(normalizeProxyPath('/axiom/')).toBe('/axiom'))
})

describe('normalizeConfig', () => {
  test('缺省值完整且可运行', () => {
    const c = normalizeConfig({}, HERE)
    expect(c.mcpEnabled).toBe(true)
    expect(c.mcpCommand).toBe('bun')
    expect(c.mcpServerName).toBe('axiom')
    expect(c.autoStartServer).toBe(false)
    expect(c.serverPort).toBe(18789)
    expect(c.proxyPath).toBe('/axiom')
    expect(c.mcpToolCallTimeoutMs).toBe(60_000)
    expect(c.frostedGlass).toBe(true)
    expect(Array.isArray(c.mcpArgs)).toBe(true)
  })
  test('数值/布尔非法时回退默认', () => {
    const c = normalizeConfig({ mcpToolCallTimeoutMs: 'abc', mcpEnabled: 'yes', serverPort: -1 }, HERE)
    expect(c.mcpToolCallTimeoutMs).toBe(60_000)
    expect(c.mcpEnabled).toBe(true)
    expect(c.serverPort).toBe(18789)
  })
  test('configSummary 不含密钥字段', () => {
    const c = normalizeConfig({ serverApiKey: 'sk-secret' }, HERE)
    const summary = JSON.stringify(configSummary(c))
    expect(summary).not.toContain('sk-secret')
  })
  test('frostedGlass 默认开启且可关闭', () => {
    const c1 = normalizeConfig({}, HERE)
    expect(c1.frostedGlass).toBe(true)
    const c2 = normalizeConfig({ frostedGlass: false }, HERE)
    expect(c2.frostedGlass).toBe(false)
  })
  test('configSummary 包含 frostedGlass', () => {
    const c = normalizeConfig({}, HERE)
    const summary = configSummary(c)
    expect(summary.frostedGlass).toBe(true)
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
