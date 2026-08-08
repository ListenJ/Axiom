import { useEffect } from 'react'
import { Outlet, useLocation } from 'react-router-dom'
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import Header from './Header'
import Sidebar from './Sidebar'
import BottomNav from './BottomNav'
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
  const panelOpacity = useApp((s) => s.panelOpacity)
  const terminalOpen = useApp((s) => s.terminalOpen)
  const setTerminalOpen = useApp((s) => s.setTerminalOpen)
  const terminalOverlay = useApp((s) => s.terminalOverlay)
  useGlobalHotkeys()
  useTheme()
  const reduceMotion = useReducedMotion()
  const location = useLocation()
  const { level: motionLevel, enabled: pageMotionEnabled } = useMotion()

  // 动效强度同步到根节点：off/reduced 时停掉丝绸背景动画（回收合成层，省 VRAM/GPU）
  useEffect(() => {
    document.documentElement.dataset.motion = motionLevel
  }, [motionLevel])

  // 悬浮面板透明度 → CSS 变量（overlay-glass 等消费），实时生效
  useEffect(() => {
    document.documentElement.style.setProperty('--panel-alpha', String(panelOpacity))
  }, [panelOpacity])

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

        {/* 终端栏：默认覆盖式浮层（不占位、不推挤页面）；设置可切回内嵌式 */}
        <AnimatePresence>
          {terminalOpen && (
            <motion.div
              className={terminalOverlay ? 'fixed inset-x-0 bottom-0 z-40' : 'shrink-0 overflow-hidden'}
              initial={reduceMotion ? { opacity: 0 } : terminalOverlay ? { y: '100%', opacity: 0 } : { height: 0, opacity: 0 }}
              animate={terminalOverlay ? { y: 0, opacity: 1 } : { height: 'auto', opacity: 1 }}
              exit={reduceMotion ? { opacity: 0 } : terminalOverlay ? { y: '100%', opacity: 0 } : { height: 0, opacity: 0 }}
              transition={MOTION_PRESETS.slideUp}
            >
              <TerminalPanel onClose={() => setTerminalOpen(false)} />
            </motion.div>
          )}
        </AnimatePresence>
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
