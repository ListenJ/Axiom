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

describe('Git page — usage scenarios', () => {
  beforeEach(() => {
    stubMatchMedia()
    vi.resetAllMocks()
    mocks.get.mockImplementation(async (url: string) => {
      if (url === '/api/git/status') {
        return { success: true, branch: 'main', clean: false, ahead: 1, modified: ['src/a.ts'], added: [], deleted: [], untracked: [] }
      }
      if (url === '/api/git/log?maxCount=10') {
        return { success: true, commits: [{ hash: 'x'.repeat(40), shortHash: 'abc1234', message: 'feat: sample commit', author: 'me', date: '2026-08-15' }] }
      }
      return { success: true }
    })
    mocks.post.mockResolvedValue({ success: true, shortHash: 'def5678' })
  })

  it('renders branch status, working-tree changes and recent commits', async () => {
    render(<MemoryRouter><Git /></MemoryRouter>)
    expect(await screen.findByText('main')).toBeInTheDocument()
    expect(screen.getByText('src/a.ts')).toBeInTheDocument()
    expect(screen.getByText('feat: sample commit')).toBeInTheDocument()
    expect(screen.getByText('abc1234')).toBeInTheDocument()
  })

  it('commits with the entered message and refreshes', async () => {
    render(<MemoryRouter><Git /></MemoryRouter>)
    await userEvent.type(await screen.findByPlaceholderText('输入提交信息…'), 'fix: something')
    await userEvent.click(screen.getByRole('button', { name: '提交' }))
    await waitFor(() => expect(mocks.post).toHaveBeenCalledWith('/api/git/commit', { message: 'fix: something' }))
  })
})
