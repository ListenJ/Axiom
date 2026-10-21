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
  // 后端 GET 返回的配置内容修订号（保存时用于 If-Match 乐观并发）
  revision: 'rev-1',
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

  it('修改后保存后端要求的同结构 payload（带 If-Match 修订号）', async () => {
    mockPost.mockResolvedValue({ ok: true, engines: payload.engines, revision: 'rev-2' })
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
    expect(mockPost).toHaveBeenCalledWith(
      '/settings/web-search',
      {
        engines: [
          { id: 'searxng', enabled: true },
          { id: 'duckduckgo', enabled: true },
        ],
        aggregate: { ...payload.aggregate, max_results: 20 },
        searxng: { ...payload.searxng, base_url: 'http://127.0.0.1:8888' },
        policy: payload.policy,
      },
      { ifMatch: 'rev-1' },
    )
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

  it('409 并发冲突：保留未保存修改，提供「重新加载」与「强制覆盖」两个动作', async () => {
    const conflict = Object.assign(new Error('conflict'), {
      status: 409,
      data: { error: '配置已被其他请求修改', code: 'revision-conflict', revision: 'rev-latest' },
    })
    mockPost.mockRejectedValueOnce(conflict)
    const toast = vi.fn()
    const user = userEvent.setup()
    render(<SearchSettingsSection toast={toast} />)

    await screen.findByDisplayValue('http://127.0.0.1:8080')
    expect(mockGet).toHaveBeenCalledTimes(1)
    // 用户先改了一个值（未保存）
    await user.clear(screen.getByRole('spinbutton', { name: '返回条数' }))
    await user.type(screen.getByRole('spinbutton', { name: '返回条数' }), '20')
    await user.click(screen.getByRole('button', { name: '保存' }))

    // 冲突提示可见，且**不自动重载**（不丢弃用户的未保存编辑）
    expect(await screen.findByRole('alert')).toHaveTextContent('配置已被其他窗口/请求修改')
    expect(toast).toHaveBeenCalled()
    expect(mockGet).toHaveBeenCalledTimes(1)
    // 未保存编辑仍在
    expect(screen.getByRole('spinbutton', { name: '返回条数' })).toHaveValue(20)
    // 两个动作入口
    expect(screen.getByRole('button', { name: /重新加载最新值/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /强制覆盖（需二次确认）/ })).toBeInTheDocument()
  })

  it('409 后「强制覆盖」需二次确认，并以最新 revision 提交', async () => {
    const conflict = Object.assign(new Error('conflict'), {
      status: 409,
      data: { error: '配置已被其他请求修改', code: 'revision-conflict', revision: 'rev-latest' },
    })
    mockPost.mockRejectedValueOnce(conflict)
    mockPost.mockResolvedValueOnce({ ok: true, engines: payload.engines, revision: 'rev-new' })
    const user = userEvent.setup()
    render(<SearchSettingsSection />)

    await screen.findByDisplayValue('http://127.0.0.1:8080')
    await user.click(screen.getByRole('checkbox', { name: '引擎 DuckDuckGo' }))
    await user.click(screen.getByRole('button', { name: '保存' }))
    await screen.findByRole('alert')

    // 第一次点击只进入确认态，不提交
    await user.click(screen.getByRole('button', { name: /强制覆盖（需二次确认）/ }))
    expect(mockPost).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('button', { name: /确认强制覆盖/ })).toBeInTheDocument()

    // 第二次点击才真正提交，且 If-Match 使用 409 响应中的最新 revision
    await user.click(screen.getByRole('button', { name: /确认强制覆盖/ }))
    await waitFor(() => expect(mockPost).toHaveBeenCalledTimes(2))
    expect(mockPost).toHaveBeenLastCalledWith(
      '/settings/web-search',
      expect.objectContaining({ aggregate: payload.aggregate }),
      { ifMatch: 'rev-latest' },
    )
    expect(await screen.findByText(/已强制覆盖保存/)).toBeInTheDocument()
  })

  it('409 后「重新加载最新值」丢弃本地修改并刷新表单', async () => {
    const conflict = Object.assign(new Error('conflict'), {
      status: 409,
      data: { error: '配置已被其他请求修改', code: 'revision-conflict', revision: 'rev-latest' },
    })
    mockPost.mockRejectedValueOnce(conflict)
    mockGet
      .mockResolvedValueOnce(payload)
      .mockResolvedValueOnce({ ...payload, revision: 'rev-latest', aggregate: { ...payload.aggregate, max_results: 30 } })
    const user = userEvent.setup()
    render(<SearchSettingsSection />)

    await screen.findByDisplayValue('http://127.0.0.1:8080')
    await user.click(screen.getByRole('checkbox', { name: '引擎 DuckDuckGo' }))
    await user.click(screen.getByRole('button', { name: '保存' }))
    await screen.findByRole('alert')

    await user.click(screen.getByRole('button', { name: /重新加载最新值/ }))
    await waitFor(() => expect(mockGet).toHaveBeenCalledTimes(2))
    // 刷新为服务端最新值，冲突提示消失
    await waitFor(() => expect(screen.getByRole('spinbutton', { name: '返回条数' })).toHaveValue(30))
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(mockPost).toHaveBeenCalledTimes(1)
  })

  it('加载失败显示「重试」入口，点击后恢复表单', async () => {
    mockGet.mockRejectedValueOnce(new Error('读取失败')).mockResolvedValueOnce(payload)
    const user = userEvent.setup()
    render(<SearchSettingsSection />)

    expect(await screen.findByRole('alert')).toHaveTextContent('读取失败')
    await user.click(screen.getByRole('button', { name: '重试' }))
    expect(await screen.findByDisplayValue('http://127.0.0.1:8080')).toBeInTheDocument()
    expect(mockGet).toHaveBeenCalledTimes(2)
  })
})
