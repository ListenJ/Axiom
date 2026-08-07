import { create } from 'zustand'
import type { AccentId } from '@/lib/accents'

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
  sidebarOpen: boolean
  sidebarCollapsed: boolean
  helpOpen: boolean
  terminalOpen: boolean
  rightbarOpen: boolean
  rightbarTool: RightbarTool
  toasts: { id: number; type: 'info' | 'success' | 'error' | 'warning'; message: string }[]
  setTheme: (t: Theme) => void
  toggleTheme: () => void
  setAccent: (a: AccentId) => void
  setSidebarOpen: (open: boolean) => void
  setSidebarCollapsed: (collapsed: boolean) => void
  toggleSidebarCollapsed: () => void
  setHelpOpen: (open: boolean) => void
  setTerminalOpen: (open: boolean) => void
  setRightbarOpen: (open: boolean) => void
  setRightbarTool: (tool: RightbarTool) => void
  openRightTool: (tool: RightbarTool) => void
  toast: (message: string, type?: 'info' | 'success' | 'error' | 'warning') => void
  dismissToast: (id: number) => void
}

const THEME_KEY = 'axiom:theme'
const SIDEBAR_COLLAPSED_KEY = 'axiom:sidebar-collapsed'
const ACCENT_KEY = 'axiom:accent'

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
  // AXIS Monochrome：唯一墨色预设；旧彩色持久化值不再生效。
  return 'mono'
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
  sidebarOpen: false,
  sidebarCollapsed: readInitialSidebarCollapsed(),
  helpOpen: false,
  terminalOpen: false,
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
