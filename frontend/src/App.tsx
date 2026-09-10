import { Component, lazy, Suspense, type ErrorInfo, type ReactNode } from 'react'
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import Layout from '@/components/layout/Layout'
import Button from '@/components/ui/Button'
import LoadingDots from '@/components/ui/LoadingDots'
import Chat from '@/pages/Chat'

// 路由级懒加载：主对话页保持 eager，其余页面按需分包（配合 vite manualChunks）
const Login = lazy(() => import('@/pages/Login'))
const Search = lazy(() => import('@/pages/Search'))
const Code = lazy(() => import('@/pages/Code'))
const Agents = lazy(() => import('@/pages/Agents'))
const Vault = lazy(() => import('@/pages/Vault'))
const KG = lazy(() => import('@/pages/KG'))
const Plugins = lazy(() => import('@/pages/Plugins'))
const Sessions = lazy(() => import('@/pages/Sessions'))
const Knowledge = lazy(() => import('@/pages/Knowledge'))
const Settings = lazy(() => import('@/pages/Settings'))
const Router = lazy(() => import('@/pages/Router'))
const Eval = lazy(() => import('@/pages/Eval'))
const Trends = lazy(() => import('@/pages/Trends'))
const OCR = lazy(() => import('@/pages/OCR'))
const Research = lazy(() => import('@/pages/Research'))
const Proxies = lazy(() => import('@/pages/Proxies'))
const Providers = lazy(() => import('@/pages/Providers'))
const Perf = lazy(() => import('@/pages/Perf'))
const Git = lazy(() => import('@/pages/Git'))
const Tokens = lazy(() => import('@/pages/Tokens'))

function PageFallback() {
  return (
    <div className="flex min-h-[50vh] w-full items-center justify-center" aria-busy="true" aria-label="页面加载中">
      <LoadingDots size="sm" />
    </div>
  )
}

interface ErrorBoundaryState {
  error: Error | null
}

class ErrorBoundary extends Component<{ children: ReactNode }, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[App] Unhandled render error', error, info.componentStack)
  }

  private handleRetry = (): void => {
    this.setState({ error: null })
  }

  render(): ReactNode {
    if (this.state.error) {
      return (
        <div className="flex h-screen flex-col items-center justify-center gap-4 bg-[var(--surface)] p-6 text-center">
          <h1 className="text-lg font-semibold text-[var(--text)]">出错了</h1>
          <p className="max-w-md text-sm text-[var(--text-muted)]">
            页面渲染时发生意外错误，可重试恢复。若问题持续，请查看控制台日志。
          </p>
          <pre className="max-w-md overflow-auto rounded-lg bg-[var(--surface-hover)] p-3 text-left text-xs text-[var(--text-muted)]">
            {this.state.error.message}
          </pre>
          <Button onClick={this.handleRetry}>重试</Button>
        </div>
      )
    }
    return this.props.children
  }
}

function App() {
  return (
    <BrowserRouter>
      <ErrorBoundary>
        <Suspense fallback={<PageFallback />}>
          <Routes>
            {/* 登录页独立于 Layout：仅 401 时由 api 客户端强制跳转（见 lib/api.ts） */}
            <Route path="/login" element={<Login />} />
            <Route path="/" element={<Layout />}>
              {/* 首页与对话合并："/" 直接进入对话页（无消息时显示欢迎模式） */}
              <Route index element={<Navigate to="/chat" replace />} />
              <Route path="chat" element={<Chat />} />
              <Route path="search" element={<Search />} />
              <Route path="code" element={<Code />} />
              <Route path="agents" element={<Agents />} />
              <Route path="router" element={<Router />} />
              <Route path="vault" element={<Vault />} />
              <Route path="kg" element={<KG />} />
              <Route path="sessions" element={<Sessions />} />
              <Route path="eval" element={<Eval />} />
              <Route path="plugins" element={<Plugins />} />
              <Route path="trends" element={<Trends />} />
              <Route path="ocr" element={<OCR />} />
              <Route path="research" element={<Research />} />
              <Route path="knowledge" element={<Knowledge />} />
              <Route path="proxies" element={<Proxies />} />
              <Route path="providers" element={<Providers />} />
              <Route path="tokens" element={<Tokens />} />
              <Route path="perf" element={<Perf />} />
              <Route path="git" element={<Git />} />
              <Route path="settings" element={<Settings />} />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Route>
          </Routes>
        </Suspense>
      </ErrorBoundary>
    </BrowserRouter>
  )
}

export default App