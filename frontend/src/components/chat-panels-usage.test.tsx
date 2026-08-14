// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { UsageStatsPanel } from './chat-panels'

const mocks = vi.hoisted(() => ({ tokenDetails: vi.fn() }))

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

describe('UsageStatsPanel cost display', () => {
  it('渲染 DeepSeek 峰谷成本（总成本 + 每模型成本）', async () => {
    mocks.tokenDetails.mockResolvedValue({
      perModel: [
        {
          model: 'deepseek-v4-flash',
          provider: 'deepseek',
          calls: 2,
          promptTokens: 1000000,
          completionTokens: 1000000,
          totalTokens: 2000000,
          avgLatency: 120,
          costUsd: 1.76,
        },
      ],
      overall: { totalTokens: 2000000, costUsd: 1.76 },
    })
    render(<UsageStatsPanel />)
    expect(await screen.findByText('总消耗')).toBeInTheDocument()
    await waitFor(() => {
      expect(screen.getByText('$1.760')).toBeInTheDocument()
      expect(screen.getByText('deepseek')).toBeInTheDocument()
      expect(screen.getByText(/deepseek-v4-flash/)).toBeInTheDocument()
      expect(screen.getByText(/成本 \$1\.760/)).toBeInTheDocument()
      expect(screen.getByText(/含 DeepSeek 峰谷计价/)).toBeInTheDocument()
    })
  })
})