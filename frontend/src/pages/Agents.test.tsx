// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import Agents from './Agents'

const mocks = vi.hoisted(() => ({
  agentsStatus: vi.fn(),
  agentsReview: vi.fn(),
}))

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    endpoints: {
      ...actual.endpoints,
      agents: {
        ...actual.endpoints.agents,
        status: mocks.agentsStatus,
        review: mocks.agentsReview,
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
      <Agents />
    </MemoryRouter>,
  )
}

describe('Agents page — usage scenarios', () => {
  beforeEach(() => {
    stubMatchMedia()
    vi.resetAllMocks()
    mocks.agentsStatus.mockResolvedValue({ agents: [] })
    mocks.agentsReview.mockResolvedValue('审查结果：代码可读性良好')
  })

  it('lists available agents from the API', async () => {
    mocks.agentsStatus.mockResolvedValue({
      agents: [
        { name: 'OpenCode', available: true },
        { name: 'Hermes', available: false },
      ],
    })
    renderPage()
    expect(await screen.findByText('OpenCode')).toBeInTheDocument()
    expect(screen.getByText('Hermes')).toBeInTheDocument()
  })

  it('runs a code review and shows the result', async () => {
    renderPage()
    await userEvent.click(await screen.findByRole('button', { name: /审查/ }))
    expect(await screen.findByText(/审查结果：代码可读性良好/)).toBeInTheDocument()
    await waitFor(() => expect(mocks.agentsReview).toHaveBeenCalled())
  })
})
