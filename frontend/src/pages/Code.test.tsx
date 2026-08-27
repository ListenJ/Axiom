// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import Code from './Code'

const mocks = vi.hoisted(() => ({
  codegraphStatus: vi.fn(),
  fileIndex: vi.fn(),
  codegraphInit: vi.fn(),
  kgStats: vi.fn(),
}))

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    endpoints: {
      ...actual.endpoints,
      codegraph: { ...actual.endpoints.codegraph, status: mocks.codegraphStatus, fileIndex: mocks.fileIndex, init: mocks.codegraphInit },
      kg: { ...actual.endpoints.kg, stats: mocks.kgStats },
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

describe('Code page — usage scenarios', () => {
  beforeEach(() => {
    stubMatchMedia()
    vi.resetAllMocks()
    mocks.codegraphStatus.mockResolvedValue({ indexed: 188, status: 'ready' })
    mocks.fileIndex.mockResolvedValue({ files: ['src/main.ts', 'src/cli.ts'] })
    mocks.codegraphInit.mockResolvedValue({})
    mocks.kgStats.mockResolvedValue({ data: { totalNodes: 2558, totalEdges: 6665, nodesByKind: { file: 1, class: 1 } } })
  })

  it('shows codegraph status and indexed files', async () => {
    render(<MemoryRouter><Code /></MemoryRouter>)
    expect(await screen.findByText('188')).toBeInTheDocument()
    expect(screen.getByText('src/main.ts')).toBeInTheDocument()
    expect(screen.getByText('src/cli.ts')).toBeInTheDocument()
  })

  it('switches to the graph tab and shows KG stats', async () => {
    render(<MemoryRouter><Code /></MemoryRouter>)
    await userEvent.click(await screen.findByRole('tab', { name: '图谱' }))
    expect(await screen.findByText('2558')).toBeInTheDocument()
    expect(screen.getByText('6665')).toBeInTheDocument()
  })
})
