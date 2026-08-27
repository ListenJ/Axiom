import { AnimatePresence, motion } from 'framer-motion'
import type { ReactNode } from 'react'
import { X } from 'lucide-react'
import { MOTION_PRESETS } from '@/lib/motion-presets'

export interface SlashCommand {
  id: string
  label: string
  description: string
  icon: ReactNode
  run: () => void
}

interface SlashCommandMenuProps {
  open: boolean
  query: string
  commands: SlashCommand[]
  selectedIndex: number
  onPick: (command: SlashCommand) => void
  onClose: () => void
}

/** 聊天输入框 / 命令面板：纯展示 + 键盘高亮，动作由 ChatComposer 注入。 */
export default function SlashCommandMenu({
  open,
  query,
  commands,
  selectedIndex,
  onPick,
  onClose,
}: SlashCommandMenuProps) {
  const activeId = commands[selectedIndex] ? `slash-option-${commands[selectedIndex].id}` : undefined

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          role="listbox"
          aria-label="命令面板"
          aria-activedescendant={activeId}
          className="absolute bottom-full left-3 z-30 mb-2 w-[min(20rem,calc(100vw-2rem))] overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--surface)] shadow-[var(--shadow-lg)]"
          initial={{ opacity: 0, y: 6, scale: 0.98 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: 6, scale: 0.98 }}
          transition={MOTION_PRESETS.fadeIn}
        >
          <div className="flex items-center justify-between border-b border-[var(--border)] px-3 py-2">
            <p className="text-2xs font-medium text-[var(--text-muted)]">命令</p>
            <button
              type="button"
              onClick={onClose}
              aria-label="关闭命令面板"
              className="press flex size-6 items-center justify-center rounded text-[var(--text-muted)] hover:bg-[var(--surface-hover)] hover:text-[var(--text)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
            >
              <X size={12} />
            </button>
          </div>
          <div className="max-h-72 overflow-y-auto p-1.5">
            {commands.length === 0 ? (
              <p className="px-2 py-3 text-center text-2xs text-[var(--text-muted)]">
                没有匹配“/{query}”的命令
              </p>
            ) : (
              <ul role="presentation" className="space-y-0.5">
                {commands.map((cmd, idx) => {
                  const active = idx === selectedIndex
                  return (
                    <li key={cmd.id} role="presentation">
                      <button
                        id={`slash-option-${cmd.id}`}
                        type="button"
                        role="option"
                        aria-selected={active}
                        onClick={() => onPick(cmd)}
                        className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] ${
                          active ? 'bg-[var(--accent-soft)] text-[var(--accent)]' : 'text-[var(--text-secondary)] hover:bg-[var(--surface-hover)]'
                        }`}
                      >
                        <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-[var(--bg-tertiary)] text-[var(--text-muted)]">
                          {cmd.icon}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block font-mono text-xs font-medium">{cmd.label}</span>
                          <span className="block truncate text-2xs text-[var(--text-muted)]">{cmd.description}</span>
                        </span>
                      </button>
                    </li>
                  )
                })}
              </ul>
            )}
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
