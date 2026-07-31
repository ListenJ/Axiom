import { useNavigate } from 'react-router-dom'
import { Menu, Bell, Sun, Moon, Keyboard, Search } from 'lucide-react'
import { Button } from '@/components/ui'
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
    <header className="flex h-14 shrink-0 items-center justify-between gap-3 border-b border-[var(--border)] glass-sm px-4">
      {/* Left: Menu + Brand */}
      <div className="flex items-center gap-2">
        <Button
          variant="ghost"
          size="icon"
          onClick={onMenuClick}
          className="h-11 w-11 lg:hidden"
          aria-label="打开菜单"
          icon={<Menu size={20} />}
        />

        <button
          type="button"
          onClick={() => navigate('/')}
          className="press flex items-center gap-2 rounded-lg px-1 py-1 text-[var(--text)] transition-colors hover:bg-[var(--surface-hover)] focus:outline-none"
          aria-label="返回首页"
        >
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-[var(--accent)] to-[var(--accent-active)] text-sm font-bold text-white shadow-[var(--shadow-sm)]">
            OC
          </div>
          <span className="hidden font-display text-base font-semibold tracking-tight sm:inline">
            Axiom
          </span>
        </button>
      </div>

      {/* Center: Search */}
      <div className="hidden max-w-md flex-1 px-4 md:block">
        <button
          type="button"
          onClick={() => navigate('/search')}
          className="press flex h-9 w-full items-center gap-2 rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 text-left text-sm text-[var(--text-muted)] transition-colors hover:border-[var(--border-hover)] hover:text-[var(--text-secondary)] focus:outline-none"
          aria-label="打开搜索"
        >
          <Search className="size-3.5" />
          <span className="flex-1">搜索笔记与代码…</span>
          <kbd className="rounded border border-[var(--border)] bg-[var(--bg-tertiary)] px-1.5 py-0.5 font-mono text-2xs">/</kbd>
        </button>
      </div>

      {/* Right: Actions */}
      <div className="flex items-center gap-1">
        <Button
          variant="ghost"
          size="icon"
          onClick={() => openHelp(true)}
          className="h-11 w-11"
          aria-label="键盘快捷键"
          icon={<Keyboard size={18} />}
        />
        <Button
          variant="ghost"
          size="icon"
          onClick={toggleTheme}
          className="h-11 w-11"
          aria-label="切换主题"
          title="切换主题（Shift+T）"
          icon={theme === 'dark' ? <Sun size={18} /> : <Moon size={18} />}
        />
        <Button
          variant="ghost"
          size="icon"
          onClick={() => navigate('/settings')}
          className="h-11 w-11"
          aria-label="设置"
          icon={<Bell size={18} />}
        />
      </div>
    </header>
  )
}
