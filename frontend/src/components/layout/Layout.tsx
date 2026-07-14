import { useState } from 'react'
import { Outlet } from 'react-router-dom'
import Header from './Header'
import Sidebar from './Sidebar'
import BottomNav from './BottomNav'
import StatsBar from './StatsBar'
import HelpModal from '@/components/ui/HelpModal'
import Toasts from '@/components/ui/Toasts'
import { useGlobalHotkeys } from '@/hooks/useGlobalHotkeys'
import { useTheme } from '@/hooks/useTheme'

export default function Layout() {
  const [sidebarOpen, setSidebarOpen] = useState(false)
  useGlobalHotkeys()
  useTheme()

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-bg text-text">
      <Sidebar open={sidebarOpen} onClose={() => setSidebarOpen(false)} />

      <div className="flex min-w-0 flex-1 flex-col">
        <Header onMenuClick={() => setSidebarOpen(true)} />

        <main className="flex min-h-0 flex-1 flex-col overflow-y-auto p-4 md:p-6">
          <div className="min-w-0 flex-1">
            <Outlet />
          </div>
        </main>

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
    </div>
  )
}
