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

/** 右侧工具台：按需弹出的悬浮抽屉（与工作区同材质 canvas-surface），
 *  贴合工作区上下边缘，圆角 + 阴影分隔，进入/退出以动画完成，不占位。 */
export default function RightToolbar() {
  const open = useApp((s) => s.rightbarOpen)
  const setOpen = useApp((s) => s.setRightbarOpen)
  const active = useApp((s) => s.rightbarTool)
  const setActive = useApp((s) => s.setRightbarTool)
  const reduceMotion = useReducedMotion()

  const shell = (
    <div className="flex h-full flex-col">
      <div className="flex h-[3.25rem] shrink-0 items-center justify-between px-4 pt-2.5 pb-1">
        <span className="text-sm font-semibold tracking-tight text-[var(--text)]">工具台</span>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="press flex size-9 items-center justify-center rounded-full text-[var(--text-secondary)] transition-colors hover:bg-[var(--surface-hover)] hover:text-[var(--text)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
          aria-label="收起工具台"
          title="收起工具台"
        >
          <X size={16} />
        </button>
      </div>

      <div className="flex min-h-0 flex-1">
        {/* 工具图标轨（无分割线，留白分区） */}
        <nav
          aria-label="右侧工具"
          className="flex w-12 shrink-0 flex-col items-center gap-1 py-2"
        >
          {TOOLS.map((tool) => {
            const Icon = tool.icon
            const isActive = active === tool.id
            return (
              <button
                key={tool.id}
                type="button"
                onClick={() => {
                  setActive(tool.id)
                  setOpen(true)
                }}
                aria-label={tool.label}
                aria-current={isActive ? 'true' : undefined}
                title={tool.label}
                className={`press flex size-10 items-center justify-center rounded-full transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] ${
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
    <AnimatePresence>
      {open && (
        <motion.div
          key="rightbar-overlay"
          aria-label="右侧工具台"
          role="complementary"
          className="overlay-glass absolute inset-y-2 right-2 z-30 flex w-[min(22rem,86vw)] flex-col overflow-hidden rounded-2xl sm:w-[min(25rem,62vw)]"
          initial={reduceMotion ? { opacity: 0 } : { x: '110%', opacity: 0, scale: 0.98 }}
          animate={{ x: 0, opacity: 1, scale: 1 }}
          exit={reduceMotion ? { opacity: 0 } : { x: '110%', opacity: 0, scale: 0.98 }}
          transition={{ duration: 0.32, ease: [0.16, 1, 0.3, 1] }}
        >
          {shell}
        </motion.div>
      )}
    </AnimatePresence>
  )
}
