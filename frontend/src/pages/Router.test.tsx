// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, waitFor, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
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

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/** 三个接口全部失败时的错误。 */
function rejectAll(message = '服务不可用') {
  mocks.routerStatus.mockRejectedValue(new Error(`${message}（status）`))
  mocks.routerHealth.mockRejectedValue(new Error(`${message}（health）`))
  mocks.routerTokenStats.mockRejectedValue(new Error(`${message}（tokenStats）`))
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
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
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

  it('shows a full error state with 重试 and no fake green 未知 when every endpoint fails', async () => {
    rejectAll()
    const { container } = render(
      <MemoryRouter>
        <Router />
      </MemoryRouter>,
    )

    const alert = await screen.findByRole('alert')
    // 完整错误态：明确「暂不可用」+ 具体原因 + 重试入口
    expect(alert).toHaveTextContent('模型路由服务暂不可用')
    expect(alert).toHaveTextContent('服务不可用（status）')
    expect(screen.getByRole('button', { name: '重试' })).toBeInTheDocument()

    // 不得把失败伪装成成功：没有「未知」伪状态，也没有 success 绿色语义
    expect(screen.queryByText('未知')).not.toBeInTheDocument()
    expect(container.querySelector('[class*="text-[var(--success)]"]')).toBeNull()
    // 卡片降级为中性占位符，而不是绿色成功值
    expect(screen.getAllByText('—').length).toBeGreaterThan(0)
  })

  it('retries a full failure and renders data after recovery', async () => {
    rejectAll()
    const user = userEvent.setup()
    render(
      <MemoryRouter>
        <Router />
      </MemoryRouter>,
    )

    expect(await screen.findByRole('alert')).toHaveTextContent('模型路由服务暂不可用')

    // 让下一次请求成功，点「重试」→ 数据出现、错误块消失
    mocks.routerStatus.mockResolvedValue({ status: 'healthy', models: 12 })
    mocks.routerHealth.mockResolvedValue({ healthy: 10, models: 12 })
    mocks.routerTokenStats.mockResolvedValue({ tokens: { used: 12345, total: 100000 } })

    await user.click(screen.getByRole('button', { name: '重试' }))

    expect(await screen.findByText('healthy')).toBeInTheDocument()
    expect(screen.getByText('10')).toBeInTheDocument()
    expect(screen.getByText('共 12 个模型')).toBeInTheDocument()
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument())
  })

  it('keeps successful data and warns with 部分指标不可用 when only one endpoint fails', async () => {
    mocks.routerHealth.mockRejectedValue(new Error('advisor down'))
    render(
      <MemoryRouter>
        <Router />
      </MemoryRouter>,
    )

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('部分指标不可用')
    expect(alert).toHaveTextContent('advisor down')
    expect(screen.getByRole('button', { name: '重试' })).toBeInTheDocument()
    // 成功的数据照常渲染
    expect(screen.getByText('healthy')).toBeInTheDocument()
    expect(screen.getByText('12,345')).toBeInTheDocument()
  })

  it('shows skeletons only while the first load is pending, then removes them', async () => {
    const status = deferred<unknown>()
    const health = deferred<unknown>()
    const tokens = deferred<unknown>()
    mocks.routerStatus.mockReturnValue(status.promise)
    mocks.routerHealth.mockReturnValue(health.promise)
    mocks.routerTokenStats.mockReturnValue(tokens.promise)

    render(
      <MemoryRouter>
        <Router />
      </MemoryRouter>,
    )

    expect(screen.getAllByTestId('router-skeleton').length).toBeGreaterThan(0)
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()

    await act(async () => {
      status.resolve({ status: 'healthy', models: 12 })
      health.resolve({ healthy: 10, models: 12 })
      tokens.resolve({ tokens: { used: 12345, total: 100000 } })
      await Promise.all([status.promise, health.promise, tokens.promise])
    })

    await waitFor(() => expect(screen.queryAllByTestId('router-skeleton')).toHaveLength(0))
    expect(screen.getByText('healthy')).toBeInTheDocument()
  })

  it('labels timeout and canceled failures distinctly', async () => {
    mocks.routerStatus.mockRejectedValue(Object.assign(new Error('aborted'), { code: 'timeout' }))
    mocks.routerHealth.mockRejectedValue(Object.assign(new Error('aborted'), { code: 'canceled' }))
    mocks.routerTokenStats.mockRejectedValue(new Error('boom'))
    render(
      <MemoryRouter>
        <Router />
      </MemoryRouter>,
    )

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('暂不可用')
    expect(alert).toHaveTextContent('超时')
    expect(alert).toHaveTextContent('已取消')
    expect(alert).toHaveTextContent('boom')
  })
})
