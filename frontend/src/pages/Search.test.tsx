// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import Search from './Search'

const mocks = vi.hoisted(() => ({
  searchVault: vi.fn(),
  searchCode: vi.fn(),
  searchWeb: vi.fn(),
  researchRun: vi.fn(),
  trendsSummary: vi.fn(),
  ocrStatus: vi.fn(),
  ocrScan: vi.fn(),
}))

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    endpoints: {
      ...actual.endpoints,
      search: {
        ...actual.endpoints.search,
        vault: mocks.searchVault,
        code: mocks.searchCode,
        web: mocks.searchWeb,
      },
      research: { ...actual.endpoints.research, run: mocks.researchRun },
      trends: { ...actual.endpoints.trends, summary: mocks.trendsSummary },
      ocr: { ...actual.endpoints.ocr, status: mocks.ocrStatus, scan: mocks.ocrScan },
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

function renderPage(entry = '/search') {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <Search />
    </MemoryRouter>,
  )
}

describe('Search page — usage scenarios', () => {
  beforeEach(() => {
    stubMatchMedia()
    vi.resetAllMocks()
    mocks.searchVault.mockResolvedValue({ results: [] })
    mocks.searchCode.mockResolvedValue({ symbols: [] })
    mocks.searchWeb.mockResolvedValue({ results: [] })
    mocks.researchRun.mockResolvedValue({ summary: '研究摘要', sources: [] })
    mocks.trendsSummary.mockResolvedValue({ searchTrend: [], chatTrend: [] })
    mocks.ocrStatus.mockResolvedValue({ status: 'ready', supportedLanguages: ['eng'] })
    mocks.ocrScan.mockResolvedValue('OCR 文本')
  })

  it('searches vault + code + web and shows combined results', async () => {
    mocks.searchVault.mockResolvedValue({ results: [{ title: '模型路由笔记', type: 'note', snippet: '片段' }] })
    mocks.searchCode.mockResolvedValue({ symbols: [{ name: 'router.ts', type: 'file', path: 'src/router' }] })

    renderPage()
    await userEvent.type(await screen.findByLabelText('搜索关键词'), 'router')

    expect(await screen.findByText('模型路由笔记')).toBeInTheDocument()
    expect(screen.getByText('router.ts')).toBeInTheDocument()
    await waitFor(() => expect(mocks.searchVault).toHaveBeenCalledWith('router'))
    await waitFor(() => expect(mocks.searchCode).toHaveBeenCalledWith('router'))
  })

  it('switches to the deep-research tab', async () => {
    renderPage()
    await userEvent.click(await screen.findByRole('tab', { name: /深度研究/ }))
    expect(await screen.findByRole('heading', { name: '研究问题' })).toBeInTheDocument()
  })

  it('shows a no-results message after a query with no matches', async () => {
    renderPage()
    await userEvent.type(await screen.findByLabelText('搜索关键词'), 'zzz-no-match')
    expect(await screen.findByText('没有匹配结果')).toBeInTheDocument()
  })
})
