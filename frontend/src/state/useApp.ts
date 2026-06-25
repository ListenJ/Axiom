import { create } from 'zustand'

type Theme = 'dark' | 'light'

interface AppState {
  theme: Theme
  sidebarOpen: boolean
  helpOpen: boolean
  toasts: { id: number; type: 'info' | 'success' | 'error' | 'warning'; message: string }[]
  setTheme: (t: Theme) => void
  toggleTheme: () => void
  setSidebarOpen: (open: boolean) => void
  setHelpOpen: (open: boolean) => void
  toast: (message: string, type?: 'info' | 'success' | 'error' | 'warning') => void
  dismissToast: (id: number) => void
}

const THEME_KEY = 'openclaw:theme'

function readInitialTheme(): Theme {
  if (typeof localStorage === 'undefined') return 'dark'
  const stored = localStorage.getItem(THEME_KEY)
  if (stored === 'light' || stored === 'dark') return stored
  return 'dark'
}

let toastId = 0

export const useApp = create<AppState>((set, get) => ({
  theme: readInitialTheme(),
  sidebarOpen: false,
  helpOpen: false,
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
  setHelpOpen: (open) => set({ helpOpen: open }),
  toast: (message, type = 'info') => {
    const id = ++toastId
    set({ toasts: [...get().toasts, { id, type, message }] })
    setTimeout(() => get().dismissToast(id), 4000)
  },
  dismissToast: (id) => set({ toasts: get().toasts.filter((t) => t.id !== id) }),
}))
