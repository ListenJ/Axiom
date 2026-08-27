/**
 * xterm 主题构建 —— 从前端设计令牌（CSS 变量）映射为 xterm ITheme。
 *
 * 深模块：小接口 buildTerminalTheme(reader)，内部把 Ember 主题的
 * --text/--accent/--border/语义色映射为终端前景、光标、ANSI 色板，
 * 保证终端与全局主题、底栏视觉一致；主题切换时调用方重建并
 * term.options.theme = ... 即可实时换肤。
 */

/** CSS 变量读取器（测试注入 fake；生产用 getComputedStyle） */
export type CssVarReader = (name: string) => string | null

/** 读取 CSS 变量值（去掉可能的前导空格） */
export function cssVarReader(root: HTMLElement = document.documentElement): CssVarReader {
  const styles = getComputedStyle(root)
  return (name: string) => {
    const v = styles.getPropertyValue(name).trim()
    return v.length > 0 ? v : null
  }
}

/** hex → rgba(r,g,b,alpha)（供 selection 使用半透明） */
function toRgba(hex: string, alpha: number): string {
  const m = hex.match(/^#?([0-9a-f]{6})$/i)
  if (!m) return hex
  const n = parseInt(m[1]!, 16)
  const r = (n >> 16) & 0xff
  const g = (n >> 8) & 0xff
  const b = n & 0xff
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

export interface TerminalTheme {
  foreground: string
  background: string
  cursor: string
  cursorAccent: string
  selectionBackground: string
  black: string
  red: string
  green: string
  yellow: string
  blue: string
  magenta: string
  cyan: string
  white: string
  brightBlack: string
  brightRed: string
  brightGreen: string
  brightYellow: string
  brightBlue: string
  brightMagenta: string
  brightCyan: string
  brightWhite: string
}

/** 构建终端主题：优先取语义色，缺省回退到中性色阶 */
export function buildTerminalTheme(reader: CssVarReader): TerminalTheme {
  const text = reader('--text') ?? '#f3ede4'
  const muted = reader('--text-muted') ?? '#9a8f7d'
  const accent = reader('--accent') ?? '#f59e0b'
  const onAccent = reader('--on-accent') ?? '#1a1206'
  const border = reader('--border') ?? '#2a241b'
  const danger = reader('--danger') ?? '#f87171'
  const success = reader('--success') ?? '#34d399'
  const warning = reader('--warning') ?? '#fcd34d'
  const info = reader('--info') ?? '#38bdf8'

  return {
    foreground: text,
    // 背景保持透明：终端面板底色由 CSS（底栏同款 bg）控制
    background: 'transparent',
    cursor: accent,
    cursorAccent: onAccent,
    selectionBackground: toRgba(accent, 0.35),
    black: border,
    red: danger,
    green: success,
    yellow: warning,
    blue: info,
    magenta: accent,
    cyan: info,
    white: text,
    brightBlack: muted,
    brightRed: danger,
    brightGreen: success,
    brightYellow: warning,
    brightBlue: info,
    brightMagenta: accent,
    brightCyan: info,
    brightWhite: text,
  }
}
