import { Menu, Bell, Settings, Search } from 'lucide-react'

interface HeaderProps {
  onMenuClick: () => void
}

export default function Header({ onMenuClick }: HeaderProps) {
  return (
    <header className="flex h-14 shrink-0 items-center justify-between border-b border-border bg-bg-secondary px-4">
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={onMenuClick}
          className="flex h-10 w-10 items-center justify-center rounded-lg text-text-secondary transition-colors hover:bg-surface hover:text-text lg:hidden"
          aria-label="打开菜单"
        >
          <Menu size={20} />
        </button>

        <div className="flex items-center gap-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-accent font-bold text-white">
            OC
          </div>
          <span className="hidden text-base font-semibold sm:inline">OpenClaw</span>
        </div>
      </div>

      <div className="hidden max-w-md flex-1 px-4 md:block">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-text-muted" />
          <input
            type="text"
            placeholder="搜索..."
            className="h-9 w-full rounded-lg border border-border bg-bg pl-9 pr-4 text-sm text-text placeholder:text-text-muted focus:border-accent focus:outline-none"
          />
        </div>
      </div>

      <div className="flex items-center gap-1 sm:gap-2">
        <button
          type="button"
          className="flex h-10 w-10 items-center justify-center rounded-lg text-text-secondary transition-colors hover:bg-surface hover:text-text"
          aria-label="通知"
        >
          <Bell size={20} />
        </button>
        <a
          href="#/settings"
          className="flex h-10 w-10 items-center justify-center rounded-lg text-text-secondary transition-colors hover:bg-surface hover:text-text"
          aria-label="设置"
        >
          <Settings size={20} />
        </a>
        <div className="ml-1 hidden h-8 w-8 items-center justify-center rounded-full bg-accent/20 text-sm font-medium text-accent sm:flex">
          U
        </div>
      </div>
    </header>
  )
}
