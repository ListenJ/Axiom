import { create } from 'zustand'
import type { AccentId, ShellToneId, CanvasToneId } from '@/lib/accents'

type Theme = 'dark' | 'light' | 'system'

export type RightbarTool =
  | 'summary'
  | 'git'
  | 'review'
  | 'terminal'
  | 'browser'
  | 'files'
  | 'mini-chat'

interface AppState {
  theme: Theme
  accent: AccentId
  shellTone: ShellToneId
  canvasTone: CanvasToneId
  sidebarOpen: boolean
  sidebarCollapsed: boolean
  helpOpen: boolean
  terminalOpen: boolean
  terminalOverlay: boolean
  rightbarOpen: boolean
  rightbarTool: RightbarTool
  toasts: { id: number; type: 'info' | 'success' | 'error' | 'warning'; message: string }[]
  setTheme: (t: Theme) => void
  toggleTheme: () => void
  setAccent: (a: AccentId) => void
  setShellTone: (t: ShellToneId) => void
  setCanvasTone: (t: CanvasToneId) => void
  setSidebarOpen: (open: boolean) => void
  setSidebarCollapsed: (collapsed: boolean) => void
  toggleSidebarCollapsed: () => void
  setHelpOpen: (open: boolean) => void
  setTerminalOpen: (open: boolean) => void
  setTerminalOverlay: (overlay: boolean) => void
  setRightbarOpen: (open: boolean) => void
  setRightbarTool: (tool: RightbarTool) => void
  openRightTool: (tool: RightbarTool) => void
  toast: (message: string, type?: 'info' | 'success' | 'error' | 'warning') => void
  dismissToast: (id: number) => void
}

const THEME_KEY = 'axiom:theme'
const SIDEBAR_COLLAPSED_KEY = 'axiom:sidebar-collapsed'
const ACCENT_KEY = 'axiom:accent'
const SHELL_TONE_KEY = 'axiom:shell-tone'
const CANVAS_TONE_KEY = 'axiom:canvas-tone'
const TERMINAL_OVERLAY_KEY = 'axiom:terminal-overlay'

function readInitialTheme(): Theme {
  if (typeof localStorage === 'undefined') return 'system'
  const stored = localStorage.getItem(THEME_KEY)
  if (stored === 'light' || stored === 'dark' || stored === 'system') return stored
  return 'system'
}

/** 当前实际生效的主题（system 时按系统偏好解析）。 */
export function resolveTheme(theme: Theme): 'dark' | 'light' {
  if (theme !== 'system') return theme
  if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
    return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
  }
  return 'dark'
}

function readInitialAccent(): AccentId {
  if (typeof localStorage === 'undefined') return 'mono'
  const stored = localStorage.getItem(ACCENT_KEY)
  if (stored === 'mono' || stored === 'azure' || stored === 'amber' || stored === 'emerald' || stored === 'violet') {
    return stored
  }
  return 'mono'
}

function readInitialShellTone(): ShellToneId {
  if (typeof localStorage === 'undefined') return 'default'
  const stored = localStorage.getItem(SHELL_TONE_KEY)
  return stored === 'deeper' || stored === 'brighter' ? stored : 'default'
}

function readInitialCanvasTone(): CanvasToneId {
  if (typeof localStorage === 'undefined') return 'default'
  const stored = localStorage.getItem(CANVAS_TONE_KEY)
  return stored === 'pure' || stored === 'soft' ? stored : 'default'
}

function readInitialTerminalOverlay(): boolean {
  if (typeof localStorage === 'undefined') return true
  const stored = localStorage.getItem(TERMINAL_OVERLAY_KEY)
  return stored !== 'false'
}

function readInitialSidebarCollapsed(): boolean {
  if (typeof localStorage === 'undefined') return false
  return localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === 'true'
}

/** 右栏工具台默认状态：桌面常驻打开，移动端默认关闭（抽屉由用户唤出）。
 *  jsdom/无 matchMedia 环境（测试）安全降级为 true。 */
function readInitialRightbarOpen(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return true
  return window.matchMedia('(min-width: 1024px)').matches
}

let toastId = 0

export const useApp = create<AppState>((set, get) => ({
  theme: readInitialTheme(),
  accent: readInitialAccent(),
  shellTone: readInitialShellTone(),
  canvasTone: readInitialCanvasTone(),
  sidebarOpen: false,
  sidebarCollapsed: readInitialSidebarCollapsed(),
  helpOpen: false,
  terminalOpen: false,
  terminalOverlay: readInitialTerminalOverlay(),
  rightbarOpen: readInitialRightbarOpen(),
  rightbarTool: 'summary',
  toasts: [],
  setTheme: (t) => {
    if (typeof localStorage !== 'undefined') localStorage.setItem(THEME_KEY, t)
    set({ theme: t })
  },
  toggleTheme: () => {
    // system 模式下 Shift+T 切换到当前实际主题的反面（显式锁定）
    const current = resolveTheme(get().theme)
    const next: Theme = current === 'dark' ? 'light' : 'dark'
    get().setTheme(next)
  },
  setAccent: (a) => {
    if (typeof localStorage !== 'undefined') localStorage.setItem(ACCENT_KEY, a)
    set({ accent: a })
  },
  setShellTone: (t) => {
    if (typeof localStorage !== 'undefined') localStorage.setItem(SHELL_TONE_KEY, t)
    set({ shellTone: t })
  },
  setCanvasTone: (t) => {
    if (typeof localStorage !== 'undefined') localStorage.setItem(CANVAS_TONE_KEY, t)
    set({ canvasTone: t })
  },
  setSidebarOpen: (open) => set({ sidebarOpen: open }),
  setSidebarCollapsed: (collapsed) => {
    if (typeof localStorage !== 'undefined') localStorage.setItem(SIDEBAR_COLLAPSED_KEY, String(collapsed))
    set({ sidebarCollapsed: collapsed })
  },
  toggleSidebarCollapsed: () => {
    const next = !get().sidebarCollapsed
    get().setSidebarCollapsed(next)
  },
  setHelpOpen: (open) => set({ helpOpen: open }),
  setTerminalOpen: (open) => set({ terminalOpen: open }),
  setTerminalOverlay: (overlay) => {
    if (typeof localStorage !== 'undefined') localStorage.setItem(TERMINAL_OVERLAY_KEY, String(overlay))
    set({ terminalOverlay: overlay })
  },
  setRightbarOpen: (open) => set({ rightbarOpen: open }),
  setRightbarTool: (tool) => set({ rightbarTool: tool }),
  openRightTool: (tool) => set({ rightbarTool: tool, rightbarOpen: true }),
  toast: (message, type = 'info') => {
    const id = ++toastId
    set({ toasts: [...get().toasts, { id, type, message }] })
    setTimeout(() => get().dismissToast(id), 4000)
  },
  dismissToast: (id) => set({ toasts: get().toasts.filter((t) => t.id !== id) }),
}))
