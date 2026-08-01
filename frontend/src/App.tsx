import { Component, type ErrorInfo, type ReactNode } from 'react'
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import Layout from '@/components/layout/Layout'
import Button from '@/components/ui/Button'
import Chat from '@/pages/Chat'
import Login from '@/pages/Login'
import Search from '@/pages/Search'
import Code from '@/pages/Code'
import Agents from '@/pages/Agents'
import Vault from '@/pages/Vault'
import KG from '@/pages/KG'
import Plugins from '@/pages/Plugins'
import Sessions from '@/pages/Sessions'
import Knowledge from '@/pages/Knowledge'
import Settings from '@/pages/Settings'
import Router from '@/pages/Router'
import Eval from '@/pages/Eval'
import Trends from '@/pages/Trends'
import OCR from '@/pages/OCR'
import Research from '@/pages/Research'
import Proxies from '@/pages/Proxies'
import Providers from '@/pages/Providers'
import Perf from '@/pages/Perf'
import Git from '@/pages/Git'
import Tokens from '@/pages/Tokens'

interface ErrorBoundaryState {
  error: Error | null
}

class ErrorBoundary extends Component<{ children: ReactNode }, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // eslint-disable-next-line no-console
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
        <Routes>
          {/* 登录页独立于 Layout：仅 401 时由 api 客户端强制跳转（见 lib/api.ts） */}
          <Route path="/login" element={<Login />} />
          <Route path="/" element={<Layout />}>
            {/* 首页与对话合并："/" 直接进入对话页（无消息时显示欢迎模式） */}
            <Route index element={<Chat />} />
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
      </ErrorBoundary>
    </BrowserRouter>
  )
}

export default App