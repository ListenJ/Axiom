// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import Sidebar from './Sidebar'

const mocks = vi.hoisted(() => ({
  health: vi.fn(),
  workspaces: vi.fn(),
  sessions: vi.fn(),
}))

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    endpoints: {
      ...actual.endpoints,
      system: { ...actual.endpoints.system, health: mocks.health },
      workspaces: { ...actual.endpoints.workspaces, list: mocks.workspaces },
      memory: { ...actual.endpoints.memory, sessions: mocks.sessions },
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

function renderSidebar() {
  return render(
    <MemoryRouter>
      <Sidebar open onClose={() => {}} />
    </MemoryRouter>,
  )
}

beforeEach(() => {
  stubMatchMedia()
  vi.resetAllMocks()
  mocks.workspaces.mockResolvedValue({ workspaces: [] })
  mocks.sessions.mockResolvedValue({ sessions: [] })
})

describe('P3.5C Sidebar /health 降级展示', () => {
  it('在线但存在降级时显示徽标，title 列出全部原因', async () => {
    mocks.health.mockResolvedValue({
      status: 'ok',
      version: '4.0.0',
      toolRuntime: { vault: 'ok', searchEngine: 'ok', degraded: ['search-engine-unavailable'] },
      sceneRouter: { totalScenes: 23, availableScenes: 5, degraded: true, missingTools: ['web_search'] },
      security: { secondFactor: { configured: false } },
    })
    renderSidebar()

    expect(await screen.findByText('在线')).toBeInTheDocument()
    const badge = await screen.findByLabelText(/服务降级/)
    const title = badge.getAttribute('title') ?? ''
    expect(title).toContain('统一搜索不可用')
    expect(title).toContain('场景降级（5/23 可用）')
    expect(title).toContain('二因子未配置（只读放行）')
  })

  it('全部健康时不显示降级徽标', async () => {
    mocks.health.mockResolvedValue({
      status: 'ok',
      toolRuntime: { vault: 'ok', searchEngine: 'ok', degraded: [] },
      sceneRouter: { totalScenes: 23, availableScenes: 23, degraded: false },
      security: { secondFactor: { configured: true } },
    })
    renderSidebar()

    expect(await screen.findByText('在线')).toBeInTheDocument()
    expect(screen.queryByLabelText(/服务降级/)).toBeNull()
  })

  it('服务不可达时显示「服务不可达」，不显示降级徽标', async () => {
    mocks.health.mockRejectedValue(new Error('down'))
    renderSidebar()

    expect(await screen.findByText('服务不可达')).toBeInTheDocument()
    expect(screen.queryByLabelText(/服务降级/)).toBeNull()
  })
})
