import { NavLink } from 'react-router-dom'
import { MOBILE_NAV_ITEMS } from '@/lib/nav'

export default function BottomNav() {
  return (
    <nav
      className="flex h-16 shrink-0 items-center justify-around border-t border-border bg-bg-secondary pb-safe lg:hidden"
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
              `focus-ring flex min-w-[4.5rem] flex-col items-center justify-center gap-1 py-2 transition-colors ${
                isActive ? 'text-accent' : 'text-text-secondary active:text-accent'
              }`
            }
          >
            <Icon size={22} />
            <span className="text-2xs font-medium">{item.label}</span>
          </NavLink>
        )
      })}
    </nav>
  )
}
