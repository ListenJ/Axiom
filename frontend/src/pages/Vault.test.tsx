// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import Vault from './Vault'

const mocks = vi.hoisted(() => ({
  vaultStats: vi.fn(),
  vaultTags: vi.fn(),
  pendingReview: vi.fn(),
  reviewAction: vi.fn(),
}))

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    endpoints: {
      ...actual.endpoints,
      vault: {
        ...actual.endpoints.vault,
        stats: mocks.vaultStats,
        tags: mocks.vaultTags,
      },
      knowledge: {
        ...actual.endpoints.knowledge,
        pendingReview: mocks.pendingReview,
        reviewAction: mocks.reviewAction,
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

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/vault']}>
      <Vault />
    </MemoryRouter>,
  )
}

describe('Vault page — usage scenarios', () => {
  beforeEach(() => {
    stubMatchMedia()
    vi.resetAllMocks()
    mocks.vaultStats.mockResolvedValue({ notes: 0, tags: 0, links: 0 })
    mocks.vaultTags.mockResolvedValue([])
    mocks.pendingReview.mockResolvedValue({ notes: [] })
    mocks.reviewAction.mockResolvedValue({ ok: true })
  })

  it('shows vault stats and tags from the API', async () => {
    mocks.vaultStats.mockResolvedValue({ notes: 12, tags: 5, links: 3 })
    mocks.vaultTags.mockResolvedValue(['ts', 'architecture'])

    renderPage()

    expect(await screen.findByText('12')).toBeInTheDocument()
    expect(screen.getByText('5')).toBeInTheDocument()
    expect(screen.getByText('3')).toBeInTheDocument()
    expect(screen.getByText('#ts')).toBeInTheDocument()
    expect(screen.getByText('#architecture')).toBeInTheDocument()
  })

  it('approves a pending note in the review tab', async () => {
    mocks.pendingReview.mockResolvedValue({
      notes: [
        {
          file: '00-Knowledge/test.md',
          title: '待审核笔记A',
          source: 'web',
          created: '2026-08-01',
          reason: '新知识点',
        },
      ],
    })

    renderPage()

    await userEvent.click(await screen.findByRole('tab', { name: /待审核/ }))
    expect(await screen.findByText('待审核笔记A')).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: '批准' }))
    await waitFor(() =>
      expect(mocks.reviewAction).toHaveBeenCalledWith({ file: '00-Knowledge/test.md', action: 'approve' }),
    )
    await waitFor(() => expect(screen.queryByText('待审核笔记A')).not.toBeInTheDocument())
  })

  it('shows an empty state when the review queue is empty', async () => {
    renderPage()
    await userEvent.click(await screen.findByRole('tab', { name: /待审核/ }))
    expect(await screen.findByText(/暂无/)).toBeInTheDocument()
  })
})
