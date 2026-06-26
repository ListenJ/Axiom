import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import Perf from './Perf'

const mocks = vi.hoisted(() => ({
  metrics: vi.fn(),
  native: vi.fn(),
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
    },
  }
})

describe('Perf page integration', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    mocks.metrics.mockResolvedValue({ cpu: 12.5, memory: 45.2, rps: 120, p50: 20, p95: 80 })
    mocks.native.mockResolvedValue({ tauriVersion: '2.0', arch: 'x86_64' })
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
    expect(screen.getByText(/2.0/i)).toBeInTheDocument()
  })

  it('handles HTML string native response gracefully', async () => {
    mocks.native.mockResolvedValue('<html><body>error</body></html>')
    renderPage()
    await waitFor(() => expect(screen.getByText('原生模块未启用或暂无数据。')).toBeInTheDocument())
  })

  it('shows error banner on metrics failure', async () => {
    mocks.metrics.mockRejectedValue(new Error('network down'))
    mocks.native.mockResolvedValue(null)
    renderPage()
    await waitFor(() => expect(screen.getByText(/network down/i)).toBeInTheDocument())
  })
})
