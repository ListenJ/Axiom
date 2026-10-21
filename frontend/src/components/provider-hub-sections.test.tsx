import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { RouterSection, TokensSection } from './provider-hub-sections'

/**
 * C1/C2（2026-10-22 审计）：
 *   - C1 TokensSection 曾用裸 `fetch('/api/token-details')`：该路径不在后端 PUBLIC_PATHS
 *     （src/utils/auth-check.ts 的 PUBLIC_PATHS）⇒ 无 Authorization 恒 401；错误 JSON 被
 *     `setData` 当数据渲染 ⇒ `data.overall.totalTokens` 抛 TypeError（渲染崩溃）；空 catch 让失败不可见。
 *   - C2 RouterSection 三个请求各自 `.catch(()=>null)` ⇒ allSettled 永不全 rejected，`anyError`
 *     是死代码；三接口全挂时 status 回落 'ok' 显示**绿色健康**。
 * 本文件锁定修复后的可观测行为。
 */
vi.mock('@/lib/api', () => ({
  api: { get: vi.fn() },
  endpoints: {
    search: { vault: vi.fn(), code: vi.fn(), web: vi.fn() },
    router: { status: vi.fn(), health: vi.fn(), tokenStats: vi.fn() },
  },
}))

import { api, endpoints } from '@/lib/api'

const validPayload = {
  perModel: [{ model: 'deepseek-v4', calls: 3, promptTokens: 120, completionTokens: 40, avgLatency: 880 }],
  hourlyTrend: [],
  overall: { totalTokens: 160, totalCalls: 3, promptTokens: 120, completionTokens: 40, avgLatency: 880 },
  recentCalls: [
    { timestamp: Date.now(), model: 'deepseek-v4', promptTokens: 40, completionTokens: 10, latencyMs: 900, success: true },
  ],
  cacheStats: { totalCalls: 3, cacheHits: 1, hitRate: 33 },
}

const mockGet = vi.mocked(api.get)

describe('TokensSection（C1：鉴权/形状/错误可见）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('读取失败时显示错误与重试入口，不崩溃', async () => {
    mockGet.mockRejectedValueOnce(new Error('401 Unauthorized'))
    const user = userEvent.setup()
    render(<TokensSection />)

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(/401|读取 Token 数据失败/)
    // 页面标题仍渲染（未触发错误边界/崩溃）
    expect(screen.getByRole('heading', { name: 'Token 消耗分析' })).toBeInTheDocument()

    mockGet.mockResolvedValueOnce(validPayload)
    await user.click(screen.getByRole('button', { name: '重试' }))
    await waitFor(() => expect(mockGet).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument())
  })

  it('后端返回错误 JSON（形状不对）时不当作数据渲染，显示格式异常', async () => {
    mockGet.mockResolvedValueOnce({ error: 'unauthorized' } as unknown as typeof validPayload)
    render(<TokensSection />)

    expect(await screen.findByRole('alert')).toHaveTextContent('Token 数据格式异常')
    expect(screen.getByRole('heading', { name: 'Token 消耗分析' })).toBeInTheDocument()
  })

  it('正常数据渲染总 Token 与命中率', async () => {
    mockGet.mockResolvedValueOnce(validPayload)
    render(<TokensSection />)

    expect(await screen.findByText('160')).toBeInTheDocument()
    expect(screen.getByText('33%')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    // 走 api 封装（带鉴权/超时/错误映射），不再裸 fetch
    expect(mockGet).toHaveBeenCalledWith('/api/token-details?days=7', { cache: false })
  })
})

describe('RouterSection（C2：死分支修复）', () => {
  const mockStatus = vi.mocked(endpoints.router.status)
  const mockHealth = vi.mocked(endpoints.router.health)
  const mockTokenStats = vi.mocked(endpoints.router.tokenStats)

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('三接口全挂时显示「全部不可用」而不是绿色 ok', async () => {
    mockStatus.mockRejectedValue(new Error('status down'))
    mockHealth.mockRejectedValue(new Error('health down'))
    mockTokenStats.mockRejectedValue(new Error('token down'))
    render(<RouterSection />)

    expect(await screen.findByRole('alert')).toHaveTextContent('模型路由服务全部不可用')
    // 状态不再是 'ok'（'unknown' 用弱化色展示）
    expect(screen.getByText('unknown')).toBeInTheDocument()
    expect(screen.queryByText('ok')).not.toBeInTheDocument()
  })

  it('部分接口失败时提示部分指标不可用，但仍显示可用指标', async () => {
    mockStatus.mockResolvedValue({ status: 'ok', models: 7 })
    mockHealth.mockResolvedValue({ healthy: 5 })
    mockTokenStats.mockRejectedValue(new Error('token endpoint down'))
    render(<RouterSection />)

    expect(await screen.findByRole('alert')).toHaveTextContent('部分指标暂不可用')
    expect(screen.getByText(/共 7 个模型/)).toBeInTheDocument()
    expect(screen.getByText('5')).toBeInTheDocument()
  })

  it('全部成功时无错误提示', async () => {
    mockStatus.mockResolvedValue({ status: 'ok', models: 7 })
    mockHealth.mockResolvedValue({ healthy: 5 })
    mockTokenStats.mockResolvedValue({ tokens: { used: 100, total: 200 } })
    render(<RouterSection />)

    await waitFor(() => expect(screen.getByText('ok')).toBeInTheDocument())
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.getByText('100')).toBeInTheDocument()
  })
})
