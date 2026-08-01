/**
 * GitStatusBadge 测试
 * 行为：拉取 git status 后显示分支名；有变更时显示变更数徽标；
 * 后端不可用或 status 失败时静默隐藏（null）。
 */
import { describe, expect, it, vi, afterEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { GitStatusBadge } from './GitStatusBadge'
import { endpoints } from '@/lib/api'

vi.mock('@/lib/api', () => ({
  endpoints: {
    git: {
      status: vi.fn(),
    },
  },
}))

const mockedStatus = vi.mocked(endpoints.git.status)

describe('GitStatusBadge', () => {
  afterEach(() => {
    vi.clearAllMocks()
  })

  const renderBadge = () =>
    render(
      <MemoryRouter>
        <GitStatusBadge />
      </MemoryRouter>,
    )

  it('工作区干净时显示分支名与成功标记，无变更徽标', async () => {
    mockedStatus.mockResolvedValue({
      success: true,
      branch: 'master',
      modified: [],
      added: [],
      deleted: [],
      untracked: [],
      conflicted: [],
      clean: true,
    } as never)
    renderBadge()
    await waitFor(() => expect(screen.getByText('master')).toBeVisible())
    expect(screen.queryByText('1')).toBeNull()
  })

  it('有变更时显示变更数徽标', async () => {
    mockedStatus.mockResolvedValue({
      success: true,
      branch: 'feat/x',
      modified: ['a.ts'],
      added: ['b.ts'],
      untracked: ['c.md'],
      clean: false,
    } as never)
    renderBadge()
    await waitFor(() => expect(screen.getByText('3')).toBeVisible())
    expect(screen.getByText('feat/x')).toBeVisible()
  })

  it('status 失败时静默隐藏', async () => {
    mockedStatus.mockResolvedValue({ success: false, error: 'boom' } as never)
    renderBadge()
    await waitFor(() => {
      expect(screen.queryByRole('button')).toBeNull()
    })
  })

  it('请求异常时静默隐藏', async () => {
    mockedStatus.mockRejectedValue(new Error('network'))
    renderBadge()
    await waitFor(() => {
      expect(screen.queryByRole('button')).toBeNull()
    })
  })
})
