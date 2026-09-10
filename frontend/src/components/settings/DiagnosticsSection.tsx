import { useCallback, useEffect, useState } from 'react'
import {
  Activity,
  Copy,
  Cpu,
  Monitor,
  RefreshCw,
  Smartphone,
  WifiOff,
} from 'lucide-react'
import { Button, ShimmerCard, Skeleton } from '@/components/ui'
import { api } from '@/lib/api'
import {
  DIAGNOSTIC_PROBES,
  buildDiagnosticSnapshot,
  buildPlatformInfo,
  runDiagnosticProbes,
  type DiagnosticProbeResult,
  type PlatformInfo,
} from './diagnostics'

interface DiagnosticsSectionProps {
  toast: (message: string, type?: 'info' | 'success' | 'error' | 'warning') => void
}

const RUNTIME_ICONS = {
  web: Monitor,
  tauri: Cpu,
  android: Smartphone,
  unknown: WifiOff,
}

/** 设置页“调试与检查”：运行环境 + 核心服务健康探针 + 快照复制 */
export default function DiagnosticsSection({ toast }: DiagnosticsSectionProps) {
  const [platform, setPlatform] = useState<PlatformInfo>(() => buildPlatformInfo())
  const [probes, setProbes] = useState<DiagnosticProbeResult[] | null>(null)
  const [running, setRunning] = useState(false)

  const refresh = useCallback(async () => {
    setRunning(true)
    setPlatform(buildPlatformInfo())
    try {
      const results = await runDiagnosticProbes((path) => api.get(path))
      setProbes(results)
    } catch {
      setProbes(
        DIAGNOSTIC_PROBES.map((p) => ({
          ...p,
          status: 'error' as const,
          latencyMs: 0,
          detail: '检查执行失败',
        })),
      )
    } finally {
      setRunning(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const copySnapshot = async () => {
    const snapshot = buildDiagnosticSnapshot(
      probes ??
        DIAGNOSTIC_PROBES.map((p) => ({
          ...p,
          status: 'error' as const,
          latencyMs: 0,
          detail: '尚未检查',
        })),
      platform,
    )
    try {
      if (!navigator.clipboard) throw new Error('clipboard unavailable')
      await navigator.clipboard.writeText(snapshot)
      toast('诊断快照已复制', 'success')
    } catch {
      toast('复制失败，请手动选择文本', 'error')
    }
  }

  const RuntimeIcon = RUNTIME_ICONS[platform.runtime]
  const healthy = probes ? probes.filter((p) => p.status === 'ok').length : 0

  return (
    <div className="space-y-3">
      <ShimmerCard padding="md">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-3">
            <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-[var(--info-soft)] text-[var(--info)]">
              <RuntimeIcon className="size-5" />
            </div>
            <div className="min-w-0">
              <h3 className="text-sm font-medium text-[var(--text)]">运行环境</h3>
              <p className="text-xs text-[var(--text-secondary)]">
                {platform.runtimeLabel} · {platform.viewport} · 触控
                {platform.touch ? '支持' : '不支持'}
              </p>
              <p className="mt-0.5 truncate font-mono text-2xs text-[var(--text-muted)]">
                {platform.userAgent || 'n/a'}
              </p>
            </div>
          </div>
          <div className="flex shrink-0 gap-2">
            <Button
              size="sm"
              variant="secondary"
              onClick={() => void refresh()}
              loading={running}
              icon={<RefreshCw className="size-3.5" />}
              aria-label="重新检查"
            >
              重新检查
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => void copySnapshot()}
              icon={<Copy className="size-3.5" />}
              aria-label="复制诊断快照"
            >
              复制快照
            </Button>
          </div>
        </div>
      </ShimmerCard>

      <ShimmerCard padding="md">
        <h3 className="mb-2 flex items-center gap-2 text-sm font-medium text-[var(--text)]">
          <Activity className="size-4 text-[var(--accent)]" />
          服务健康检查
          {probes && (
            <span
              className={`text-2xs ${healthy === probes.length ? 'text-[var(--success)]' : 'text-[var(--warning)]'}`}
            >
              {healthy}/{probes.length} 正常
            </span>
          )}
        </h3>
        {!probes ? (
          <div className="space-y-2">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} height="2.25rem" />
            ))}
          </div>
        ) : (
          <ul className="space-y-1.5">
            {probes.map((p) => (
              <li
                key={p.id}
                className="flex items-center gap-3 rounded-lg bg-[var(--bg-tertiary)] px-3 py-2"
              >
                <span
                  className={`size-2 shrink-0 rounded-full ${
                    p.status === 'ok' ? 'bg-[var(--success)]' : 'bg-[var(--danger)]'
                  }`}
                  aria-hidden="true"
                />
                <span className="w-20 shrink-0 text-xs font-medium text-[var(--text)]">
                  {p.label}
                </span>
                <code className="hidden min-w-0 flex-1 truncate font-mono text-2xs text-[var(--text-muted)] sm:block">
                  {p.path}
                </code>
                <span className="shrink-0 font-mono text-2xs text-[var(--text-muted)]">
                  {p.latencyMs}ms
                </span>
                <span
                  className={`shrink-0 text-2xs ${
                    p.status === 'ok' ? 'text-[var(--success)]' : 'text-[var(--danger)]'
                  }`}
                >
                  {p.status === 'ok' ? '正常' : '异常'}
                </span>
              </li>
            ))}
          </ul>
        )}
        <p className="mt-2 text-2xs text-[var(--text-muted)]">
          检查结果与 `/health`、`/sandbox/status`、`/ocr/status`、`/codegraph/status`、`/agents/status` 一一对应。
        </p>
      </ShimmerCard>
    </div>
  )
}
