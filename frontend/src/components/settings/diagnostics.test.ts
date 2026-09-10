import { describe, it, expect, vi } from 'vitest'
import {
  DIAGNOSTIC_PROBES,
  buildDiagnosticSnapshot,
  detectRuntime,
  runDiagnosticProbes,
} from './diagnostics'

describe('detectRuntime', () => {
  it('prefers Tauri internals over the user agent', () => {
    expect(detectRuntime({ ua: 'Mozilla/5.0 (Linux; Android 15)', tauri: true })).toBe('tauri')
  })

  it('detects Android from the user agent', () => {
    expect(detectRuntime({ ua: 'Mozilla/5.0 (Linux; Android 15; Pixel 9)' })).toBe('android')
  })

  it('treats a browser user agent as web', () => {
    expect(detectRuntime({ ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' })).toBe('web')
  })

  it('returns unknown when no environment info is available', () => {
    expect(detectRuntime({ ua: '' })).toBe('unknown')
  })
})

describe('runDiagnosticProbes', () => {
  it('reports reachable probes as ok with latency', async () => {
    const run = vi.fn(async () => ({ status: 'ok' }))
    const results = await runDiagnosticProbes(run)
    expect(results).toHaveLength(DIAGNOSTIC_PROBES.length)
    expect(results.every((r) => r.status === 'ok')).toBe(true)
    expect(run).toHaveBeenCalledTimes(DIAGNOSTIC_PROBES.length)
  })

  it('marks failing probes as error with the failure detail', async () => {
    const run = vi.fn(async (path: string) => {
      if (path === '/health') throw new Error('connection refused')
      return { status: 'ok' }
    })
    const results = await runDiagnosticProbes(run)
    const health = results.find((r) => r.id === 'health')
    expect(health?.status).toBe('error')
    expect(health?.detail).toContain('connection refused')
  })
})

describe('buildDiagnosticSnapshot', () => {
  it('includes environment and probe lines', () => {
    const info = {
      runtime: 'web' as const,
      runtimeLabel: 'Web 浏览器',
      viewport: '1440x900',
      userAgent: 'Mozilla/5.0',
      touch: false,
      timestamp: '2026-08-03T00:00:00.000Z',
    }
    const probes = DIAGNOSTIC_PROBES.map((p, i) => ({
      ...p,
      status: 'ok' as const,
      latencyMs: 12 + i,
      detail: '可达',
    }))
    const snapshot = buildDiagnosticSnapshot(probes, info)
    expect(snapshot).toContain('Axiom 诊断快照')
    expect(snapshot).toContain('运行环境：Web 浏览器')
    expect(snapshot).toContain('[OK] 网关健康 /health')
  })
})
