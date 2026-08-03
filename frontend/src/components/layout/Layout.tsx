import { useEffect } from 'react'
import { Outlet } from 'react-router-dom'
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import Header from './Header'
import Sidebar from './Sidebar'
import BottomNav from './BottomNav'
import StatsBar from './StatsBar'
import HelpModal from '@/components/ui/HelpModal'
import Toasts from '@/components/ui/Toasts'
import ApprovalModal from '@/components/ApprovalModal'
import { TerminalPanel } from '@/components/terminal/TerminalPanel'
import { useApprovals } from '@/state/useApprovals'
import { useGlobalHotkeys } from '@/hooks/useGlobalHotkeys'
import { useTheme } from '@/hooks/useTheme'
import { useApp } from '@/state/useApp'
import { MOTION_PRESETS } from '@/lib/motion-presets'

export default function Layout() {
  const sidebarOpen = useApp((s) => s.sidebarOpen)
  const setSidebarOpen = useApp((s) => s.setSidebarOpen)
  const terminalOpen = useApp((s) => s.terminalOpen)
  const setTerminalOpen = useApp((s) => s.setTerminalOpen)
  useGlobalHotkeys()
  useTheme()
  const reduceMotion = useReducedMotion()

  // HITL 审批：订阅 /ws 的 approval.requested 事件，卸载时断开
  useEffect(() => {
    useApprovals.getState().connect()
    return () => useApprovals.getState().disconnect()
  }, [])

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-bg text-text">
      <Sidebar open={sidebarOpen} onClose={() => setSidebarOpen(false)} />

      <div className="flex min-w-0 flex-1 flex-col">
        <Header onMenuClick={() => setSidebarOpen(true)} />

        {/* 画布层：聊天/页面内容（右侧工具台仅挂载于聊天页，见 pages/Chat.tsx） */}
        <main className="canvas-surface flex min-h-0 flex-1 flex-col">
          <div className="min-w-0 flex-1 overflow-y-auto">
            <div className="h-full px-4 py-4 md:px-6 md:py-6">
              <Outlet />
            </div>
          </div>
        </main>

        <StatsBar />
        <BottomNav />

        {/* 终端栏：fixed 底部覆盖式浮层（slide-up 动画），升起在底栏 StatsBar 之上，
            不挤压主内容；移动端让出 BottomNav 高度 */}
        <AnimatePresence>
          {terminalOpen && (
            <motion.div
              className="fixed inset-x-0 bottom-24 z-50 lg:bottom-8"
              initial={reduceMotion ? false : { y: '100%', opacity: 0 }}
              animate={{ y: 0, opacity: 1 }}
              exit={reduceMotion ? undefined : { y: '100%', opacity: 0 }}
              transition={MOTION_PRESETS.slideUp}
            >
              <TerminalPanel onClose={() => setTerminalOpen(false)} />
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {sidebarOpen && (
        <div
          className="fixed inset-0 z-40 backdrop-glass lg:hidden"
          onClick={() => setSidebarOpen(false)}
          aria-hidden="true"
        />
      )}

      <HelpModal />
      <Toasts />
      <ApprovalModal />
    </div>
  )
}
