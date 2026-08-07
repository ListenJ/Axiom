/**
 * Agent 颜色预设 — 默认「墨色」（黑白主题反转），可切换为低饱和强调色。
 *
 * 选择后通过 applyAccent 覆盖 --accent 系列 CSS 变量（useTheme 应用，localStorage 持久化）。
 */

export type AccentId = 'mono' | 'azure' | 'amber' | 'emerald' | 'violet'

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

export const ACCENT_PRESETS: Record<AccentId, { label: string; swatch: string; dark: AccentVars; light: AccentVars }> = {
  mono: {
    label: '墨色',
    swatch: 'var(--accent)',

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

  azure: {
    label: '云蓝',
    swatch: '#339cff',

    dark: {
      accent: '#5eb1ff', accentStrong: '#8cc6ff', accentHover: '#8cc6ff', accentActive: '#2f8ff0',
      accentSoft: 'rgba(94, 177, 255, 0.14)', accentRing: 'rgba(94, 177, 255, 0.35)',
      onAccent: '#061a2e', gradient: '#5eb1ff',
    },

    light: {
      accent: '#1f8fff', accentStrong: '#0f7ae0', accentHover: '#0f7ae0', accentActive: '#0b63bd',
      accentSoft: 'rgba(31, 143, 255, 0.12)', accentRing: 'rgba(31, 143, 255, 0.3)',
      onAccent: '#ffffff', gradient: '#1f8fff',
    },
  },

  amber: {
    label: '琥珀',
    swatch: '#e8a33d',

    dark: {
      accent: '#f0b35c', accentStrong: '#f6c67f', accentHover: '#f6c67f', accentActive: '#d98f2b',
      accentSoft: 'rgba(240, 179, 92, 0.14)', accentRing: 'rgba(240, 179, 92, 0.35)',
      onAccent: '#241503', gradient: '#f0b35c',
    },

    light: {
      accent: '#c77d1e', accentStrong: '#a96815', accentHover: '#a96815', accentActive: '#8a5410',
      accentSoft: 'rgba(199, 125, 30, 0.12)', accentRing: 'rgba(199, 125, 30, 0.3)',
      onAccent: '#ffffff', gradient: '#c77d1e',
    },
  },

  emerald: {
    label: '翡翠',
    swatch: '#3eaf7c',

    dark: {
      accent: '#53c793', accentStrong: '#7ed8af', accentHover: '#7ed8af', accentActive: '#2f9e6e',
      accentSoft: 'rgba(83, 199, 147, 0.14)', accentRing: 'rgba(83, 199, 147, 0.35)',
      onAccent: '#04231a', gradient: '#53c793',
    },

    light: {
      accent: '#1f8a5c', accentStrong: '#17704b', accentHover: '#17704b', accentActive: '#11593b',
      accentSoft: 'rgba(31, 138, 92, 0.12)', accentRing: 'rgba(31, 138, 92, 0.3)',
      onAccent: '#ffffff', gradient: '#1f8a5c',
    },
  },

  violet: {
    label: '紫罗兰',
    swatch: '#8b7cf6',

    dark: {
      accent: '#a394f8', accentStrong: '#c0b5fb', accentHover: '#c0b5fb', accentActive: '#7b68ee',
      accentSoft: 'rgba(163, 148, 248, 0.14)', accentRing: 'rgba(163, 148, 248, 0.35)',
      onAccent: '#171033', gradient: '#a394f8',
    },

    light: {
      accent: '#6d5ce6', accentStrong: '#5a49d1', accentHover: '#5a49d1', accentActive: '#4939b8',
      accentSoft: 'rgba(109, 92, 230, 0.12)', accentRing: 'rgba(109, 92, 230, 0.3)',
      onAccent: '#ffffff', gradient: '#6d5ce6',
    },
  },
}

/** 将所选 Agent 颜色应用到 documentElement（覆盖 --accent 系列 CSS 变量）。 */
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
