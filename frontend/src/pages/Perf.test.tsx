import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import Perf from './Perf'

const mocks = vi.hoisted(() => ({
  metrics: vi.fn(),
  native: vi.fn(),
  tokenDetails: vi.fn(),
}))

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    endpoints: {
      ...actual.endpoints,
      perf: {
        metrics: mocks.metrics,
        native: mocks.native,
      },
      tokenDetails: mocks.tokenDetails,
    },
  }
})

describe('Perf page integration', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    mocks.metrics.mockResolvedValue({ cpu: 12.5, memory: 45.2, rps: 120, p50: 20, p95: 80 })
    mocks.native.mockResolvedValue({ tauriVersion: '2.0', arch: 'x86_64' })
    mocks.tokenDetails.mockResolvedValue({ overall: { costUsd: 1.76, costCny: 12.672, totalTokens: 2000000 } })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  function renderPage() {
    return render(
      <MemoryRouter>
        <Routes>
          <Route path="/" element={<Perf />} />
        </Routes>
      </MemoryRouter>
    )
  }

  it('renders metrics after loading', async () => {
    renderPage()
    await waitFor(() => expect(screen.getByText('12.5%')).toBeInTheDocument())
    expect(screen.getByText('45.2%')).toBeInTheDocument()
    expect(screen.getByText('120')).toBeInTheDocument()
    expect(screen.getByText('80ms')).toBeInTheDocument()
  })

  it('renders native module data as json', async () => {
    renderPage()
    await waitFor(() => expect(screen.getByText(/tauriVersion/i)).toBeInTheDocument())
    expect(screen.getByText(/x86_64/)).toBeInTheDocument()
  })

  it('handles HTML string native response gracefully', async () => {
    mocks.native.mockResolvedValue('<html><body>error</body></html>')
    renderPage()
    await waitFor(() => expect(screen.getByText('原生模块未启用或暂无数据。')).toBeInTheDocument())
  })

  it('renders near-7-day model cost card', async () => {
    renderPage()
    expect(await screen.findByText('近 7 天模型成本')).toBeInTheDocument()
    await waitFor(() => expect(screen.getByText(/\$1\.760/)).toBeInTheDocument())
    await waitFor(() => expect(screen.getByText(/¥12\.67/)).toBeInTheDocument())
    expect(screen.getByText(/含 DeepSeek 峰谷计价/)).toBeInTheDocument()
  })

  it('shows error banner on metrics failure', async () => {
    mocks.metrics.mockRejectedValue(new Error('network down'))
    mocks.native.mockResolvedValue(null)
    renderPage()
    const banner = await screen.findByRole('alert')
    expect(banner).toHaveTextContent('部分指标暂不可用，请稍后重试。')
    // 原始错误保留在 title 中供调试，不再直接暴露给普通用户
    expect(banner).toHaveAttribute('title', 'network down')
  })
})
