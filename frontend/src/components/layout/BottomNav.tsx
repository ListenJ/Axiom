import { NavLink } from 'react-router-dom'
import { MOBILE_NAV_ITEMS } from '@/lib/nav'

export default function BottomNav() {
  return (
    <nav
      className="flex h-16 shrink-0 items-center justify-around border-t border-[var(--border)] glass-sm pb-safe pt-1 lg:hidden"
      aria-label="底部导航"
    >
      {MOBILE_NAV_ITEMS.map((item) => {
        const Icon = item.icon
        return (
          <NavLink
            key={item.id}
            to={item.path}
            end={item.path === '/'}
            className={({ isActive }) =>
              `press group flex min-w-[4.5rem] flex-col items-center justify-center gap-0.5 py-2 transition-colors ${
                isActive ? 'text-[var(--accent)]' : 'text-[var(--text-muted)] active:text-[var(--accent)]'
              }`
            }
          >
            {({ isActive }) => (
              <>
                <span
                  className={`flex h-6 items-center justify-center transition-transform group-hover:scale-110 ${
                    isActive ? 'scale-110' : ''
                  }`}
                >
                  <Icon size={22} />
                </span>
                <span className="text-2xs font-medium">{item.label}</span>
                {isActive && (
                  <span className="absolute -top-px left-1/2 h-0.5 w-6 -translate-x-1/2 rounded-b-full bg-[var(--accent)]" />
                )}
              </>
            )}
          </NavLink>
        )
      })}
    </nav>
  )
}
