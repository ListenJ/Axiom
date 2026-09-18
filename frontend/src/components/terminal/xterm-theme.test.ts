/**
 * xterm 主题构建测试
 *
 * buildTerminalTheme 从注入的 CSS 变量解析器读取前端设计令牌，
 * 映射为 xterm ITheme（foreground=--text、cursor=--accent 等），
 * 保证终端配色与 Ember 主题、底栏视觉一致。
 */
import { describe, expect, it } from 'vitest'
import { buildTerminalTheme, type CssVarReader } from './xterm-theme'

const DARK_VARS: Record<string, string> = {
  '--text': '#f3ede4',
  '--text-muted': '#9a8f7d',
  '--accent': '#f59e0b',
  '--accent-strong': '#fbbf24',
  '--on-accent': '#1a1206',
  '--border': '#2a241b',
  '--bg-secondary': '#171410',
  '--danger': '#f87171',
  '--success': '#34d399',
  '--warning': '#fcd34d',
  '--info': '#38bdf8',
}

function readerOf(vars: Record<string, string>): CssVarReader {
  return (name: string) => vars[name] ?? null
}

describe('buildTerminalTheme', () => {
  it('前景/光标/选中色映射设计令牌', () => {
    const t = buildTerminalTheme(readerOf(DARK_VARS))
    expect(t.foreground).toBe('#f3ede4')
    expect(t.cursor).toBe('#f59e0b')
    expect(t.cursorAccent).toBe('#1a1206')
    expect(t.selectionBackground).toContain('245, 158, 11') // accent 的 rgba 形式
  })

  it('ANSI 色板与语义色一致（danger=red 系、success=green 系、warning=yellow、info=blue）', () => {
    const t = buildTerminalTheme(readerOf(DARK_VARS))
    expect(t.red).toBe('#f87171')
    expect(t.green).toBe('#34d399')
    expect(t.yellow).toBe('#fcd34d')
    expect(t.blue).toBe('#38bdf8')
  })

  it('缺变量时优雅降级（返回 null 不抛错）', () => {
    const t = buildTerminalTheme(readerOf({}))
    expect(t.foreground).toBeDefined()
  })

  it('light 主题变量同样生效', () => {
    const light = buildTerminalTheme(
      readerOf({ ...DARK_VARS, '--text': '#111827', '--accent': '#d97706' }),
    )
    expect(light.foreground).toBe('#111827')
    expect(light.cursor).toBe('#d97706')
  })
})
