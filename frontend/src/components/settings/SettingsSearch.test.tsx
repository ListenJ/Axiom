import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import SettingsSearch from './SettingsSearch'
import { clientKeywordSearch, SETTINGS_CATALOG } from './settings-data'

vi.mock('@/lib/api', () => ({
  endpoints: {
    settings: {
      catalog: vi.fn(),
      search: vi.fn(),
    },
  },
}))

import { endpoints } from '@/lib/api'
const mockSearch = vi.mocked(endpoints.settings.search)

describe('SettingsSearch', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('渲染搜索框并展示后端语义结果与 engine 提示', async () => {
    mockSearch.mockResolvedValue({
      query: '缓存',
      engine: 'semantic',
      results: [
        { key: 'data.cache', label: '清空 API 缓存', desc: '清除搜索与模型的临时缓存条目', section: '数据', score: 0.9, matchType: 'semantic' },
      ],
    })
    const onSelect = vi.fn()
    const user = userEvent.setup()
    render(<SettingsSearch onSelect={onSelect} />)
    await user.type(screen.getByLabelText('搜索设置项'), '缓存')
    await screen.findByText('清空 API 缓存')
    expect(screen.getByText(/语义匹配/)).toBeInTheDocument()
  })

  it('后端失败时客户端关键词兜底命中「缓存」', async () => {
    mockSearch.mockRejectedValue(new Error('offline'))
    const user = userEvent.setup()
    render(<SettingsSearch onSelect={() => {}} />)
    await user.type(screen.getByLabelText('搜索设置项'), '缓存')
    await screen.findByText('清空 API 缓存')
    expect(screen.getByText(/离线兜底/)).toBeInTheDocument()
  })

  it('点击结果触发 onSelect(key)', async () => {
    mockSearch.mockResolvedValue({
      query: '权限',
      engine: 'keyword',
      results: [
        { key: 'permissions.autoAccept', label: '全局权限自动接收', desc: '后端全局权限模式', section: '对话与行为', score: 1, matchType: 'keyword' },
      ],
    })
    const onSelect = vi.fn()
    const user = userEvent.setup()
    render(<SettingsSearch onSelect={onSelect} />)
    await user.type(screen.getByLabelText('搜索设置项'), '权限')
    const hit = await screen.findByRole('button', { name: /全局权限自动接收/ })
    await user.click(hit)
    expect(onSelect).toHaveBeenCalledWith('permissions.autoAccept', expect.any(String))
  })

  it('空输入清空结果', async () => {
    mockSearch.mockResolvedValue({ query: '', engine: 'keyword', results: [] })
    const user = userEvent.setup()
    render(<SettingsSearch onSelect={() => {}} />)
    await user.type(screen.getByLabelText('搜索设置项'), '缓存')
    await screen.findByText('清空 API 缓存')
    await user.clear(screen.getByLabelText('搜索设置项'))
    expect(screen.queryByText('清空 API 缓存')).not.toBeInTheDocument()
  })
})

describe('clientKeywordSearch（离线兜底纯函数）', () => {
  it('「缓存」命中 data.cache', () => {
    const hits = clientKeywordSearch('缓存')
    expect(hits[0]?.key).toBe('data.cache')
  })

  it('「权限」同时命中会话偏好与后端权限模式', () => {
    const hits = clientKeywordSearch('权限')
    const keys = hits.map((h) => h.key)
    expect(keys).toContain('chat.autoAcceptPermissions')
    expect(keys).toContain('permissions.autoAccept')
  })

  it('目录条目 key 唯一且与后端契约字段齐全', () => {
    const keys = SETTINGS_CATALOG.map((i) => i.key)
    expect(new Set(keys).size).toBe(keys.length)
    for (const item of SETTINGS_CATALOG) {
      expect(item.label).toBeTruthy()
      expect(item.desc.length).toBeGreaterThan(10)
      expect(Array.isArray(item.keywords)).toBe(true)
      expect(['app', 'local', 'chat', 'backend']).toContain(item.source)
    }
  })
})