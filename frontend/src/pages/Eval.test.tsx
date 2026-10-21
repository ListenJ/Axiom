import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import Eval from './Eval'

const mocks = vi.hoisted(() => ({
  stats: vi.fn(),
  results: vi.fn(),
  assignments: vi.fn(),
  models: vi.fn(),
  run: vi.fn(),
  assign: vi.fn(),
}))

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    endpoints: {
      ...actual.endpoints,
      eval: {
        stats: mocks.stats,
        results: mocks.results,
        assignments: mocks.assignments,
        models: mocks.models,
        run: mocks.run,
        assign: mocks.assign,
      },
    },
  }
})

describe('Eval page integration', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    // 真实契约（2026-10-22 修复）：stats 来自 getStats；results/assignments/models 用后端真实形状，
    // 不再用前端臆造的扁平形状（旧 fixture 曾把「页面恒空」的 bug 锁成假绿）。
    mocks.stats.mockResolvedValue({
      totalEvaluations: 3,
      modelsEvaluated: 2,
      lastEvalAt: new Date().toISOString(),
      topModels: [{ modelId: 'm1', overall: 85 }],
    })
    mocks.results.mockResolvedValue([
      {
        modelId: 'r1',
        provider: 'openai',
        evaluatedAt: new Date().toISOString(),
        scores: { capability: 88, speed: 92, cost: 80, safety: 90, overall: 90 },
        benchmarks: [],
        metadata: {},
      },
    ])
    mocks.assignments.mockResolvedValue([
      {
        modelId: 'a1',
        provider: 'openai',
        model: 'gpt-4',
        assignedRoles: ['coder'],
        evalScore: 85,
        priority: 1,
        reason: 'test fixture',
        evaluatedAt: new Date().toISOString(),
      },
    ])
    mocks.models.mockResolvedValue([
      {
        id: 'openai/gpt-4',
        name: 'gpt-4',
        pricing: { prompt: '0.00001', completion: '0.00003' },
        context_length: 128000,
      },
    ])
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  function renderPage() {
    return render(
      <MemoryRouter>
        <Routes>
          <Route path="/" element={<Eval />} />
        </Routes>
      </MemoryRouter>
    )
  }

  it('renders stats and results tab by default', async () => {
    renderPage()
    await waitFor(() => expect(screen.getByText('模型评估')).toBeInTheDocument())
    await waitFor(() =>
      expect(screen.getByText('已评估模型').nextElementSibling).toHaveTextContent(/2\s*\/\s*3/)
    )
    await waitFor(() => expect(screen.getByText('openai')).toBeInTheDocument())
    await waitFor(() => expect(screen.getByText('90.0%')).toBeInTheDocument())
  })

  it('runs quick eval and refreshes', async () => {
    mocks.run.mockResolvedValue(undefined)
    renderPage()
    await waitFor(() => expect(screen.getByText('openai')).toBeInTheDocument())
    await userEvent.click(screen.getByRole('button', { name: /快速评估/i }))
    await waitFor(() => expect(mocks.run).toHaveBeenCalledWith({ mode: 'quick' }))
  })

  it('switches to assignments tab and reassigns', async () => {
    mocks.assign.mockResolvedValue(undefined)
    renderPage()
    await waitFor(() => expect(screen.getByText('openai')).toBeInTheDocument())
    await userEvent.click(screen.getByRole('tab', { name: /动态分配/i }))
    await waitFor(() => expect(screen.getByText('coder')).toBeInTheDocument())
    await userEvent.click(screen.getByRole('button', { name: /重新分配/i }))
    await waitFor(() => expect(mocks.assign).toHaveBeenCalled())
  })

  it('filters out empty result objects from the backend', async () => {
    mocks.results.mockResolvedValue([
      {},
      {
        modelId: 'r2',
        provider: 'x',
        evaluatedAt: new Date().toISOString(),
        scores: { capability: 50, speed: 50, cost: 50, safety: 50, overall: 50 },
        benchmarks: [],
        metadata: {},
      },
      { modelId: '', provider: 'bad' },
      null,
    ])
    renderPage()
    await waitFor(() => expect(screen.queryByText('NaN')).not.toBeInTheDocument())
    expect(screen.getByText('x')).toBeInTheDocument()
  })

  it('后端契约字段变化时不再静默清空：真实形状可渲染', async () => {
    renderPage()
    await waitFor(() => expect(screen.getByText('openai')).toBeInTheDocument())
    // r1 的 scores.overall=90 → 展示 90.0%（0-100 刻度）
    await waitFor(() => expect(screen.getByText('90.0%')).toBeInTheDocument())
    expect(screen.getByText('r1')).toBeInTheDocument()
  })

  it('全部端点失败时显示可见错误（旧实现这里是死代码）', async () => {
    mocks.stats.mockRejectedValue(new Error('stats down'))
    mocks.results.mockRejectedValue(new Error('results down'))
    mocks.assignments.mockRejectedValue(new Error('assignments down'))
    mocks.models.mockRejectedValue(new Error('models down'))
    renderPage()
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('模型评估服务全部不可用')
    // 失败时不再永久骨架屏（loading 以 stats 为准，这里只断言错误可见与标题仍在）
    expect(screen.getByText('模型评估')).toBeInTheDocument()
  })
})
