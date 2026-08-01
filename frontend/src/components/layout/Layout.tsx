import { useEffect, useState } from 'react'
import { Outlet } from 'react-router-dom'
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
import { endpoints } from '@/lib/api'

export default function Layout() {
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [terminalOpen, setTerminalOpen] = useState(false)
  useGlobalHotkeys()
  useTheme()

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
      </div>

      {terminalOpen && (
        <div className="fixed inset-x-0 bottom-0 z-50">
          <TerminalPanel
            onExecute={async (command) => {
              try {
                const r = await endpoints.sandbox.execute({ command })
                return {
                  success: !!r.success,
                  stdout: r.stdout,
                  stderr: r.stderr ?? r.error,
                  exitCode: r.exitCode,
                  blocked: r.blocked,
                  reason: r.reason,
                }
              } catch (e) {
                return { success: false, error: String((e as Error)?.message ?? e) }
              }
            }}
            onClose={() => setTerminalOpen(false)}
          />
        </div>
      )}

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
