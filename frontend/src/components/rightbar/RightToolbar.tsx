import { useEffect, useState } from 'react'
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
  // 桌面在流内面板 / 移动抽屉：按视口切换，保证同一时刻只有一个 complementary 元素
  const [isMobile, setIsMobile] = useState(
    () => typeof window !== 'undefined' && window.matchMedia('(max-width: 1023px)').matches,
  )
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 1023px)')
    const onChange = () => setIsMobile(mq.matches)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])

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
    <>
      {/* 桌面端：在流内面板（非侵入），宽度动画展开/收起，工作区自适应不遮挡 */}
      {!isMobile && (
        <motion.div
          aria-label="右侧工具台"
          role="complementary"
          className="h-full shrink-0 overflow-hidden"
          initial={false}
          animate={{ width: open ? 400 : 0 }}
          transition={{ duration: 0.32, ease: [0.16, 1, 0.3, 1] }}
        >
          <div className="overlay-glass panel-shadow-left h-full w-[min(25rem,62vw)]">
            {shell}
          </div>
        </motion.div>
      )}

      {/* 移动端：抽屉浮层（小屏无空间容纳在流内面板） */}
      {isMobile && (
        <AnimatePresence>
          {open && (
            <div className="fixed inset-0 z-50">
              <motion.div
                className="absolute inset-0 backdrop-glass"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                onClick={() => setOpen(false)}
                aria-hidden="true"
              />
              <motion.div
                role="complementary"
                aria-label="右侧工具台"
                className="overlay-glass absolute inset-y-0 right-0 flex w-[min(22rem,86vw)] flex-col elevation-4"
                initial={reduceMotion ? { opacity: 0 } : { x: '100%' }}
                animate={{ x: 0, opacity: 1 }}
                exit={reduceMotion ? { opacity: 0 } : { x: '100%' }}
                transition={{ duration: 0.32, ease: [0.16, 1, 0.3, 1] }}
              >
                {shell}
              </motion.div>
            </div>
          )}
        </AnimatePresence>
      )}
    </>
  )
}
