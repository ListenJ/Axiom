import { useNavigate } from 'react-router-dom'
import { Menu, Bell, Sun, Moon, Keyboard } from 'lucide-react'
import { useApp } from '@/state/useApp'

interface HeaderProps {
  onMenuClick: () => void
}

export default function Header({ onMenuClick }: HeaderProps) {
  const navigate = useNavigate()
  const theme = useApp((s) => s.theme)
  const toggleTheme = useApp((s) => s.toggleTheme)
  const openHelp = useApp((s) => s.setHelpOpen)

  return (
    <header className="flex h-14 shrink-0 items-center justify-between gap-3 border-b border-border bg-bg-secondary px-4">
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={onMenuClick}
          className="focus-ring flex h-10 w-10 items-center justify-center rounded-lg text-text-secondary transition-colors hover:bg-surface hover:text-text lg:hidden"
          aria-label="打开菜单"
        >
          <Menu size={20} />
        </button>

        <button
          type="button"
          onClick={() => navigate('/')}
          className="focus-ring flex items-center gap-2 rounded-lg px-1 py-1 text-text transition-colors hover:bg-surface"
          aria-label="返回首页"
        >
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-accent font-bold text-white">
            OC
          </div>
          <span className="hidden text-base font-semibold sm:inline">OpenClaw</span>
        </button>
      </div>

      <div className="hidden max-w-md flex-1 px-4 md:block">
        <button
          type="button"
          onClick={() => navigate('/search')}
          className="focus-ring flex h-9 w-full items-center gap-2 rounded-lg border border-border bg-bg px-3 text-left text-sm text-text-muted transition-colors hover:border-border-hover hover:text-text-secondary"
          aria-label="打开搜索"
        >
          <span>搜索笔记与代码…</span>
          <span className="ml-auto rounded bg-bg-tertiary px-1.5 py-0.5 font-mono text-2xs">/</span>
        </button>
      </div>

      <div className="flex items-center gap-1 sm:gap-2">
        <button
          type="button"
          onClick={() => openHelp(true)}
          className="focus-ring flex h-10 w-10 items-center justify-center rounded-lg text-text-secondary transition-colors hover:bg-surface hover:text-text"
          aria-label="键盘快捷键"
        >
          <Keyboard size={18} />
        </button>
        <button
          type="button"
          onClick={toggleTheme}
          className="focus-ring flex h-10 w-10 items-center justify-center rounded-lg text-text-secondary transition-colors hover:bg-surface hover:text-text"
          aria-label="切换主题"
          title="切换主题（Shift+T）"
        >
          {theme === 'dark' ? <Sun size={18} /> : <Moon size={18} />}
        </button>
        <button
          type="button"
          onClick={() => navigate('/settings')}
          className="focus-ring flex h-10 w-10 items-center justify-center rounded-lg text-text-secondary transition-colors hover:bg-surface hover:text-text"
          aria-label="设置"
        >
          <Bell size={18} />
        </button>
      </div>
    </header>
  )
}
