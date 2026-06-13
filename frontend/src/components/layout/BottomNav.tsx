import { Home, MessageSquare, BarChart3, Settings } from 'lucide-react'

const navItems = [
  { icon: Home, label: '首页', href: '#/' },
  { icon: MessageSquare, label: '对话', href: '#/chat' },
  { icon: BarChart3, label: '分析', href: '#/' },
  { icon: Settings, label: '设置', href: '#/settings' },
]

export default function BottomNav() {
  return (
    <nav
      className="flex h-16 shrink-0 items-center justify-around border-t border-border bg-bg-secondary pb-safe lg:hidden"
      aria-label="底部导航"
    >
      {navItems.map((item) => {
        const Icon = item.icon
        return (
          <a
            key={item.label}
            href={item.href}
            className="flex min-w-[4.5rem] flex-col items-center justify-center gap-1 py-2 text-text-secondary transition-colors active:text-accent"
          >
            <Icon size={22} />
            <span className="text-2xs font-medium">{item.label}</span>
          </a>
        )
      })}
    </nav>
  )
}
