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
    mocks.stats.mockResolvedValue({
      // model-eval-service getStats 真实返回形状
      totalEvaluations: 3,
      modelsEvaluated: 2,
      lastEvalAt: new Date().toISOString(),
      topModels: [{ modelId: 'm1', overall: 85 }],
    })
    mocks.results.mockResolvedValue([
      {
        id: 'r1',
        provider: 'openai',
        overall: 0.9,
        quality: 0.88,
        speed: 0.92,
        cost: 0.8,
        lastEvaluated: new Date().toISOString(),
      },
    ])
    mocks.assignments.mockResolvedValue([
      {
        id: 'a1',
        role: 'coder',
        model: 'gpt-4',
        provider: 'openai',
        score: 0.85,
        lastAssigned: new Date().toISOString(),
      },
    ])
    mocks.models.mockResolvedValue([
      {
        id: 'm1',
        name: 'gpt-4',
        provider: 'openai',
        contextLength: 128000,
        pricing: { prompt: 0.01, completion: 0.03 },
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
    mocks.results.mockResolvedValue([{}, { id: 'r2', provider: 'x', overall: 0.5, quality: 0.5, speed: 0.5, cost: 0.5, lastEvaluated: new Date().toISOString() }])
    renderPage()
    await waitFor(() => expect(screen.queryByText('NaN')).not.toBeInTheDocument())
    expect(screen.getByText('x')).toBeInTheDocument()
  })
})
