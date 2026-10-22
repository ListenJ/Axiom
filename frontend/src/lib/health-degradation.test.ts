// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { summarizeHealthDegradation } from './health-degradation'

describe('P3.5C /health 降级摘要', () => {
  it('全健康 / 字段缺失 → 无降级（不凭空报降级）', () => {
    expect(summarizeHealthDegradation(null)).toEqual({ degraded: false, reasons: [], summary: '' })
    expect(
      summarizeHealthDegradation({
        status: 'ok',
        toolRuntime: { vault: 'ok', searchEngine: 'ok', degraded: [] },
        sceneRouter: { totalScenes: 23, availableScenes: 23, degraded: false },
        security: { secondFactor: { configured: true } },
      }).degraded,
    ).toBe(false)
  })

  it('toolRuntime 降级原因码 → 人类可读原因', () => {
    const result = summarizeHealthDegradation({
      toolRuntime: { degraded: ['vault-unavailable', 'search-engine-unavailable'] },
    })
    expect(result.degraded).toBe(true)
    expect(result.reasons).toEqual(['记忆库不可用', '统一搜索不可用'])
    expect(result.summary).toBe('记忆库不可用 · 统一搜索不可用')
  })

  it('sceneRouter 降级 → 带可用场景数；二因子未配置 → 单列', () => {
    const result = summarizeHealthDegradation({
      toolRuntime: { degraded: [] },
      sceneRouter: { totalScenes: 23, availableScenes: 5, degraded: true, missingTools: ['web_search'] },
      security: { secondFactor: { configured: false, writeTier: 'fail-closed', readTier: 'fail-open' } },
    })
    expect(result.reasons).toEqual(['场景降级（5/23 可用）', '二因子未配置（只读放行）'])
  })

  it('状态字段 unavailable 但 degraded 缺失 → 仍算降级（防御式）', () => {
    const result = summarizeHealthDegradation({
      toolRuntime: { vault: 'unavailable', searchEngine: 'ok' },
    })
    expect(result.reasons).toEqual(['记忆库不可用'])
  })

  it('未知原因码透传，不吞掉', () => {
    const result = summarizeHealthDegradation({ toolRuntime: { degraded: ['some-new-reason'] } })
    expect(result.reasons).toEqual(['工具运行时降级（some-new-reason）'])
  })
})
