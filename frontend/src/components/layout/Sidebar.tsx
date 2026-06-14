import { NavLink } from 'react-router-dom'
import { X } from 'lucide-react'
import { NAV_ITEMS } from '@/lib/nav'

interface SidebarProps {
  open: boolean
  onClose: () => void
}

export default function Sidebar({ open, onClose }: SidebarProps) {
  return (
    <aside
      className={`
        fixed inset-y-0 left-0 z-50 flex w-60 flex-col transform border-r border-border bg-bg-secondary transition-transform duration-300 ease-in-out
        lg:static lg:translate-x-0
        ${open ? 'translate-x-0' : '-translate-x-full'}
      `}
      aria-label="主导航"
    >
      <div className="flex h-14 items-center justify-between border-b border-border px-4">
        <div className="flex items-center gap-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-accent font-bold text-white">
            OC
          </div>
          <span className="text-base font-semibold">OpenClaw</span>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="focus-ring flex h-9 w-9 items-center justify-center rounded-lg text-text-secondary hover:bg-surface hover:text-text lg:hidden"
          aria-label="关闭菜单"
        >
          <X size={18} />
        </button>
      </div>

      <nav className="flex-1 space-y-1 overflow-y-auto p-3">
        {NAV_ITEMS.map((item) => {
          const Icon = item.icon
          return (
            <NavLink
              key={item.id}
              to={item.path}
              end={item.path === '/'}
              onClick={() => onClose()}
              className={({ isActive }) =>
                `focus-ring flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors ${
                  isActive
                    ? 'bg-accent/15 text-accent'
                    : 'text-text-secondary hover:bg-surface hover:text-text'
                }`
              }
            >
              <Icon size={18} />
              <span className="flex-1">{item.label}</span>
              <span className="font-mono text-2xs text-text-muted">{item.shortcut}</span>
            </NavLink>
          )
        })}
      </nav>

      <div className="border-t border-border p-3 text-2xs text-text-muted">
        <p>OpenClaw v2.3 · Tauri + React</p>
      </div>
    </aside>
  )
}
