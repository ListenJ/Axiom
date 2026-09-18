// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { TokensPanel } from './Tokens'

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
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(tokenDetails), { status: 200 })))
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('renders overall token/call stats and per-model chart from /api/token-details', async () => {
    render(
      <MemoryRouter>
        <TokensPanel />
      </MemoryRouter>,
    )

    expect(await screen.findByText('7,000')).toBeInTheDocument()
    expect(screen.getByText('10')).toBeInTheDocument()
    expect(screen.getByText('40%')).toBeInTheDocument()
    expect(screen.getByText('300ms')).toBeInTheDocument()
    // per-model 图表条目
    expect(await screen.findByText('glm-4-flash')).toBeInTheDocument()
  })

  it('shows an empty trend state when there is no per-model data', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({ ...tokenDetails, perModel: [], overall: { ...tokenDetails.overall, totalTokens: 0 } }), { status: 200 }),
      ),
    )
    render(
      <MemoryRouter>
        <TokensPanel />
      </MemoryRouter>,
    )
    expect(await screen.findByText('暂无 Token 消耗数据')).toBeInTheDocument()
  })
})
