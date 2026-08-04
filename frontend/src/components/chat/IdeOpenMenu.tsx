/**
 * IdeOpenMenu — "用 IDE / 文件管理器打开工作区" 下拉菜单
 *
 * 从 pages/Chat.tsx 拆出（纯展示组件），降低页面行数。
 */
import { Code2, FolderOpen, MousePointerClick } from 'lucide-react'
import type { OpenTarget } from '@/lib/open-in'

interface IdeOpenMenuProps {
  open: boolean
  onOpen: (target: OpenTarget) => void
}

export function IdeOpenMenu({ open, onOpen }: IdeOpenMenuProps) {
  if (!open) return null
  return (
    <div className="absolute right-0 top-full z-30 mt-1 w-44 rounded-lg border border-[var(--border)] bg-[var(--surface)] p-1 shadow-[var(--shadow-lg)]">
      <p className="px-2 pb-1 pt-1.5 text-2xs font-medium text-[var(--text-muted)]">
        用以下方式打开
      </p>
      <button
        type="button"
        onClick={() => onOpen('vscode')}
        className="press flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-[var(--text)] transition-colors hover:bg-[var(--canvas-hover)] focus:outline-none"
      >
        <Code2 size={14} className="shrink-0 text-[var(--text-muted)]" />
        VS Code
      </button>
      <button
        type="button"
        onClick={() => onOpen('cursor')}
        className="press flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-[var(--text)] transition-colors hover:bg-[var(--canvas-hover)] focus:outline-none"
      >
        <MousePointerClick size={14} className="shrink-0 text-[var(--text-muted)]" />
        Cursor
      </button>
      <button
        type="button"
        onClick={() => onOpen('file-manager')}
        className="press flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-[var(--text)] transition-colors hover:bg-[var(--canvas-hover)] focus:outline-none"
      >
        <FolderOpen size={14} className="shrink-0 text-[var(--text-muted)]" />
        文件管理器
      </button>
    </div>
  )
}
