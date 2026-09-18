// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import Sessions from './Sessions'

const mocks = vi.hoisted(() => ({
  sessions: vi.fn(),
  usage: vi.fn(),
  conversations: vi.fn(),
}))

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    endpoints: {
      ...actual.endpoints,
      memory: {
        ...actual.endpoints.memory,
        sessions: mocks.sessions,
        usage: mocks.usage,
        conversations: mocks.conversations,
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
    <MemoryRouter>
      <Sessions />
    </MemoryRouter>,
  )
}

describe('Sessions page — usage scenarios', () => {
  beforeEach(() => {
    stubMatchMedia()
    vi.resetAllMocks()
    mocks.sessions.mockResolvedValue({ sessions: [] })
    mocks.usage.mockResolvedValue({ usage: [] })
    mocks.conversations.mockResolvedValue([])
  })

  it('lists sessions from the API and opens a conversation on click', async () => {
    mocks.sessions.mockResolvedValue({
      sessions: [
        {
          session_id: 'sess-abc12345',
          message_count: 3,
          user_messages: 1,
          assistant_messages: 2,
          total_tokens: 1200,
          started_at: 1755000000,
          last_active: 1755000000,
        },
      ],
    })
    mocks.conversations.mockResolvedValue({
      messages: [
        { id: 'm1', session_id: 'sess-abc12345', role: 'user', content: '你好', created_at: 1755000000 },
        { id: 'm2', session_id: 'sess-abc12345', role: 'assistant', content: '你好！有什么可以帮你？', created_at: 1755000001 },
      ],
    })

    renderPage()

    // 会话列表出现（id 前缀 + 消息数）
    const sessionItem = await screen.findByRole('button', { name: /sess-abc/ })
    expect(sessionItem).toBeInTheDocument()
    expect(sessionItem).toHaveTextContent('3')

    // 点击会话 → 加载该会话消息
    await userEvent.click(sessionItem)
    expect(await screen.findByText('你好')).toBeInTheDocument()
    expect(screen.getByText('你好！有什么可以帮你？')).toBeInTheDocument()
    expect(mocks.conversations).toHaveBeenCalledWith('sess-abc12345')
  })

  it('shows an empty state when there are no sessions', async () => {
    renderPage()
    expect(await screen.findByText('暂无会话记录')).toBeInTheDocument()
  })

  it('keeps usage stats consistent when the API returns data', async () => {
    mocks.usage.mockResolvedValue({
      usage: [
        {
          provider: 'zhipu',
          model_name: 'glm-4-flash',
          call_count: 10,
          total_prompt_tokens: 5000,
          total_completion_tokens: 2000,
          avg_latency_ms: 300,
          success_count: 9,
        },
      ],
    })
    renderPage()
    // 使用统计在独立 tab，先切换
    await userEvent.click(await screen.findByRole('tab', { name: /使用统计/ }))
    expect(await screen.findByText(/zhipu/)).toBeInTheDocument()
    expect(screen.getByText('/ glm-4-flash')).toBeInTheDocument()
    await waitFor(() => expect(mocks.usage).toHaveBeenCalledWith(7))
  })
})
