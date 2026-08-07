import { useEffect } from 'react'
import { Outlet, useLocation } from 'react-router-dom'
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
import { useMotion } from '@/hooks/useMotion'
import { MOTION_PRESETS } from '@/lib/motion-presets'

export default function Layout() {
  const sidebarOpen = useApp((s) => s.sidebarOpen)
  const setSidebarOpen = useApp((s) => s.setSidebarOpen)
  const terminalOpen = useApp((s) => s.terminalOpen)
  const setTerminalOpen = useApp((s) => s.setTerminalOpen)
  useGlobalHotkeys()
  useTheme()
  const reduceMotion = useReducedMotion()
  const location = useLocation()
  const { enabled: pageMotionEnabled } = useMotion()

  // HITL 审批：订阅 /ws 的 approval.requested 事件，卸载时断开
  useEffect(() => {
    useApprovals.getState().connect()
    return () => useApprovals.getState().disconnect()
  }, [])

  return (
    <div className="isolate flex h-screen w-screen overflow-hidden bg-bg text-text">
      {/* 丝绸纹理底层 + Aurora 光斑：被外壳/画布毛玻璃层磨砂透出（z 序最底） */}
      <div className="silk-bg" aria-hidden="true" />
      <div className="silk-aurora" aria-hidden="true" />
      <div className="silk-aurora-extra" aria-hidden="true" />
      <div className="silk-sheen" aria-hidden="true" />
      <div className="silk-ribs" aria-hidden="true" />
      <div className="silk-fluid" aria-hidden="true" />
      <div className="silk-fluid-extra" aria-hidden="true" />
      <div className="silk-swirl" aria-hidden="true" />

      <Sidebar open={sidebarOpen} onClose={() => setSidebarOpen(false)} />

      <div className="flex min-w-0 flex-1 flex-col">
        <Header onMenuClick={() => setSidebarOpen(true)} />

        {/* 画布层：聊天/页面内容（右侧工具台仅挂载于聊天页，见 pages/Chat.tsx） */}
        <main className="canvas-surface flex min-h-0 flex-1 flex-col">
          <div className="min-w-0 flex-1 overflow-y-auto">
            <div className="h-full px-4 py-4 md:px-6 md:py-6">
              {/* 路由级页面过渡：全站唯一入口（mode="wait" 先退场再入场），
                  消费 MOTION_PRESETS.pageEnter；off/reduced 时静态渲染 */}
              {pageMotionEnabled ? (
                <AnimatePresence mode="wait">
                  <motion.div
                    key={location.pathname}
                    className="h-full"
                    initial={{ opacity: 0, y: 6 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -6 }}
                    transition={MOTION_PRESETS.pageEnter}
                  >
                    <Outlet />
                  </motion.div>
                </AnimatePresence>
              ) : (
                <Outlet />
              )}
            </div>
          </div>
        </main>

        {/* 终端栏：布局内嵌（main 与 StatsBar 之间占位），不遮挡工作区内容；
            开合以高度动画过渡，高度可由面板顶部手柄拖拽调整 */}
        <AnimatePresence>
          {terminalOpen && (
            <motion.div
              className="shrink-0 overflow-hidden"
              initial={reduceMotion ? { opacity: 0 } : { height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={reduceMotion ? { opacity: 0 } : { height: 0, opacity: 0 }}
              transition={MOTION_PRESETS.slideUp}
            >
              <TerminalPanel onClose={() => setTerminalOpen(false)} />
            </motion.div>
          )}
        </AnimatePresence>

        <StatsBar />
        <BottomNav />
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
