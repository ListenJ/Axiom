// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import Router from './Router'

const mocks = vi.hoisted(() => ({
  routerStatus: vi.fn(),
  routerHealth: vi.fn(),
  routerTokenStats: vi.fn(),
}))

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    endpoints: {
      ...actual.endpoints,
      router: {
        ...actual.endpoints.router,
        status: mocks.routerStatus,
        health: mocks.routerHealth,
        tokenStats: mocks.routerTokenStats,
      },
    },
  }
})

function stubMatchMedia() {
  if (typeof window.matchMedia === 'function') return
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as typeof window.matchMedia
}

describe('Router page — usage scenarios', () => {
  beforeEach(() => {
    stubMatchMedia()
    vi.resetAllMocks()
    mocks.routerStatus.mockResolvedValue({ status: 'healthy', models: 12 })
    mocks.routerHealth.mockResolvedValue({ healthy: 10, models: 12 })
    mocks.routerTokenStats.mockResolvedValue({ tokens: { used: 12345, total: 100000 } })
  })

  it('renders health, token usage and routing status from the API', async () => {
    render(
      <MemoryRouter>
        <Router />
      </MemoryRouter>,
    )

    // 健康模型数 + 模型总数
    expect(await screen.findByText('10')).toBeInTheDocument()
    expect(screen.getByText('共 12 个模型')).toBeInTheDocument()
    // Token 使用
    expect(screen.getByText('12,345')).toBeInTheDocument()
    // 路由状态
    expect(screen.getByText('healthy')).toBeInTheDocument()
  })

  it('degrades gracefully when one endpoint fails', async () => {
    mocks.routerHealth.mockRejectedValue(new Error('advisor down'))
    render(
      <MemoryRouter>
        <Router />
      </MemoryRouter>,
    )
    // 路由状态仍来自 status()，健康数缺失时显示占位符
    expect(await screen.findByText('healthy')).toBeInTheDocument()
    expect(screen.getByText('—')).toBeInTheDocument()
  })
})
