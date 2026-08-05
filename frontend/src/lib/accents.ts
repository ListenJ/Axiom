/**
 * 强调色预设 — 主题色自定义的唯一事实来源。
 *
 * 默认值（index.css :root）为 amber；选择其他预设时通过 CSS 变量覆盖
 * --accent 系列 8 个令牌（useTheme 应用，localStorage 持久化）。
 */

export type AccentId = 'amber' | 'sky' | 'violet' | 'emerald' | 'rose' | 'indigo'

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
  amber: {
    label: '琥珀',
    dark: {
      accent: '#f59e0b', accentStrong: '#fbbf24', accentHover: '#fbbf24', accentActive: '#d97706',
      accentSoft: 'rgba(245, 158, 11, 0.12)', accentRing: 'rgba(245, 158, 11, 0.35)',
      onAccent: '#1a1206', gradient: 'linear-gradient(135deg, #f59e0b, #fbbf24)',
    },
    light: {
      accent: '#b45309', accentStrong: '#d97706', accentHover: '#d97706', accentActive: '#92400e',
      accentSoft: 'rgba(180, 83, 9, 0.1)', accentRing: 'rgba(180, 83, 9, 0.3)',
      onAccent: '#fff7ea', gradient: 'linear-gradient(135deg, #b45309, #d97706)',
    },
  },
  sky: {
    label: '天青',
    dark: {
      accent: '#38bdf8', accentStrong: '#7dd3fc', accentHover: '#7dd3fc', accentActive: '#0284c7',
      accentSoft: 'rgba(56, 189, 248, 0.12)', accentRing: 'rgba(56, 189, 248, 0.35)',
      onAccent: '#082f49', gradient: 'linear-gradient(135deg, #38bdf8, #7dd3fc)',
    },
    light: {
      accent: '#0284c7', accentStrong: '#0369a1', accentHover: '#0369a1', accentActive: '#075985',
      accentSoft: 'rgba(2, 132, 199, 0.1)', accentRing: 'rgba(2, 132, 199, 0.3)',
      onAccent: '#f0f9ff', gradient: 'linear-gradient(135deg, #0284c7, #0369a1)',
    },
  },
  violet: {
    label: '紫罗兰',
    dark: {
      accent: '#a78bfa', accentStrong: '#c4b5fd', accentHover: '#c4b5fd', accentActive: '#7c3aed',
      accentSoft: 'rgba(167, 139, 250, 0.14)', accentRing: 'rgba(167, 139, 250, 0.35)',
      onAccent: '#1e1b4b', gradient: 'linear-gradient(135deg, #a78bfa, #c4b5fd)',
    },
    light: {
      accent: '#7c3aed', accentStrong: '#6d28d9', accentHover: '#6d28d9', accentActive: '#5b21b6',
      accentSoft: 'rgba(124, 58, 237, 0.1)', accentRing: 'rgba(124, 58, 237, 0.3)',
      onAccent: '#f5f3ff', gradient: 'linear-gradient(135deg, #7c3aed, #6d28d9)',
    },
  },
  emerald: {
    label: '翡翠',
    dark: {
      accent: '#34d399', accentStrong: '#6ee7b7', accentHover: '#6ee7b7', accentActive: '#059669',
      accentSoft: 'rgba(52, 211, 153, 0.12)', accentRing: 'rgba(52, 211, 153, 0.35)',
      onAccent: '#022c22', gradient: 'linear-gradient(135deg, #34d399, #6ee7b7)',
    },
    light: {
      accent: '#059669', accentStrong: '#047857', accentHover: '#047857', accentActive: '#065f46',
      accentSoft: 'rgba(5, 150, 105, 0.1)', accentRing: 'rgba(5, 150, 105, 0.3)',
      onAccent: '#ecfdf5', gradient: 'linear-gradient(135deg, #059669, #047857)',
    },
  },
  rose: {
    label: '玫瑰',
    dark: {
      accent: '#fb7185', accentStrong: '#fda4af', accentHover: '#fda4af', accentActive: '#e11d48',
      accentSoft: 'rgba(251, 113, 133, 0.14)', accentRing: 'rgba(251, 113, 133, 0.35)',
      onAccent: '#4c0519', gradient: 'linear-gradient(135deg, #fb7185, #fda4af)',
    },
    light: {
      accent: '#e11d48', accentStrong: '#be123c', accentHover: '#be123c', accentActive: '#9f1239',
      accentSoft: 'rgba(225, 29, 72, 0.1)', accentRing: 'rgba(225, 29, 72, 0.3)',
      onAccent: '#fff1f2', gradient: 'linear-gradient(135deg, #e11d48, #be123c)',
    },
  },
  indigo: {
    label: '靛蓝',
    dark: {
      accent: '#818cf8', accentStrong: '#a5b4fc', accentHover: '#a5b4fc', accentActive: '#4f46e5',
      accentSoft: 'rgba(129, 140, 248, 0.14)', accentRing: 'rgba(129, 140, 248, 0.35)',
      onAccent: '#1e1b4b', gradient: 'linear-gradient(135deg, #818cf8, #a5b4fc)',
    },
    light: {
      accent: '#4f46e5', accentStrong: '#4338ca', accentHover: '#4338ca', accentActive: '#3730a3',
      accentSoft: 'rgba(79, 70, 229, 0.1)', accentRing: 'rgba(79, 70, 229, 0.3)',
      onAccent: '#eef2ff', gradient: 'linear-gradient(135deg, #4f46e5, #4338ca)',
    },
  },
}

/** 将指定预设应用到 documentElement（覆盖 --accent 系列 CSS 变量）。 */
export function applyAccent(id: AccentId, theme: 'dark' | 'light'): void {
  if (typeof document === 'undefined') return
  const preset = ACCENT_PRESETS[id]
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
