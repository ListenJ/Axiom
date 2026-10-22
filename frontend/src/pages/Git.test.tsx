// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import Git from './Git'

const mocks = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }))

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return { ...actual, api: { ...actual.api, get: mocks.get, post: mocks.post } }
})

const STATUS_OK = {
  success: true,
  branch: 'main',
  clean: false,
  ahead: 1,
  modified: ['src/a.ts'],
  added: [],
  deleted: [],
  untracked: [],
}

const LOG_OK = {
  success: true,
  commits: [{ hash: 'x'.repeat(40), shortHash: 'abc1234', message: 'feat: sample commit', author: 'me', date: '2026-08-15' }],
}

/** 按 URL 返回成功数据的默认桩（与页面真实请求路径一致） */
function mockSuccess() {
  mocks.get.mockImplementation(async (url: string) => {
    if (url === '/api/git/status') return STATUS_OK
    if (url === '/api/git/log?maxCount=10') return LOG_OK
    return { success: true }
  })
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

function renderPage() {
  return render(
    <MemoryRouter>
      <Git />
    </MemoryRouter>,
  )
}

describe('Git page — usage scenarios', () => {
  beforeEach(() => {
    stubMatchMedia()
    vi.resetAllMocks()
    mockSuccess()
    mocks.post.mockResolvedValue({ success: true, shortHash: 'def5678' })
  })

  it('renders branch status, working-tree changes and recent commits', async () => {
    renderPage()
    expect(await screen.findByText('main')).toBeInTheDocument()
    expect(screen.getByText('src/a.ts')).toBeInTheDocument()
    expect(screen.getByText('feat: sample commit')).toBeInTheDocument()
    expect(screen.getByText('abc1234')).toBeInTheDocument()
    // 请求结束后不得残留骨架
    expect(screen.queryAllByTestId('git-skeleton')).toHaveLength(0)
  })

  it('commits with the entered message and refreshes', async () => {
    renderPage()
    await userEvent.type(await screen.findByPlaceholderText('输入提交信息…'), 'fix: something')
    await userEvent.click(screen.getByRole('button', { name: '提交' }))
    await waitFor(() => expect(mocks.post).toHaveBeenCalledWith('/api/git/commit', { message: 'fix: something' }))
  })

  it('shows a persistent alert with retry — not a clean empty state — when reading git state fails', async () => {
    mocks.get.mockRejectedValue(new Error('git down'))
    renderPage()

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(/读取|不可用/)
    expect(alert).toHaveTextContent('git down')
    // 失败不得伪装成正常态
    expect(screen.queryByText('工作区干净')).not.toBeInTheDocument()
    expect(screen.queryByText('无变更')).not.toBeInTheDocument()
    expect(screen.queryByText('暂无提交记录')).not.toBeInTheDocument()
    // 持久错误块 + 重试入口，且不残留骨架
    expect(screen.getByRole('button', { name: /重试/ })).toBeInTheDocument()
    expect(screen.queryAllByTestId('git-skeleton')).toHaveLength(0)
  })

  it('retries the read and clears the alert when the retry succeeds', async () => {
    let failing = true
    mocks.get.mockImplementation(async (url: string) => {
      if (failing) throw new Error('git down')
      if (url === '/api/git/status') return STATUS_OK
      if (url === '/api/git/log?maxCount=10') return LOG_OK
      return { success: true }
    })
    const user = userEvent.setup()
    renderPage()

    expect(await screen.findByRole('alert')).toBeInTheDocument()
    failing = false
    await user.click(screen.getByRole('button', { name: /重试/ }))

    expect(await screen.findByText('main')).toBeInTheDocument()
    expect(screen.getByText('src/a.ts')).toBeInTheDocument()
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument())
  })

  it('renders empty states only when the workspace is genuinely clean and there are no commits', async () => {
    mocks.get.mockImplementation(async (url: string) => {
      if (url === '/api/git/status') {
        return { success: true, branch: 'main', clean: true, ahead: 0, behind: 0, modified: [], added: [], deleted: [], untracked: [] }
      }
      if (url === '/api/git/log?maxCount=10') return { success: true, commits: [] }
      return { success: true }
    })
    renderPage()

    expect(await screen.findByText('无变更')).toBeInTheDocument()
    expect(screen.getByText('暂无提交记录')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('maps timeout errors to a timeout message instead of an empty state', async () => {
    mocks.get.mockRejectedValue(Object.assign(new Error('timeout'), { code: 'timeout' }))
    renderPage()

    expect(await screen.findByRole('alert')).toHaveTextContent('超时')
    expect(screen.queryByText('无变更')).not.toBeInTheDocument()
  })

  it('maps cancellation errors to a canceled message', async () => {
    mocks.get.mockRejectedValue(Object.assign(new Error('canceled'), { code: 'canceled' }))
    renderPage()

    expect(await screen.findByRole('alert')).toHaveTextContent('已取消')
  })

  it('shows skeletons while the first read is pending', async () => {
    mocks.get.mockImplementation(() => new Promise(() => {}))
    renderPage()

    expect((await screen.findAllByTestId('git-skeleton')).length).toBeGreaterThan(0)
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.queryByText('无变更')).not.toBeInTheDocument()
  })
})
