import { NavLink } from 'react-router-dom'
import { X } from 'lucide-react'
import { VISIBLE_NAV_ITEMS } from '@/lib/nav'

interface SidebarProps {
  open: boolean
  onClose: () => void
}

export default function Sidebar({ open, onClose }: SidebarProps) {
  return (
    <aside
      className={`
        fixed inset-y-0 left-0 z-50 flex w-60 flex-col border-r border-[var(--border)]
        bg-[var(--bg-secondary)]/95 backdrop-blur-md
        transform transition-transform duration-300 ease-out
        lg:static lg:translate-x-0
        ${open ? 'translate-x-0' : '-translate-x-full'}
      `}
      aria-label="主导航"
    >
      {/* Brand */}
      <div className="flex h-14 items-center justify-between border-b border-[var(--border)] px-4">
        <div className="flex items-center gap-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-[var(--accent)] to-[var(--accent-active)] text-sm font-bold text-white shadow-[var(--shadow-sm)]">
            OC
          </div>
          <div className="flex flex-col leading-tight">
            <span className="font-display text-sm font-semibold tracking-tight text-[var(--text)]">
              Axiom
            </span>
            <span className="text-2xs text-[var(--text-muted)]">智能工作台</span>
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="press flex h-9 w-9 items-center justify-center rounded-lg text-[var(--text-muted)] transition-colors hover:bg-[var(--surface-hover)] hover:text-[var(--text)] focus:outline-none lg:hidden"
          aria-label="关闭菜单"
        >
          <X size={18} />
        </button>
      </div>

      {/* Nav items */}
      <nav className="flex-1 space-y-0.5 overflow-y-auto p-3" aria-label="主导航列表">
        {VISIBLE_NAV_ITEMS.map((item) => {
          const Icon = item.icon
          return (
            <NavLink
              key={item.id}
              to={item.path}
              end={item.path === '/'}
              onClick={() => onClose()}
              className={({ isActive }) =>
                `press group flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors ${
                  isActive
                    ? 'bg-[var(--accent-soft)] text-[var(--accent)]'
                    : 'text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] hover:text-[var(--text)]'
                }`
              }
            >
              {({ isActive }) => (
                <>
                  <Icon
                    size={18}
                    className={`shrink-0 transition-transform group-hover:scale-110 ${
                      isActive ? 'text-[var(--accent)]' : ''
                    }`}
                  />
                  <span className="flex-1">{item.label}</span>
                  <kbd
                    className={`font-mono text-2xs ${
                      isActive
                        ? 'text-[var(--accent)] opacity-70'
                        : 'text-[var(--text-muted)]'
                    }`}
                  >
                    {item.shortcut}
                  </kbd>
                </>
              )}
            </NavLink>
          )
        })}
      </nav>

      {/* Footer */}
      <div className="border-t border-[var(--border)] p-3">
        <div className="rounded-lg bg-[var(--bg-tertiary)]/50 p-2.5">
          <div className="flex items-center gap-2">
            <div className="pulse-dot size-2 rounded-full bg-[var(--success)]" />
            <span className="text-2xs text-[var(--text-muted)]">系统在线</span>
          </div>
          <p className="mt-1 text-2xs text-[var(--text-muted)]">
            全部服务在线
          </p>
        </div>
      </div>
    </aside>
  )
}
