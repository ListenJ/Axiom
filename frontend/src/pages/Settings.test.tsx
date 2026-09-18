// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import Settings from './Settings'

const mocks = vi.hoisted(() => ({
  permGetMode: vi.fn(),
  permSetMode: vi.fn(),
  agentsStatus: vi.fn(),
  systemEngines: vi.fn(),
  apiGet: vi.fn(),
  apiClearCache: vi.fn(),
}))

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    api: { ...actual.api, get: mocks.apiGet, clearCache: mocks.apiClearCache },
    endpoints: {
      ...actual.endpoints,
      permissions: { ...actual.endpoints.permissions, getMode: mocks.permGetMode, setMode: mocks.permSetMode },
      agents: { ...actual.endpoints.agents, status: mocks.agentsStatus },
      system: { ...actual.endpoints.system, engines: mocks.systemEngines },
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

function renderPage() {
  return render(
    <MemoryRouter>
      <Settings />
    </MemoryRouter>,
  )
}

describe('Settings page — usage scenarios', () => {
  beforeEach(() => {
    stubMatchMedia()
    vi.resetAllMocks()
    mocks.permGetMode.mockResolvedValue({ autoAccept: false })
    mocks.permSetMode.mockResolvedValue({ autoAccept: true })
    mocks.agentsStatus.mockResolvedValue({ agents: [] })
    mocks.systemEngines.mockResolvedValue({
      engines: [
        { name: 'duckduckgo', available: true },
        { name: 'brave', available: false },
      ],
    })
    mocks.apiGet.mockResolvedValue({ gateway: { port: 18789, bind: '0.0.0.0' } })
  })

  it('renders the settings header and the default-open appearance section', async () => {
    renderPage()
    expect(screen.getByRole('heading', { name: '设置' })).toBeInTheDocument()
    expect(screen.getByText('主题')).toBeInTheDocument()
    expect(screen.getByText('Agent 颜色')).toBeInTheDocument()
  })

  it('switches theme via the appearance radio group', async () => {
    renderPage()
    const dark = screen.getByRole('radio', { name: '深色主题' })
    await userEvent.click(dark)
    expect(dark).toHaveAttribute('aria-checked', 'true')
  })

  it('toggles the global permission mode in the behavior section', async () => {
    renderPage()
    await userEvent.click(await screen.findByRole('button', { name: /对话与行为/ }))
    const toggle = await screen.findByRole('switch', { name: '切换 全局权限自动接收' })
    await userEvent.click(toggle)
    await waitFor(() => expect(mocks.permSetMode).toHaveBeenCalledWith(true))
    expect(mocks.permGetMode).toHaveBeenCalled()
  })
})
