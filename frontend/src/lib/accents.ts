/**
 * Agent 颜色预设 — 默认「墨色」（黑白主题反转），可切换为低饱和强调色。
 *
 * 选择后通过 applyAccent 覆盖 --accent 系列 CSS 变量（useTheme 应用，localStorage 持久化）。
 */

export type AccentId = 'mono' | 'indigo' | 'azure' | 'amber' | 'emerald' | 'violet'

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
      accent: '#333333', accentStrong: '#4a4a4a', accentHover: '#444444', accentActive: '#1a1a1a',
      accentSoft: 'rgba(51, 51, 51, 0.08)', accentRing: 'rgba(51, 51, 51, 0.22)',
      onAccent: '#ffffff', gradient: '#333333',
    },
  },

  indigo: {
    label: '靛蓝',
    swatch: '#6366f1',

    dark: {
      accent: '#6366f1', accentStrong: '#818cf8', accentHover: '#818cf8', accentActive: '#4f46e5',
      accentSoft: 'rgba(99, 102, 241, 0.22)', accentRing: 'rgba(99, 102, 241, 0.4)',
      onAccent: '#ffffff', gradient: '#6366f1',
    },

    light: {
      accent: '#4f46e5', accentStrong: '#6366f1', accentHover: '#4338ca', accentActive: '#3730a3',
      accentSoft: 'rgba(79, 70, 229, 0.12)', accentRing: 'rgba(79, 70, 229, 0.3)',
      onAccent: '#ffffff', gradient: '#4f46e5',
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

/* ── 层级配色：外壳 / 工作区色调预设 ─────────────────────────── */

export type ShellToneId = 'default' | 'deeper' | 'brighter'
export type CanvasToneId = 'default' | 'pure' | 'soft'

export interface LayerToneVars {
  shellBg: string
  shellGlass: string
  shellRaisedGlass: string
  shellHover: string
  canvasBg: string
  canvasGlass: string
  canvasHover: string
}

export const SHELL_TONES: Record<ShellToneId, { label: string; dark: LayerToneVars; light: LayerToneVars }> = {
  default: {
    label: '标准',
    dark: { shellBg: '#1a1a1a', shellGlass: 'rgba(26, 26, 26, 0.55)', shellRaisedGlass: 'rgba(34, 34, 34, 0.66)', shellHover: '#262626', canvasBg: '#0a0a0a', canvasGlass: 'rgba(10, 10, 10, 0.5)', canvasHover: '#181818' },
    light: { shellBg: '#f0f2f5', shellGlass: 'rgba(240, 242, 245, 0.62)', shellRaisedGlass: 'rgba(232, 234, 238, 0.72)', shellHover: '#e2e5ea', canvasBg: '#ffffff', canvasGlass: 'rgba(255, 255, 255, 0.58)', canvasHover: '#f4f4f4' },
  },
  deeper: {
    label: '深调',
    dark: { shellBg: '#101010', shellGlass: 'rgba(16, 16, 16, 0.52)', shellRaisedGlass: 'rgba(24, 24, 24, 0.62)', shellHover: '#1c1c1c', canvasBg: '#050505', canvasGlass: 'rgba(5, 5, 5, 0.5)', canvasHover: '#131313' },
    light: { shellBg: '#e4e7eb', shellGlass: 'rgba(228, 231, 235, 0.6)', shellRaisedGlass: 'rgba(220, 224, 229, 0.7)', shellHover: '#d9dde3', canvasBg: '#fafafa', canvasGlass: 'rgba(250, 250, 250, 0.6)', canvasHover: '#f0f0f0' },
  },
  brighter: {
    label: '亮调',
    dark: { shellBg: '#242424', shellGlass: 'rgba(36, 36, 36, 0.6)', shellRaisedGlass: 'rgba(46, 46, 46, 0.7)', shellHover: '#303030', canvasBg: '#101010', canvasGlass: 'rgba(16, 16, 16, 0.5)', canvasHover: '#1e1e1e' },
    light: { shellBg: '#ffffff', shellGlass: 'rgba(255, 255, 255, 0.66)', shellRaisedGlass: 'rgba(248, 248, 248, 0.74)', shellHover: '#f2f2f2', canvasBg: '#ffffff', canvasGlass: 'rgba(255, 255, 255, 0.6)', canvasHover: '#f6f6f6' },
  },
}

export const CANVAS_TONES: Record<CanvasToneId, { label: string; dark: LayerToneVars; light: LayerToneVars }> = {
  default: {
    label: '标准',
    dark: SHELL_TONES.default.dark,
    light: SHELL_TONES.default.light,
  },
  pure: {
    label: '纯调',
    dark: { shellBg: '#1a1a1a', shellGlass: 'rgba(26, 26, 26, 0.55)', shellRaisedGlass: 'rgba(34, 34, 34, 0.66)', shellHover: '#262626', canvasBg: '#000000', canvasGlass: 'rgba(0, 0, 0, 0.5)', canvasHover: '#0f0f0f' },
    light: { shellBg: '#f0f2f5', shellGlass: 'rgba(240, 242, 245, 0.62)', shellRaisedGlass: 'rgba(232, 234, 238, 0.72)', shellHover: '#e2e5ea', canvasBg: '#ffffff', canvasGlass: 'rgba(255, 255, 255, 0.62)', canvasHover: '#f4f4f4' },
  },
  soft: {
    label: '柔调',
    dark: { shellBg: '#1a1a1a', shellGlass: 'rgba(26, 26, 26, 0.55)', shellRaisedGlass: 'rgba(34, 34, 34, 0.66)', shellHover: '#262626', canvasBg: '#141414', canvasGlass: 'rgba(20, 20, 20, 0.5)', canvasHover: '#202020' },
    light: { shellBg: '#f0f2f5', shellGlass: 'rgba(240, 242, 245, 0.62)', shellRaisedGlass: 'rgba(232, 234, 238, 0.72)', shellHover: '#e2e5ea', canvasBg: '#f7f8fa', canvasGlass: 'rgba(247, 248, 250, 0.6)', canvasHover: '#eff1f4' },
  },
}

/** 将外壳/工作区色调应用到 documentElement（覆盖层级背景 CSS 变量）。 */
export function applyLayerTones(shell: ShellToneId, canvas: CanvasToneId, theme: 'dark' | 'light'): void {
  if (typeof document === 'undefined') return
  const s = (SHELL_TONES[shell] ?? SHELL_TONES.default)[theme]
  const c = (CANVAS_TONES[canvas] ?? CANVAS_TONES.default)[theme]
  const root = document.documentElement.style
  root.setProperty('--shell-bg', s.shellBg)
  root.setProperty('--shell-glass-bg', s.shellGlass)
  root.setProperty('--shell-raised-glass-bg', s.shellRaisedGlass)
  root.setProperty('--shell-hover', s.shellHover)
  root.setProperty('--canvas-bg', c.canvasBg)
  root.setProperty('--canvas-glass-bg', c.canvasGlass)
  root.setProperty('--canvas-hover', c.canvasHover)
}
