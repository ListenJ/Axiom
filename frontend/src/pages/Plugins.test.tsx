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

  // --- 三态（loading/error/empty）回归：首屏失败必须进入错误态，不得静默假空态 ---

  it('shows a load error with retry (not an empty state) when the first load fails', async () => {
    mocks.list.mockRejectedValue(new Error('boom'))
    mocks.available.mockRejectedValue(new Error('boom'))
    mocks.activeTools.mockRejectedValue(new Error('boom'))
    mocks.marketplaceList.mockRejectedValue(new Error('boom'))

    renderPage()

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('加载失败')
    expect(screen.getByRole('button', { name: '重试' })).toBeInTheDocument()
    // 失败不得伪装成「确实没有数据」
    expect(screen.queryByText('暂无已安装插件')).not.toBeInTheDocument()
  })

  it('recovers when 重试 succeeds after a failed first load', async () => {
    mocks.list.mockRejectedValue(new Error('boom'))
    mocks.available.mockRejectedValue(new Error('boom'))
    mocks.activeTools.mockRejectedValue(new Error('boom'))
    mocks.marketplaceList.mockRejectedValue(new Error('boom'))

    renderPage()
    expect(await screen.findByRole('alert')).toBeInTheDocument()

    // 后端恢复：重试时四个数据源全部成功
    mocks.list.mockResolvedValue({ installed: [
      {
        id: 'plugin-1',
        name: 'Alpha Plugin',
        description: 'Does alpha things',
        enabled: true,
        version: '1.0.0',
      },
    ]})
    mocks.available.mockResolvedValue({ available: [] })
    mocks.activeTools.mockResolvedValue([
      { name: 'alpha-tool', description: 'Alpha tool', pluginId: 'plugin-1' },
    ])
    mocks.marketplaceList.mockResolvedValue({ skills: [], mcpServers: [], registries: [] })

    await userEvent.click(screen.getByRole('button', { name: '重试' }))

    await waitFor(() => expect(screen.getByText('Alpha Plugin')).toBeInTheDocument())
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('shows the error only on the marketplace tab when only marketplace fails', async () => {
    mocks.marketplaceList.mockRejectedValue(new Error('market down'))

    renderPage()
    await waitFor(() => expect(screen.getByText('Alpha Plugin')).toBeInTheDocument())
    // 其他 tab 的数据源成功 ⇒ 不因广场失败而整体报错
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()

    await userEvent.click(screen.getByRole('tab', { name: /广场/i }))

    expect(await screen.findByRole('alert')).toHaveTextContent('加载失败')
    expect(screen.getByRole('button', { name: '重试' })).toBeInTheDocument()
    expect(screen.queryByText('暂无 Skill')).not.toBeInTheDocument()
  })

  it('keeps the original empty states when every source succeeds with empty data', async () => {
    mocks.list.mockResolvedValue({ installed: [] })
    mocks.available.mockResolvedValue({ available: [] })
    mocks.activeTools.mockResolvedValue([])
    mocks.marketplaceList.mockResolvedValue({ skills: [], mcpServers: [], registries: [] })

    renderPage()

    expect(await screen.findByText('暂无已安装插件')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('tab', { name: /可用插件/i }))
    expect(screen.getByText('暂无可用插件')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('tab', { name: /活跃工具/i }))
    expect(screen.getByText('暂无活跃工具')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('tab', { name: /广场/i }))
    expect(screen.getByText('暂无 Skill')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('shows a skeleton while the first load is pending and hides it afterwards', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    mocks.list.mockReturnValue(
      gate.then(() => ({ installed: [
        {
          id: 'plugin-1',
          name: 'Alpha Plugin',
          description: 'Does alpha things',
          enabled: true,
          version: '1.0.0',
        },
      ]}))
    )
    mocks.available.mockReturnValue(gate.then(() => ({ available: [] })))
    mocks.activeTools.mockReturnValue(gate.then(() => []))
    mocks.marketplaceList.mockReturnValue(
      gate.then(() => ({ skills: [], mcpServers: [], registries: [] }))
    )

    renderPage()

    expect(screen.getByTestId('plugins-skeleton')).toBeInTheDocument()

    release()

    await waitFor(() =>
      expect(screen.queryByTestId('plugins-skeleton')).not.toBeInTheDocument()
    )
    expect(screen.getByText('Alpha Plugin')).toBeInTheDocument()
  })

  it('maps a timeout load failure to a message containing 超时', async () => {
    mocks.list.mockRejectedValue(Object.assign(new Error('timeout'), { code: 'timeout' }))

    renderPage()

    expect(await screen.findByRole('alert')).toHaveTextContent('超时')
  })

  it('maps a canceled load failure to a message containing 已取消', async () => {
    mocks.list.mockRejectedValue(Object.assign(new Error('canceled'), { code: 'canceled' }))

    renderPage()

    expect(await screen.findByRole('alert')).toHaveTextContent('已取消')
  })
})
