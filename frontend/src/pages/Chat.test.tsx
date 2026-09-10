// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import Chat from './Chat'

const mocks = vi.hoisted(() => ({
  modelsList: vi.fn(),
  getMode: vi.fn(),
  setMode: vi.fn(),
  workspacesList: vi.fn(),
  stream: vi.fn(),
  conversations: vi.fn(),
}))

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    endpoints: {
      ...actual.endpoints,
      models: { ...actual.endpoints.models, list: mocks.modelsList },
      permissions: { getMode: mocks.getMode, setMode: mocks.setMode },
      workspaces: { list: mocks.workspacesList },
      chat: { ...actual.endpoints.chat, stream: mocks.stream },
      memory: { ...actual.endpoints.memory, conversations: mocks.conversations },
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

function renderChat(entry = '/chat') {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <Chat />
    </MemoryRouter>,
  )
}

describe('Chat page', () => {
  beforeEach(() => {
    stubMatchMedia()
    vi.resetAllMocks()
    mocks.modelsList.mockResolvedValue({ models: [] })
    mocks.getMode.mockResolvedValue({ autoAccept: false })
    mocks.workspacesList.mockResolvedValue({ workspaces: [] })
    mocks.stream.mockResolvedValue(undefined)
  })

  it('renders welcome panel when no messages', async () => {
    renderChat()
    expect(await screen.findByRole('heading', { name: /有什么可以帮助你的/ })).toBeInTheDocument()
    expect(screen.getByLabelText('消息输入框')).toBeInTheDocument()
  })

  it('sends a message and streams the assistant reply', async () => {
    mocks.stream.mockImplementation(async (_messages, onEvent) => {
      onEvent({ type: 'start', model: 'glm-4-flash', provider: 'zhipu', sessionId: 'sess-1' })
      onEvent({ type: 'token', content: '你好，' })
      onEvent({ type: 'token', content: '世界' })
      onEvent({ type: 'done', model: 'glm-4-flash', provider: 'zhipu' })
    })
    const user = userEvent.setup()
    renderChat()
    const ta = await screen.findByLabelText('消息输入框')
    await user.type(ta, 'hello world')
    await user.click(screen.getByLabelText('发送'))
    expect(await screen.findByText('hello world')).toBeInTheDocument()
    expect(await screen.findByText(/你好，世界/)).toBeInTheDocument()
    expect(mocks.stream).toHaveBeenCalledTimes(1)
    expect(ta).toHaveValue('')
  })

  it('shows error state when stream emits error event', async () => {
    mocks.stream.mockImplementation(async (_messages, onEvent) => {
      onEvent({ type: 'error', message: 'boom' })
    })
    const user = userEvent.setup()
    renderChat()
    const ta = await screen.findByLabelText('消息输入框')
    await user.type(ta, 'ask')
    await user.click(screen.getByLabelText('发送'))
    expect(await screen.findByText(/\[Error\] boom/)).toBeInTheDocument()
  })

  it('retries from an error reply', async () => {
    mocks.stream.mockImplementation(async (_messages, onEvent) => {
      onEvent({ type: 'error', message: 'boom' })
    })
    const user = userEvent.setup()
    renderChat()
    const ta = await screen.findByLabelText('消息输入框')
    await user.type(ta, 'hello')
    await user.click(screen.getByLabelText('发送'))
    expect(await screen.findByText(/\[Error\] boom/)).toBeInTheDocument()
    await user.click(screen.getByLabelText('重试'))
    await waitFor(() => expect(mocks.stream).toHaveBeenCalledTimes(2))
  })

  it('loads a session from ?session= query param', async () => {
    mocks.conversations.mockResolvedValue({
      messages: [
        { role: 'user', content: '历史问题' },
        { role: 'assistant', content: '历史回答' },
      ],
    })
    renderChat('/chat?session=sess-abc')
    expect(await screen.findByText('历史问题')).toBeInTheDocument()
    expect(await screen.findByText('历史回答')).toBeInTheDocument()
  })
})