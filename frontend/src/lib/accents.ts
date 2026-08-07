/**
 * 强调色预设 — AXIS Monochrome：唯一“墨色”预设。
 *
 * 黑白主题下强调色 = 主题反转色（暗色 #fff / 浅色 #111），
 * 不再提供彩色预设；applyAccent 仅保证 CSS 变量与主题一致（兼容旧持久化值）。
 */

export type AccentId = 'mono'

export interface AccentVars {
  accent: string
  accentStrong: string
  accentHover: string
  accentActive: string
  accentSoft: string
  accentRing: string
  onAccent: string
  gradient: string
}

export const ACCENT_PRESETS: Record<AccentId, { label: string; dark: AccentVars; light: AccentVars }> = {
  mono: {
    label: '墨色',

    dark: {
      accent: '#ffffff', accentStrong: '#f2f2f2', accentHover: '#e6e6e6', accentActive: '#d4d4d4',
      accentSoft: 'rgba(255, 255, 255, 0.1)', accentRing: 'rgba(255, 255, 255, 0.3)',
      onAccent: '#000000', gradient: '#ffffff',
    },

    light: {
      accent: '#111111', accentStrong: '#2a2a2a', accentHover: '#333333', accentActive: '#000000',
      accentSoft: 'rgba(17, 17, 17, 0.06)', accentRing: 'rgba(17, 17, 17, 0.2)',
      onAccent: '#ffffff', gradient: '#111111',
    },
  },
}

/** 将墨色预设应用到 documentElement（保证 --accent 系列与主题一致，兼容旧持久化值）。 */
export function applyAccent(id: AccentId, theme: 'dark' | 'light'): void {
  if (typeof document === 'undefined') return
  const preset = ACCENT_PRESETS[id] ?? ACCENT_PRESETS.mono
  const vars = theme === 'dark' ? preset.dark : preset.light
  const root = document.documentElement.style
  root.setProperty('--accent', vars.accent)
  root.setProperty('--accent-strong', vars.accentStrong)
  root.setProperty('--accent-hover', vars.accentHover)
  root.setProperty('--accent-active', vars.accentActive)
  root.setProperty('--accent-soft', vars.accentSoft)
  root.setProperty('--accent-ring', vars.accentRing)
  root.setProperty('--on-accent', vars.onAccent)
  root.setProperty('--accent-gradient', vars.gradient)
}
