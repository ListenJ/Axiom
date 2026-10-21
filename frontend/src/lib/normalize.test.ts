import { describe, it, expect } from 'vitest'
import {
  normalizeInstalled,
  normalizeAvailable,
  normalizeTools,
  normalizeMetrics,
  normalizeEvalResults,
  normalizeEvalAssignments,
  normalizeEvalModels,
} from './normalize'

describe('normalizeInstalled', () => {
  it('returns array as-is when it is an array', () => {
    const arr = [
      { id: 'a', name: 'A', description: '', version: '1', author: 'me', enabled: true, installed: true },
    ]
    expect(normalizeInstalled(arr)).toBe(arr)
  })

  it('unwraps { installed: [...] }', () => {
    const arr = [{ id: 'a', name: 'A', description: '', version: '1', author: 'me', enabled: true, installed: true }]
    expect(normalizeInstalled({ installed: arr })).toEqual(arr)
  })

  it('unwraps { plugins: [...] }', () => {
    const arr = [{ id: 'a', name: 'A', description: '', version: '1', author: 'me', enabled: true, installed: true }]
    expect(normalizeInstalled({ plugins: arr })).toEqual(arr)
  })

  it('returns [] for null / undefined / string / number / boolean', () => {
    expect(normalizeInstalled(null)).toEqual([])
    expect(normalizeInstalled(undefined)).toEqual([])
    expect(normalizeInstalled('nope')).toEqual([])
    expect(normalizeInstalled(42)).toEqual([])
    expect(normalizeInstalled(true)).toEqual([])
  })

  it('returns [] for objects without the expected keys', () => {
    expect(normalizeInstalled({})).toEqual([])
    expect(normalizeInstalled({ foo: 'bar' })).toEqual([])
    expect(normalizeInstalled({ installed: 'not an array' })).toEqual([])
  })
})

describe('normalizeAvailable', () => {
  const arr = [{ id: 'a', name: 'A', description: '', version: '1', author: 'me' }]

  it('returns array as-is', () => {
    expect(normalizeAvailable(arr)).toBe(arr)
  })

  it('unwraps { available: [...] }', () => {
    expect(normalizeAvailable({ available: arr })).toEqual(arr)
  })

  it('unwraps { plugins: [...] }', () => {
    expect(normalizeAvailable({ plugins: arr })).toEqual(arr)
  })

  it('returns [] for invalid payloads', () => {
    expect(normalizeAvailable(null)).toEqual([])
    expect(normalizeAvailable({ available: 'x' })).toEqual([])
  })
})

describe('normalizeTools', () => {
  const arr = [{ name: 't', pluginId: 'p', description: '' }]

  it('returns array as-is', () => {
    expect(normalizeTools(arr)).toBe(arr)
  })

  it('unwraps { tools: [...] }', () => {
    expect(normalizeTools({ tools: arr })).toEqual(arr)
  })

  it('returns [] for invalid payloads', () => {
    expect(normalizeTools(null)).toEqual([])
    expect(normalizeTools({ tools: 'x' })).toEqual([])
  })
})

describe('normalizeMetrics', () => {
  it('extracts known numeric fields', () => {
    expect(
      normalizeMetrics({ cpu: 12, memory: 4096, rps: 100, p50: 50, p95: 250 })
    ).toEqual({ cpu: 12, memory: 4096, rps: 100, p50: 50, p95: 250 })
  })

  it('drops non-numeric fields', () => {
    expect(
      normalizeMetrics({ cpu: '12', memory: null, p50: undefined, p95: 200 })
    ).toEqual({ cpu: undefined, memory: undefined, rps: undefined, p50: undefined, p95: 200 })
  })

  it('returns null for arrays, null, undefined, primitives', () => {
    expect(normalizeMetrics([])).toBeNull()
    expect(normalizeMetrics(null)).toBeNull()
    expect(normalizeMetrics(undefined)).toBeNull()
    expect(normalizeMetrics('string')).toBeNull()
    expect(normalizeMetrics(42)).toBeNull()
    expect(normalizeMetrics(true)).toBeNull()
  })
})


describe('normalizeEvalResults（后端 ModelEvalResult 形状）', () => {
  it('returns [] for non-arrays', () => {
    expect(normalizeEvalResults(null)).toEqual([])
    expect(normalizeEvalResults({})).toEqual([])
    expect(normalizeEvalResults('x')).toEqual([])
  })

  it('maps modelId/scores/evaluatedAt into the display shape', () => {
    const input = [
      {
        modelId: 'deepseek/deepseek-v4',
        provider: 'deepseek',
        evaluatedAt: '2026-10-21T00:00:00.000Z',
        scores: { capability: 88, speed: 92, cost: 80, safety: 95, overall: 90 },
        benchmarks: [],
        metadata: {},
      },
    ]
    expect(normalizeEvalResults(input)).toEqual([
      {
        id: 'deepseek/deepseek-v4',
        provider: 'deepseek',
        overall: 90,
        quality: 88,
        speed: 92,
        cost: 80,
        safety: 95,
        lastEvaluated: '2026-10-21T00:00:00.000Z',
      },
    ])
  })

  it('filters items without a usable modelId, tolerates missing scores fields', () => {
    const input = [
      { modelId: 'm1', provider: 'p', evaluatedAt: 'x', scores: { overall: 75 } },
      { modelId: '' },
      { provider: 'p' },
      null,
      'string',
    ]
    const result = normalizeEvalResults(input)
    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({ id: 'm1', overall: 75, quality: 0, speed: 0, cost: 0 })
  })
})

describe('normalizeEvalAssignments（后端 DynamicAssignment 形状）', () => {
  it('returns [] for non-arrays', () => {
    expect(normalizeEvalAssignments(null)).toEqual([])
    expect(normalizeEvalAssignments({})).toEqual([])
  })

  it('maps modelId/assignedRoles/evalScore into the display shape', () => {
    const input = [
      {
        modelId: 'glm-5.3',
        provider: 'zhipu',
        model: 'glm-5.3',
        assignedRoles: ['coder', 'reviewer'],
        evalScore: 85,
        priority: 1,
        reason: 'best capability',
        evaluatedAt: '2026-10-21T00:00:00.000Z',
      },
      { modelId: '' },
      null,
    ]
    expect(normalizeEvalAssignments(input)).toEqual([
      {
        id: 'glm-5.3',
        role: 'coder / reviewer',
        model: 'glm-5.3',
        provider: 'zhipu',
        score: 85,
        lastAssigned: '2026-10-21T00:00:00.000Z',
      },
    ])
  })
})

describe('normalizeEvalModels（后端 OpenRouterModelInfo 形状）', () => {
  it('returns [] for non-arrays', () => {
    expect(normalizeEvalModels(null)).toEqual([])
    expect(normalizeEvalModels({})).toEqual([])
  })

  it('maps id/context_length/pricing into the display shape', () => {
    const input = [
      {
        id: 'openai/gpt-4',
        name: 'gpt-4',
        pricing: { prompt: '0.00001', completion: '0.00003' },
        context_length: 128000,
      },
      { name: 'missing-id' },
      null,
    ]
    expect(normalizeEvalModels(input)).toEqual([
      {
        id: 'openai/gpt-4',
        name: 'gpt-4',
        provider: 'openai',
        contextLength: 128000,
        pricing: { prompt: 0.00001, completion: 0.00003 },
      },
    ])
  })
})
