import { describe, expect, it } from 'vitest'
import { normalizePromMetrics } from './normalize'

describe('normalizePromMetrics (Prometheus text parsing)', () => {
  it('parses common metric lines', () => {
    const text = [
      'process_cpu_seconds_total 12.5',
      'process_memory_bytes 104857600',
      'http_requests_total 100',
    ].join('\n')
    const m = normalizePromMetrics(text)
    expect(m).not.toBeNull()
    expect(m!.cpu).toBe(12.5)
    expect(m!.memory).toBe(104857600)
    expect(m!.rps).toBe(100)
  })

  it('returns null for non-text / empty', () => {
    expect(normalizePromMetrics('')).toBeNull()
    expect(normalizePromMetrics('   ')).toBeNull()
  })
})
