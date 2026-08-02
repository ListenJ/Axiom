import { useEffect, useState } from 'react'
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

export default function Layout() {
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [terminalOpen, setTerminalOpen] = useState(false)
  useGlobalHotkeys()
  useTheme()
  const reduceMotion = useReducedMotion()

  // 终端栏全局快捷键：Ctrl+` / Ctrl+Shift+` 开合
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.key === '`' || e.key === 'Backquote') && (e.ctrlKey || e.metaKey)) {
        e.preventDefault()
        setTerminalOpen((v) => !v)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // HITL 审批：订阅 /ws 的 approval.requested 事件，卸载时断开
  useEffect(() => {
    useApprovals.getState().connect()
    return () => useApprovals.getState().disconnect()
  }, [])

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-bg text-text">
      <Sidebar open={sidebarOpen} onClose={() => setSidebarOpen(false)} />

      <div className="flex min-w-0 flex-1 flex-col">
        <Header
          onMenuClick={() => setSidebarOpen(true)}
          onTerminalToggle={() => setTerminalOpen((v) => !v)}
          terminalOpen={terminalOpen}
        />

        <main className="flex min-h-0 flex-1 flex-col overflow-y-auto p-4 md:p-6">
          <div className="min-w-0 flex-1">
            <Outlet />
          </div>
        </main>

        <StatsBar />
        <BottomNav />

        {/* 终端栏：作为底部面板升起（slide-up 动画），流式挤压主内容区 */}
        <AnimatePresence>
          {terminalOpen && (
            <motion.div
              className="shrink-0"
              initial={reduceMotion ? false : { y: '100%', opacity: 0 }}
              animate={{ y: 0, opacity: 1 }}
              exit={reduceMotion ? undefined : { y: '100%', opacity: 0 }}
              transition={{ duration: 0.28, ease: [0.25, 0.46, 0.45, 0.94] }}
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
