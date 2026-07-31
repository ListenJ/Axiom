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
        glass-sm
        transform transition-transform duration-300 ease-out
        lg:static lg:translate-x-0
        ${open ? 'translate-x-0' : '-translate-x-full'}
      `}
      aria-label="主导航"
    >
      {/* Brand */}
      <div className="flex h-14 items-center justify-between border-b border-[var(--border)] px-4">
        <div className="flex items-center gap-2">
          <svg className="h-8 w-8" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg">
            <rect width="32" height="32" rx="8" fill="url(#logo-gradient)" />
            <path d="M16 8c-4.4 0-8 3.1-8 7s3.6 7 8 7c2 0 3.8-.7 5.2-1.8l-2.2-2.2c-.8.6-1.9 1-3 1-2.2 0-4-1.6-4-3.6s1.8-3.6 4-3.6 4 1.6 4 3.6v.7h-3.5l4.2 4.2C24.2 18.5 24 13.5 24 15c0-3.9-3.6-7-8-7z" fill="white" />
            <defs>
              <linearGradient id="logo-gradient" x1="0" y1="0" x2="32" y2="32" gradientUnits="userSpaceOnUse">
                <stop stopColor="#f59e0b" />
                <stop offset="1" stopColor="#fbbf24" />
              </linearGradient>
            </defs>
          </svg>
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
