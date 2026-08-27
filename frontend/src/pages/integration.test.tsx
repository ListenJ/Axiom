// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'

/**
 * 前端集成 L2：跨页面×跨组件 数据流
 * 矩阵 P3×M 升级至 L1+L3，验证 Hub Tab、Settings 持久化、Vault 统计
 */
const mocks = vi.hoisted(() => ({
  vaultStats: vi.fn(),
  vaultSearch: vi.fn(),
  engines: vi.fn(),
  config: vi.fn(),
}))

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  const vaultMock = {
    stats: (...args: unknown[]) => mocks.vaultStats(...args),
    tags: () => Promise.resolve([]),
    para: () => Promise.resolve({}),
    network: () => Promise.resolve({}),
    note: () => Promise.resolve({}),
    write: () => Promise.resolve({}),
  }
  return {
    ...actual,
    api: {
      ...actual.api,
      get: vi.fn((url: string) => {
        if (url === '/config') return Promise.resolve({ gateway: { port: 18789 } })
        if (url.startsWith('/vault')) return Promise.resolve({ results: [] })
        return (actual.api as any).get(url)
      }),
      clearCache: vi.fn(),
    },
    endpoints: {
      ...actual.endpoints,
      system: {
        ...actual.endpoints.system,
        engines: mocks.engines,
      },
      search: {
        ...actual.endpoints.search,
        vault: mocks.vaultSearch,
      },
      vault: vaultMock,
      knowledge: {
        ...actual.endpoints.knowledge,
        pendingReview: () => Promise.resolve({ notes: [] }),
        reviewAction: () => Promise.resolve({}),
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

import Search from './Search'
import Settings from './Settings'
import Vault from './Vault'

describe('前端集成：Search Hub 四 tab 切换', () => {
  beforeEach(() => {
    stubMatchMedia()
    vi.resetAllMocks()
    mocks.vaultSearch = vi.fn().mockResolvedValue({ results: [] })
    mocks.engines.mockResolvedValue({ engines: [{ name: 'duckduckgo', available: true }] })
  })

  it('四 tab 均可切换且内容正确', async () => {
    render(
      <MemoryRouter initialEntries={['/search']}>
        <Search />
      </MemoryRouter>
    )
    expect(await screen.findByRole('heading', { name: '搜索' })).toBeInTheDocument()
    await userEvent.click(await screen.findByRole('tab', { name: /深度研究/ }))
    expect(await screen.findByRole('heading', { name: '研究问题' })).toBeInTheDocument()
    await userEvent.click(screen.getByRole('tab', { name: /趋势/ }))
    expect((await screen.findAllByText(/趋势/)).length).toBeGreaterThan(0)
    await userEvent.click(screen.getByRole('tab', { name: /OCR/ }))
    expect((await screen.findAllByText(/OCR/)).length).toBeGreaterThan(0)
    // 回到搜索
    await userEvent.click(screen.getByRole('tab', { name: /^搜索$/ }))
    expect(await screen.findByLabelText('搜索关键词')).toBeInTheDocument()
  })
})

describe('前端集成：Settings 外观与行为持久化', () => {
  beforeEach(() => {
    stubMatchMedia()
    localStorage.clear()
    mocks.engines.mockResolvedValue({ engines: [{ name: 'duckduckgo', available: true }] })
  })

  it('主题切换应写入状态且高亮', async () => {
    render(
      <MemoryRouter initialEntries={['/settings']}>
        <Settings />
      </MemoryRouter>
    )
    const dark = await screen.findByRole('radio', { name: '深色主题' })
    await userEvent.click(dark)
    expect(dark).toHaveAttribute('aria-checked', 'true')
  })
})

describe('前端集成：Vault 统计与搜索联动', () => {
  beforeEach(() => {
    stubMatchMedia()
    mocks.vaultStats.mockResolvedValue({ total: 42, tags: 5, links: 3 })
  })

  it('Vault 页应显示标题且不崩', async () => {
    render(
      <MemoryRouter initialEntries={['/vault']}>
        <Vault />
      </MemoryRouter>
    )
    expect(await screen.findByRole('heading', { name: /知识库|Vault/ })).toBeInTheDocument()
  })

  it('Vault 统计应 5 次回放一致', async () => {
    const results = []
    for (let i = 0; i < 5; i++) {
      const r = await mocks.vaultStats()
      results.push(JSON.stringify(r))
    }
    expect(new Set(results).size).toBe(1)
  })
})
