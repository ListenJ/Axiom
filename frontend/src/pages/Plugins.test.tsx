import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import Plugins from './Plugins'

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  available: vi.fn(),
  activeTools: vi.fn(),
  install: vi.fn(),
  uninstall: vi.fn(),
  enable: vi.fn(),
  disable: vi.fn(),
  config: vi.fn(),
  marketplaceList: vi.fn(),
  marketplaceInstallSkill: vi.fn(),
  marketplaceInstallMcp: vi.fn(),
}))

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    endpoints: {
      ...actual.endpoints,
      plugins: {
        list: mocks.list,
        available: mocks.available,
        activeTools: mocks.activeTools,
        install: mocks.install,
        uninstall: mocks.uninstall,
        enable: mocks.enable,
        disable: mocks.disable,
        config: mocks.config,
      },
      marketplace: {
        list: mocks.marketplaceList,
        installSkill: mocks.marketplaceInstallSkill,
        installMcp: mocks.marketplaceInstallMcp,
      },
    },
  }
})

describe('Plugins page integration', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    mocks.list.mockResolvedValue({ installed: [
      {
        id: 'plugin-1',
        name: 'Alpha Plugin',
        description: 'Does alpha things',
        enabled: true,
        version: '1.0.0',
        tools: ['alpha-tool'],
        config: { token: 'abc' },
      },
    ]})
    mocks.available.mockResolvedValue({
      available: [
        { id: 'plugin-2', name: 'Beta Plugin', description: 'Does beta things', author: 'Acme' },
      ],
    })
    mocks.activeTools.mockResolvedValue([
      { name: 'alpha-tool', description: 'Alpha tool', pluginId: 'plugin-1' },
    ])
    mocks.marketplaceList.mockResolvedValue({ skills: [], mcpServers: [], registries: [] })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  function renderPage() {
    return render(
      <MemoryRouter>
        <Routes>
          <Route path="/" element={<Plugins />} />
        </Routes>
      </MemoryRouter>
    )
  }

  it('renders installed plugins tab by default', async () => {
    renderPage()
    await waitFor(() => expect(screen.getByText('Alpha Plugin')).toBeInTheDocument())
    expect(screen.getByText('已启用')).toBeInTheDocument()
  })

  it('does not crash when marketplace returns a non-object (backend down)', async () => {
    mocks.marketplaceList.mockResolvedValue('<html>spa fallback index</html>')
    renderPage()
    await waitFor(() => expect(screen.getByText('Alpha Plugin')).toBeInTheDocument())
    expect(screen.getByText('已启用')).toBeInTheDocument()
  })

  it('switches to available tab and installs a plugin', async () => {
    renderPage()
    await waitFor(() => expect(screen.getByText('Alpha Plugin')).toBeInTheDocument())
    await userEvent.click(screen.getByRole('tab', { name: /可用插件/i }))
    await waitFor(() => expect(screen.getByText('Beta Plugin')).toBeInTheDocument())
    mocks.install.mockResolvedValue(undefined)
    mocks.list.mockResolvedValue({ installed: [
      {
        id: 'plugin-1',
        name: 'Alpha Plugin',
        description: 'Does alpha things',
        enabled: true,
        version: '1.0.0',
      },
      {
        id: 'plugin-2',
        name: 'Beta Plugin',
        description: 'Does beta things',
        enabled: true,
      },
    ]})
    mocks.available.mockResolvedValue({ available: [] })
    await userEvent.click(screen.getByRole('button', { name: /安装/i }))
    await waitFor(() => expect(mocks.install).toHaveBeenCalledWith('plugin-2', true))
  })

  it('toggles plugin enable state', async () => {
    mocks.disable.mockResolvedValue(undefined)
    renderPage()
    await waitFor(() => expect(screen.getByText('Alpha Plugin')).toBeInTheDocument())
    const row = screen.getByText('Alpha Plugin').closest('div[class*="rounded-xl"]')!
    const toggle = within(row as HTMLElement).getByTitle('禁用')
    await userEvent.click(toggle)
    await waitFor(() => expect(mocks.disable).toHaveBeenCalledWith('plugin-1'))
  })

  it('uninstalls a plugin', async () => {
    mocks.uninstall.mockResolvedValue(undefined)
    renderPage()
    await waitFor(() => expect(screen.getByText('Alpha Plugin')).toBeInTheDocument())
    const row = screen.getByText('Alpha Plugin').closest('div[class*="rounded-xl"]')!
    const uninstall = within(row as HTMLElement).getByTitle('卸载')
    await userEvent.click(uninstall)
    await waitFor(() => expect(mocks.uninstall).toHaveBeenCalledWith('plugin-1'))
  })

  it('shows active tools tab', async () => {
    renderPage()
    await waitFor(() => expect(screen.getByText('Alpha Plugin')).toBeInTheDocument())
    await userEvent.click(screen.getByRole('tab', { name: /活跃工具/i }))
    await waitFor(() => expect(screen.getByText('alpha-tool')).toBeInTheDocument())
  })
})
