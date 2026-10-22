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

/** 加载结束后不得残留任何骨架（永久骨架 = 假加载态）。 */
function expectNoSkeleton(container: HTMLElement) {
  expect(container.querySelectorAll('.skeleton')).toHaveLength(0)
  expect(container.querySelectorAll('.animate-pulse')).toHaveLength(0)
  expect(screen.queryAllByTestId('vault-skeleton')).toHaveLength(0)
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

  it('shows a persistent error with retry and no permanent skeleton when stats and tags both fail', async () => {
    mocks.vaultStats.mockRejectedValue(new Error('stats backend down'))
    mocks.vaultTags.mockRejectedValue(new Error('tags backend down'))

    const { container } = renderPage()

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(/不可用|失败/)
    expect(screen.getByRole('button', { name: '重试' })).toBeInTheDocument()
    // 失败不应伪装成空态
    expect(screen.queryByText('暂无标签')).not.toBeInTheDocument()
    // 加载已结束：不得残留永久骨架
    await waitFor(() => expectNoSkeleton(container))
  })

  it('retries after a failure and renders the recovered data', async () => {
    mocks.vaultStats
      .mockRejectedValueOnce(new Error('stats backend down'))
      .mockResolvedValueOnce({ notes: 12, tags: 5, links: 3 })
    mocks.vaultTags
      .mockRejectedValueOnce(new Error('tags backend down'))
      .mockResolvedValueOnce(['ts', 'architecture'])

    renderPage()

    expect(await screen.findByRole('alert')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: '重试' }))

    expect(await screen.findByText('12')).toBeInTheDocument()
    expect(screen.getByText('#ts')).toBeInTheDocument()
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument())
  })

  it('shows the tag empty state only when tags load successfully empty', async () => {
    mocks.vaultStats.mockResolvedValue({ notes: 0, tags: 0, links: 0 })
    mocks.vaultTags.mockResolvedValue([])

    renderPage()

    expect(await screen.findByText('暂无标签')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('renders the PARA card without any permanent skeleton', async () => {
    mocks.vaultStats.mockResolvedValue({ notes: 12, tags: 5, links: 3 })
    mocks.vaultTags.mockResolvedValue(['ts'])

    const { container } = renderPage()

    expect(await screen.findByText('12')).toBeInTheDocument()
    expect(screen.getByText(/在原生 Axiom 应用中查看 PARA 分类与反向链接/)).toBeInTheDocument()
    expectNoSkeleton(container)
  })

  it('shows a review error alert instead of the empty state, then recovers on retry', async () => {
    mocks.pendingReview.mockRejectedValueOnce(new Error('queue backend down'))

    renderPage()
    await userEvent.click(await screen.findByRole('tab', { name: /待审核/ }))

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(/失败/)
    expect(screen.queryByText('暂无待审核笔记')).not.toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: '重试' }))

    expect(await screen.findByText('暂无待审核笔记')).toBeInTheDocument()
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument())
  })

  it('maps a timeout failure to a distinguishable error message', async () => {
    mocks.vaultStats.mockRejectedValue(Object.assign(new Error('timeout'), { code: 'timeout' }))
    mocks.vaultTags.mockResolvedValue([])

    renderPage()

    expect(await screen.findByRole('alert')).toHaveTextContent('超时')
  })

  it('maps a canceled failure to a distinguishable error message', async () => {
    mocks.vaultTags.mockRejectedValue(Object.assign(new Error('canceled'), { code: 'canceled' }))
    mocks.vaultStats.mockResolvedValue({ notes: 0, tags: 0, links: 0 })

    renderPage()

    expect(await screen.findByRole('alert')).toHaveTextContent('已取消')
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
