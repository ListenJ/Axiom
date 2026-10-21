// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, waitFor, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { TokensPanel } from './Tokens'

// Mock @/lib/api（endpoints/api），不再 mock 全局 fetch：组件走 api 封装
// （带鉴权拦截器/超时/错误映射），测试替换 endpoints.tokenDetails 即可。
const mocks = vi.hoisted(() => ({
  tokenDetails: vi.fn(),
}))

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    endpoints: {
      ...actual.endpoints,
      tokenDetails: mocks.tokenDetails,
    },
  }
})

const tokenDetails = {
  perModel: [
    { model: 'glm-4-flash', calls: 10, promptTokens: 5000, completionTokens: 2000, avgLatency: 300 },
  ],
  hourlyTrend: [{ date: '2026-08-14', totalCalls: 10, totalTokens: 7000 }],
  overall: { totalTokens: 7000, totalCalls: 10, promptTokens: 5000, completionTokens: 2000, avgLatency: 300 },
  recentCalls: [],
  cacheStats: { totalCalls: 10, cacheHits: 4, hitRate: 40 },
}

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

describe('Tokens page — usage scenarios', () => {
  beforeEach(() => {
    stubMatchMedia()
    vi.resetAllMocks()
    mocks.tokenDetails.mockResolvedValue(tokenDetails)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('renders overall token/call stats and per-model chart via endpoints.tokenDetails', async () => {
    render(
      <MemoryRouter>
        <TokensPanel />
      </MemoryRouter>,
    )

    expect(await screen.findByText('7,000')).toBeInTheDocument()
    expect(screen.getByText('40%')).toBeInTheDocument()
    expect(screen.getAllByText('300ms').length).toBeGreaterThan(0)
    expect(screen.getAllByText('10').length).toBeGreaterThan(0)
    expect(await screen.findByText('glm-4-flash')).toBeInTheDocument()
    // 走 endpoints.tokenDetails（带鉴权/超时/错误映射），不再裸 fetch
    expect(mocks.tokenDetails).toHaveBeenCalledWith(7)
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('shows an empty trend state when there is no per-model data', async () => {
    mocks.tokenDetails.mockResolvedValue({
      ...tokenDetails,
      perModel: [],
      overall: { ...tokenDetails.overall, totalTokens: 0 },
    })
    render(
      <MemoryRouter>
        <TokensPanel />
      </MemoryRouter>,
    )
    expect(await screen.findByText('暂无 Token 消耗数据')).toBeInTheDocument()
  })

  it('keeps previous data and shows an alert when a later fetch fails', async () => {
    // 首次成功 → 旧数据；随后一次请求失败 → 保留旧数据 + role=alert
    mocks.tokenDetails.mockResolvedValueOnce(tokenDetails)
    mocks.tokenDetails.mockRejectedValueOnce(new Error('401 Unauthorized'))

    vi.useFakeTimers()
    render(
      <MemoryRouter>
        <TokensPanel />
      </MemoryRouter>,
    )

    // 首次成功渲染（flush 挂载时的 fetch 微任务）
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(screen.getByText('7,000')).toBeInTheDocument()

    // 推进 10s 轮询 → 第二次请求失败
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000)
    })
    const alert = screen.getByRole('alert')
    expect(alert).toHaveTextContent('401 Unauthorized')
    // 旧数据保留（未被清空）
    expect(screen.getByText('7,000')).toBeInTheDocument()
    expect(mocks.tokenDetails).toHaveBeenCalledTimes(2)
  })

  it('does not crash on a malformed payload and surfaces a format error', async () => {
    // 后端返回错误 JSON（缺 overall/cacheStats）→ 不当作数据渲染，不崩溃
    mocks.tokenDetails.mockResolvedValueOnce({ error: 'unauthorized' } as unknown)

    render(
      <MemoryRouter>
        <TokensPanel />
      </MemoryRouter>,
    )

    expect(await screen.findByRole('alert')).toHaveTextContent('格式异常')
    // 无数据时渲染空态而非崩溃
    expect(screen.getByText('暂无 Token 消耗数据')).toBeInTheDocument()
    expect(mocks.tokenDetails).toHaveBeenCalledWith(7)
  })

  it('retries by re-requesting when 重试 is clicked', async () => {
    // 首次失败 → 重试按钮可见；点击 → 第二次请求成功 → 清错
    mocks.tokenDetails.mockRejectedValueOnce(new Error('读取失败'))
    mocks.tokenDetails.mockResolvedValueOnce(tokenDetails)
    const user = userEvent.setup()

    render(
      <MemoryRouter>
        <TokensPanel />
      </MemoryRouter>,
    )

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('读取失败')

    await user.click(screen.getByRole('button', { name: '重试' }))

    await waitFor(() => expect(mocks.tokenDetails).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument())
    expect(await screen.findByText('7,000')).toBeInTheDocument()
  })
})
