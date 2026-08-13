// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import Providers from './Providers'

const mocks = vi.hoisted(() => ({ apiKeysList: vi.fn() }))

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    endpoints: {
      ...actual.endpoints,
      apiKeys: { ...actual.endpoints.apiKeys, list: mocks.apiKeysList },
    },
  }
})

const providers = [
  {
    provider: 'zhipu',
    apiKeyEnv: 'ZHIPU_API_KEY',
    baseURL: 'https://open.bigmodel.cn/api/paas/v4',
    adapter: 'openai',
    region: 'domestic',
    displayName: '智谱',
    hasRegionalVariants: true,
    source: 'env',
    configured: true,
    masked: 'sk-***',
  },
  {
    provider: 'claude',
    apiKeyEnv: 'ANTHROPIC_API_KEY',
    baseURL: 'https://api.anthropic.com',
    adapter: 'anthropic',
    region: 'overseas',
    displayName: 'Anthropic',
    hasRegionalVariants: false,
    source: 'env',
    configured: false,
    masked: '',
  },
  {
    provider: 'opencode',
    apiKeyEnv: 'OPENCODE_API_KEY',
    baseURL: 'https://opencode.ai/zen/go/v1',
    adapter: 'opencode',
    region: 'global',
    displayName: 'OpenCode Go',
    hasRegionalVariants: false,
    source: 'runtime',
    configured: true,
    masked: 'sk-***',
  },
]

describe('Providers page', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    mocks.apiKeysList.mockResolvedValue({ providers })
  })

  function renderPage() {
    return render(
      <MemoryRouter initialEntries={['/providers']}>
        <Providers />
      </MemoryRouter>,
    )
  }

  it('renders provider groups and stats', async () => {
    renderPage()
    expect(await screen.findByText('智谱')).toBeInTheDocument()
    expect(screen.getByText('Anthropic')).toBeInTheDocument()
    expect(screen.getByText('OpenCode Go')).toBeInTheDocument()
    expect(screen.getByText('3')).toBeInTheDocument()
  })

  it('filters providers by search query', async () => {
    const user = userEvent.setup()
    renderPage()
    await screen.findByText('智谱')
    const search = screen.getByPlaceholderText(/搜索 provider/)
    await user.type(search, 'anthropic')
    expect(screen.getByText('Anthropic')).toBeInTheDocument()
    expect(screen.queryByText('智谱')).not.toBeInTheDocument()
    expect(screen.queryByText('OpenCode Go')).not.toBeInTheDocument()
  })

  it('shows empty state when no providers', async () => {
    mocks.apiKeysList.mockResolvedValue({ providers: [] })
    renderPage()
    expect(await screen.findByText('无 Provider 配置')).toBeInTheDocument()
  })
})