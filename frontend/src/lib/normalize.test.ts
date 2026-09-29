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


describe('normalizeEvalResults', () => {
  it('returns [] for non-arrays', () => {
    expect(normalizeEvalResults(null)).toEqual([])
    expect(normalizeEvalResults({})).toEqual([])
    expect(normalizeEvalResults('x')).toEqual([])
  })

  it('filters out items missing id or overall', () => {
    const input = [
      { id: '1', provider: 'p', overall: 80, quality: 0, speed: 0, cost: 0, lastEvaluated: '' },
      { id: '2', provider: 'p' /* missing overall */ },
      { id: '3', overall: 'not a number' },
      null,
      'string',
    ]
    const result = normalizeEvalResults(input)
    expect(result).toHaveLength(1)
    expect(result[0].id).toBe('1')
  })

  it('keeps items with valid id and numeric overall', () => {
    const item = { id: 'x', provider: 'p', overall: 0, quality: 0, speed: 0, cost: 0, lastEvaluated: '' }
    expect(normalizeEvalResults([item])).toEqual([item])
  })
})

describe('normalizeEvalAssignments', () => {
  it('returns [] for non-arrays', () => {
    expect(normalizeEvalAssignments(null)).toEqual([])
    expect(normalizeEvalAssignments({})).toEqual([])
  })

  it('filters out items missing id or score', () => {
    const input = [
      { id: '1', role: 'r', model: 'm', provider: 'p', score: 90, lastAssigned: '' },
      { id: '2' /* missing score */ },
      { id: '3', score: 'not a number' },
      null,
    ]
    const result = normalizeEvalAssignments(input)
    expect(result).toHaveLength(1)
    expect(result[0].id).toBe('1')
  })
})

describe('normalizeEvalModels', () => {
  it('returns [] for non-arrays', () => {
    expect(normalizeEvalModels(null)).toEqual([])
    expect(normalizeEvalModels({})).toEqual([])
  })

  it('filters out items missing id or contextLength', () => {
    const input = [
      { id: '1', name: 'm', provider: 'p', contextLength: 8192, pricing: { prompt: 0, completion: 0 } },
      { id: '2' /* missing contextLength */ },
      { id: '3', contextLength: '8192' },
      null,
    ]
    const result = normalizeEvalModels(input)
    expect(result).toHaveLength(1)
    expect(result[0].id).toBe('1')
  })
})
