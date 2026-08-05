import { create } from 'zustand'

type Theme = 'dark' | 'light'

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
  sidebarOpen: boolean
  sidebarCollapsed: boolean
  helpOpen: boolean
  terminalOpen: boolean
  rightbarOpen: boolean
  rightbarTool: RightbarTool
  toasts: { id: number; type: 'info' | 'success' | 'error' | 'warning'; message: string }[]
  setTheme: (t: Theme) => void
  toggleTheme: () => void
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

function readInitialTheme(): Theme {
  if (typeof localStorage === 'undefined') return 'dark'
  const stored = localStorage.getItem(THEME_KEY)
  if (stored === 'light' || stored === 'dark') return stored
  return 'dark'
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
    const next: Theme = get().theme === 'dark' ? 'light' : 'dark'
    get().setTheme(next)
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
