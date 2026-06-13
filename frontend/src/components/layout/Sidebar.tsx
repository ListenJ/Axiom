import { Home, MessageSquare, BarChart3, Settings, X, Bot, FileText, Shield } from 'lucide-react'

interface SidebarProps {
  open: boolean
  onClose: () => void
}

const navItems = [
  { icon: Home, label: '首页', href: '#/' },
  { icon: MessageSquare, label: '对话', href: '#/chat' },
  { icon: BarChart3, label: '分析', href: '#/' },
  { icon: Bot, label: '智能体', href: '#/' },
  { icon: FileText, label: '文档', href: '#/' },
  { icon: Shield, label: '安全', href: '#/' },
]

export default function Sidebar({ open, onClose }: SidebarProps) {
  return (
    <aside
      className={`
        fixed inset-y-0 left-0 z-50 w-60 transform border-r border-border bg-bg-secondary transition-transform duration-300 ease-in-out
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
          className="flex h-9 w-9 items-center justify-center rounded-lg text-text-secondary hover:bg-surface lg:hidden"
          aria-label="关闭菜单"
        >
          <X size={18} />
        </button>
      </div>

      <nav className="flex-1 space-y-1 overflow-y-auto p-3">
        {navItems.map((item) => {
          const Icon = item.icon
          return (
            <a
              key={item.label}
              href={item.href}
              onClick={() => onClose()}
              className="flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium text-text-secondary transition-colors hover:bg-surface hover:text-text"
            >
              <Icon size={18} />
              {item.label}
            </a>
          )
        })}
      </nav>

      <div className="border-t border-border p-3">
        <a
          href="#/settings"
          onClick={() => onClose()}
          className="flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium text-text-secondary transition-colors hover:bg-surface hover:text-text"
        >
          <Settings size={18} />
          设置
        </a>
      </div>
    </aside>
  )
}
