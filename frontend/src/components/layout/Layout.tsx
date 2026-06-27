import { useCallback, useState } from 'react'
import { Outlet } from 'react-router-dom'
import Header from './Header'
import Sidebar from './Sidebar'
import BottomNav from './BottomNav'
import OpeningAnimation from './OpeningAnimation'
import HelpModal from '@/components/ui/HelpModal'
import Toasts from '@/components/ui/Toasts'
import { useGlobalHotkeys } from '@/hooks/useGlobalHotkeys'
import { useTheme } from '@/hooks/useTheme'

export default function Layout() {
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [animDone, setAnimDone] = useState(() => {
    // Skip animation on subsequent navigations (session storage)
    try { return sessionStorage.getItem('oc:animDone') === '1' } catch { return false }
  })

  useGlobalHotkeys()
  useTheme()

  const handleAnimComplete = useCallback(() => {
    try { sessionStorage.setItem('oc:animDone', '1') } catch {}
    setAnimDone(true)
  }, [])

  return (
    <>
      {!animDone && <OpeningAnimation onComplete={handleAnimComplete} />}

      <div className="flex h-screen w-screen overflow-hidden bg-bg text-text">
        <Sidebar open={sidebarOpen} onClose={() => setSidebarOpen(false)} />

        <div className="flex min-w-0 flex-1 flex-col">
          <Header onMenuClick={() => setSidebarOpen(true)} />

          <main className="flex min-h-0 flex-1 flex-col overflow-y-auto p-4 md:p-6">
            <div className="min-w-0 flex-1">
              <Outlet />
            </div>
          </main>

          <BottomNav />
        </div>

        {sidebarOpen && (
          <div
            className="fixed inset-0 z-40 bg-black/50 backdrop-blur-sm lg:hidden"
            onClick={() => setSidebarOpen(false)}
            aria-hidden="true"
          />
        )}

        <HelpModal />
        <Toasts />
      </div>
    </>
  )
}
