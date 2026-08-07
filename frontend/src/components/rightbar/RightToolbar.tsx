import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import {
  FileText,
  GitBranch,
  ScanSearch,
  TerminalSquare,
  Globe,
  FolderOpen,
  MessageSquare,
  X,
  PanelRightClose,
} from 'lucide-react'
import {
  SummaryPanel,
  GitPanel,
  ReviewPanel,
  TerminalGuidePanel,
  BrowserPanel,
  FilesPanel,
  MiniChatPanel,
} from './panels'
import { useApp } from '@/state/useApp'
import { MOTION_PRESETS } from '@/lib/motion-presets'

const TOOLS = [
  { id: 'summary', label: '摘要', icon: FileText },
  { id: 'git', label: 'Git', icon: GitBranch },
  { id: 'review', label: '审阅', icon: ScanSearch },
  { id: 'terminal', label: '终端', icon: TerminalSquare },
  { id: 'browser', label: '浏览器', icon: Globe },
  { id: 'files', label: '文件', icon: FolderOpen },
  { id: 'mini-chat', label: '迷你聊天', icon: MessageSquare },
] as const

/** 右侧工具台：属于画布层（canvas-raised），桌面常驻窄轨，移动端以抽屉浮层呈现。 */
export default function RightToolbar() {
  const open = useApp((s) => s.rightbarOpen)
  const setOpen = useApp((s) => s.setRightbarOpen)
  const active = useApp((s) => s.rightbarTool)
  const setActive = useApp((s) => s.setRightbarTool)
  const reduceMotion = useReducedMotion()

  const shell = (
    <div className="flex h-full flex-col">
      <div className="flex h-14 shrink-0 items-center justify-between border-b border-[var(--border)] px-3">
        <span className="text-sm font-semibold text-[var(--text)]">工具台</span>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="press hidden h-9 w-9 items-center justify-center rounded-lg text-[var(--text-muted)] transition-colors hover:bg-[var(--surface-hover)] hover:text-[var(--text)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] lg:flex"
          aria-label="收起工具台"
          title="收起工具台"
        >
          <PanelRightClose size={16} />
        </button>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="press flex h-9 w-9 items-center justify-center rounded-lg text-[var(--text-muted)] transition-colors hover:bg-[var(--surface-hover)] hover:text-[var(--text)] focus:outline-none lg:hidden"
          aria-label="关闭工具台"
        >
          <X size={18} />
        </button>
      </div>

      <div className="flex min-h-0 flex-1">
        {/* 工具图标轨 */}
        <nav
          aria-label="右侧工具"
          className="flex w-12 shrink-0 flex-col items-center gap-1 border-r border-[var(--border)] py-2"
        >
          {TOOLS.map((tool) => {
            const Icon = tool.icon
            const isActive = active === tool.id
            return (
              <button
                key={tool.id}
                type="button"
                onClick={() => setActive(tool.id)}
                aria-label={tool.label}
                aria-current={isActive ? 'true' : undefined}
                title={tool.label}
                className={`press flex h-10 w-10 items-center justify-center rounded-lg transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] ${
                  isActive
                    ? 'bg-[var(--accent-soft)] text-[var(--accent)]'
                    : 'text-[var(--text-muted)] hover:bg-[var(--surface-hover)] hover:text-[var(--text)]'
                }`}
              >
                <Icon size={17} />
              </button>
            )
          })}
        </nav>

        {/* 活动面板：切换时消费统一 fadeIn 预设 */}
        <div className="min-w-0 flex-1 overflow-y-auto" id="rightbar-panel">
          <AnimatePresence mode="wait" initial={false}>
            <motion.div
              key={active}
              className="h-full"
              initial={reduceMotion ? false : { opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={reduceMotion ? undefined : { opacity: 0, y: -4 }}
              transition={MOTION_PRESETS.fadeIn}
            >
              {active === 'summary' && <SummaryPanel />}
              {active === 'git' && <GitPanel />}
              {active === 'review' && <ReviewPanel />}
              {active === 'terminal' && <TerminalGuidePanel />}
              {active === 'browser' && <BrowserPanel />}
              {active === 'files' && <FilesPanel />}
              {active === 'mini-chat' && <MiniChatPanel />}
            </motion.div>
          </AnimatePresence>
        </div>
      </div>
    </div>
  )

  return (
    <>
      {/* 桌面端常驻右栏（画布层配色） */}
      <motion.aside
        aria-label="右侧工具台"
        className="canvas-surface hidden h-full shrink-0 overflow-hidden border-l border-[var(--border)] lg:block"
        initial={false}
        animate={reduceMotion ? { width: open ? 320 : 0 } : { width: open ? 320 : 0 }}
        transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1] }}
      >
        <div className="h-full w-80">{shell}</div>
      </motion.aside>

      {/* 移动端抽屉 */}
      <AnimatePresence>
        {open && (
          <div className="fixed inset-0 z-50 lg:hidden">
            <motion.div
              className="absolute inset-0 backdrop-glass"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setOpen(false)}
              aria-hidden="true"
            />
            <motion.div
              className="canvas-surface absolute inset-y-0 right-0 flex w-80 max-w-[85vw] flex-col border-l border-[var(--border)] shadow-2xl"
              initial={reduceMotion ? { opacity: 0 } : { x: '100%' }}
              animate={{ x: 0, opacity: 1 }}
              exit={reduceMotion ? { opacity: 0 } : { x: '100%' }}
              transition={MOTION_PRESETS.slideUp}
            >
              {shell}
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </>
  )
}
