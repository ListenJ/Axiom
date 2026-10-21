import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import SearchSettingsSection from './SearchSettingsSection'

vi.mock('@/lib/api', () => ({
  api: {
    get: vi.fn(),
    post: vi.fn(),
  },
}))

import { api } from '@/lib/api'

const payload = {
  summary: {
    engineCount: 2,
    usableCount: 1,
    anonymousCount: 2,
    keyedCount: 0,
    searxngEnabled: true,
    searxngUrl: 'http://127.0.0.1:8080',
    hint: '当前 1/2 个引擎可用。',
  },
  engines: [
    { id: 'searxng', label: 'SearXNG（自建）', kind: 'api', enabled: true, usable: true, needsKey: false, hasKey: false },
    { id: 'duckduckgo', label: 'DuckDuckGo', kind: 'html', enabled: false, usable: false, needsKey: false, hasKey: false, reason: '已在配置中关闭' },
  ],
  aggregate: {
    max_results: 10,
    per_engine: 5,
    timeout_ms: 15000,
    dedupe: true,
    cache_ttl_sec: 1800,
    min_relevance: 0,
  },
  searxng: {
    enabled: true,
    auto_deploy: true,
    base_url: 'http://127.0.0.1:8080',
    bind: '127.0.0.1',
    port: 8080,
    secret_key_env: 'SEARXNG_SECRET_KEY',
    fallback_instances: [],
    fallback_timeout_ms: 8000,
  },
  policy: {
    respect_robots: true,
    max_concurrency: 3,
    request_delay_ms: 200,
    user_agent: 'AxiomBot/1.0 (+local research assistant)',
  },
}

const mockGet = vi.mocked(api.get)
const mockPost = vi.mocked(api.post)

describe('SearchSettingsSection', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGet.mockResolvedValue(payload)
  })

  it('加载后渲染当前搜索配置', async () => {
    render(<SearchSettingsSection />)

    expect(await screen.findByDisplayValue('http://127.0.0.1:8080')).toBeInTheDocument()
    expect(screen.getByRole('checkbox', { name: '启用 SearXNG（自建）' })).toBeChecked()
    expect(screen.getByRole('spinbutton', { name: '返回条数' })).toHaveValue(10)
    expect(screen.getByRole('spinbutton', { name: '单引擎超时（毫秒）' })).toHaveValue(15000)
    expect(mockGet).toHaveBeenCalledWith('/settings/web-search', { cache: false })
  })

  it('修改后保存后端要求的同结构 payload', async () => {
    mockPost.mockResolvedValue({ ok: true, engines: payload.engines })
    const user = userEvent.setup()
    render(<SearchSettingsSection />)

    await screen.findByDisplayValue('http://127.0.0.1:8080')
    await user.click(screen.getByRole('checkbox', { name: '引擎 DuckDuckGo' }))
    await user.clear(screen.getByRole('spinbutton', { name: '返回条数' }))
    await user.type(screen.getByRole('spinbutton', { name: '返回条数' }), '20')
    await user.clear(screen.getByLabelText('SearXNG 实例地址'))
    await user.type(screen.getByLabelText('SearXNG 实例地址'), 'http://127.0.0.1:8888')
    await user.click(screen.getByRole('button', { name: '保存' }))

    await waitFor(() => expect(mockPost).toHaveBeenCalledTimes(1))
    expect(mockPost).toHaveBeenCalledWith('/settings/web-search', {
      engines: [
        { id: 'searxng', enabled: true },
        { id: 'duckduckgo', enabled: true },
      ],
      aggregate: { ...payload.aggregate, max_results: 20 },
      searxng: { ...payload.searxng, base_url: 'http://127.0.0.1:8888' },
      policy: payload.policy,
    })
    expect(await screen.findByText('搜索设置已保存')).toBeInTheDocument()
  })

  it('POST 失败时显示后端错误', async () => {
    mockPost.mockRejectedValue({ data: { error: '配置文件不可写' } })
    const user = userEvent.setup()
    render(<SearchSettingsSection />)

    await screen.findByDisplayValue('http://127.0.0.1:8080')
    await user.click(screen.getByRole('checkbox', { name: '引擎 DuckDuckGo' }))
    await user.click(screen.getByRole('button', { name: '保存' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('配置文件不可写')
  })
})
