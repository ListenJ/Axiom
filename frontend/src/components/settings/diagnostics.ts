/**
 * 设置页“调试与检查”的纯逻辑：运行环境识别、核心服务探针与诊断快照。
 */
import { api } from '@/lib/api'

export type RuntimeKind = 'web' | 'tauri' | 'android' | 'unknown'

export const RUNTIME_LABELS: Record<RuntimeKind, string> = {
  web: 'Web 浏览器',
  tauri: 'Tauri 桌面（Windows/Linux）',
  android: 'Android',
  unknown: '未知环境',
}

export interface DiagnosticProbe {
  id: string
  label: string
  path: string
}

export const DIAGNOSTIC_PROBES: DiagnosticProbe[] = [
  { id: 'health', label: '网关健康', path: '/health' },
  { id: 'version', label: '服务版本', path: '/version' },
  { id: 'sandbox', label: '沙箱', path: '/sandbox/status' },
  { id: 'ocr', label: 'OCR', path: '/ocr/status' },
  { id: 'codegraph', label: '代码图谱', path: '/codegraph/status' },
  { id: 'agents', label: 'Agent', path: '/agents/status' },
]

export interface DiagnosticProbeResult extends DiagnosticProbe {
  status: 'ok' | 'error'
  latencyMs: number
  detail: string
}

export interface PlatformInfo {
  runtime: RuntimeKind
  runtimeLabel: string
  viewport: string
  userAgent: string
  touch: boolean
  timestamp: string
}

export interface RuntimeEnv {
  ua?: string
  tauri?: boolean
}

export function detectRuntime(env: RuntimeEnv = {}): RuntimeKind {
  const ua = env.ua ?? (typeof navigator !== 'undefined' ? navigator.userAgent : '')
  const tauri = env.tauri ?? (typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window)
  if (tauri) return 'tauri'
  if (/Android/i.test(ua)) return 'android'
  if (ua.length > 0) return 'web'
  return 'unknown'
}

export function buildPlatformInfo(): PlatformInfo {
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : ''
  const runtime = detectRuntime()
  const viewport =
    typeof window !== 'undefined' ? `${window.innerWidth}x${window.innerHeight}` : 'n/a'
  const touch = typeof navigator !== 'undefined' ? navigator.maxTouchPoints > 0 : false
  return {
    runtime,
    runtimeLabel: RUNTIME_LABELS[runtime],
    viewport,
    userAgent: ua,
    touch,
    timestamp: new Date().toISOString(),
  }
}

export type ProbeRunner = (path: string) => Promise<unknown>

export async function runDiagnosticProbes(
  run: ProbeRunner = (path) => api.get(path),
): Promise<DiagnosticProbeResult[]> {
  const settled = await Promise.allSettled(
    DIAGNOSTIC_PROBES.map(async (probe) => {
      const t0 = performance.now()
      try {
        await run(probe.path)
        return {
          ...probe,
          status: 'ok' as const,
          latencyMs: Math.round(performance.now() - t0),
          detail: '可达',
        }
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err)
        return {
          ...probe,
          status: 'error' as const,
          latencyMs: Math.round(performance.now() - t0),
          detail,
        }
      }
    }),
  )
  return settled.map((r, i) =>
    r.status === 'fulfilled'
      ? r.value
      : {
          ...DIAGNOSTIC_PROBES[i],
          status: 'error' as const,
          latencyMs: 0,
          detail: '探针执行异常',
        },
  )
}

export function buildDiagnosticSnapshot(
  probes: DiagnosticProbeResult[],
  info: PlatformInfo = buildPlatformInfo(),
): string {
  const lines = [
    'Axiom 诊断快照',
    `生成时间：${info.timestamp}`,
    `运行环境：${info.runtimeLabel}`,
    `视口：${info.viewport}`,
    `触控：${info.touch ? '支持' : '不支持'}`,
    `User-Agent：${info.userAgent || 'n/a'}`,
    '--- 服务检查 ---',
    ...probes.map((p) => {
      const status = p.status === 'ok' ? 'OK' : 'FAIL'
      const suffix = p.status === 'error' ? ` · ${p.detail}` : ''
      return `[${status}] ${p.label} ${p.path} ${p.latencyMs}ms${suffix}`
    }),
  ]
  return lines.join('\n')
}
