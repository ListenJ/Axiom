// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import Proxies from './Proxies'

const mocks = vi.hoisted(() => ({ list: vi.fn() }))

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return { ...actual, endpoints: { ...actual.endpoints, proxies: { ...actual.endpoints.proxies, list: mocks.list } } }
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

describe('Proxies page — usage scenarios', () => {
  beforeEach(() => {
    stubMatchMedia()
    vi.resetAllMocks()
    mocks.list.mockResolvedValue([])
  })

  it('lists configured proxies with active status', async () => {
    mocks.list.mockResolvedValue([
      { host: '127.0.0.1', port: '7890', protocol: 'http', country: 'CN', active: true },
      { host: '10.0.0.9', port: '8080', protocol: 'socks5', country: 'US', active: false },
    ])
    render(<MemoryRouter><Proxies /></MemoryRouter>)
    expect(await screen.findByText('127.0.0.1')).toBeInTheDocument()
    expect(screen.getByText(':7890')).toBeInTheDocument()
    expect(screen.getByText('10.0.0.9')).toBeInTheDocument()
    expect(screen.getByText(':8080')).toBeInTheDocument()
    expect(screen.getByText('活跃')).toBeInTheDocument()
    expect(screen.getByText('禁用')).toBeInTheDocument()
  })

  it('shows an empty state when no proxies are configured', async () => {
    render(<MemoryRouter><Proxies /></MemoryRouter>)
    expect(await screen.findByText('未配置代理')).toBeInTheDocument()
  })
})
