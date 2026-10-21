import { useEffect, useState } from 'react'
import { AlertTriangle, Search, Save } from 'lucide-react'
import { Button, ShimmerCard } from '@/components/ui'
import { api } from '@/lib/api'

type Engine = {
  id: string
  label: string
  kind: string
  enabled: boolean
  usable: boolean
  needsKey: boolean
  hasKey: boolean
  reason?: string
}

type Aggregate = {
  max_results: number
  per_engine: number
  timeout_ms: number
  dedupe: boolean
  cache_ttl_sec: number
  min_relevance: number
}

type Searxng = {
  enabled: boolean
  auto_deploy: boolean
  base_url: string
  bind: string
  port: number
  secret_key_env: string
  fallback_instances: string[]
  fallback_timeout_ms: number
}

type Policy = {
  respect_robots: boolean
  max_concurrency: number
  request_delay_ms: number
  user_agent: string
}

type Payload = {
  summary: { hint: string }
  engines: Engine[]
  aggregate: Aggregate
  searxng: Searxng
  policy: Policy
}

const numericFields: Array<{ section: 'aggregate' | 'searxng' | 'policy'; key: string; label: string; min: number; step?: number }> = [
  { section: 'aggregate', key: 'max_results', label: '返回条数', min: 1 },
  { section: 'aggregate', key: 'per_engine', label: '单引擎返回条数', min: 1 },
  { section: 'aggregate', key: 'timeout_ms', label: '单引擎超时（毫秒）', min: 1 },
  { section: 'aggregate', key: 'cache_ttl_sec', label: '缓存 TTL（秒）', min: 0 },
  { section: 'aggregate', key: 'min_relevance', label: '最低相关度', min: 0, step: 0.01 },
  { section: 'searxng', key: 'port', label: 'SearXNG 端口', min: 1 },
  { section: 'searxng', key: 'fallback_timeout_ms', label: 'SearXNG 回退超时（毫秒）', min: 1 },
  { section: 'policy', key: 'max_concurrency', label: '最大抓取并发', min: 1 },
  { section: 'policy', key: 'request_delay_ms', label: '请求间隔（毫秒）', min: 0 },
]

function errorMessage(error: unknown, fallback: string) {
  const data = (error as { data?: { error?: unknown } } | null)?.data
  if (typeof data?.error === 'string' && data.error) return data.error
  return error instanceof Error && error.message ? error.message : fallback
}

export default function SearchSettingsSection({
  toast,
  highlightKey,
}: {
  toast?: (message: string, type?: 'success' | 'error' | 'info' | 'warning') => void
  highlightKey?: string | null
}) {
  const [data, setData] = useState<Payload | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    api.get<Payload>('/settings/web-search', { cache: false })
      .then((value) => {
        if (!cancelled) setData(value)
      })
      .catch((reason: unknown) => {
        if (!cancelled) setError(errorMessage(reason, '读取搜索设置失败'))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => { cancelled = true }
  }, [])

  const updateNumber = (section: 'aggregate' | 'searxng' | 'policy', key: string, value: number) => {
    setData((current) => current ? {
      ...current,
      [section]: { ...current[section], [key]: value },
    } : current)
    setError(null)
    setSuccess(null)
  }

  const save = async () => {
    if (!data) return
    for (const field of numericFields) {
      const value = (data[field.section] as unknown as Record<string, unknown>)[field.key]
      if (typeof value !== 'number' || !Number.isFinite(value) || value < field.min) {
        const message = `${field.label}必须是不小于 ${field.min} 的数字`
        setError(message)
        toast?.(message, 'error')
        return
      }
    }
    setSaving(true)
    setError(null)
    setSuccess(null)
    const body = {
      engines: data.engines.map(({ id, enabled }) => ({ id, enabled })),
      aggregate: data.aggregate,
      searxng: data.searxng,
      policy: data.policy,
    }
    try {
      const response = await api.post<{ ok?: boolean; engines?: Engine[] }>('/settings/web-search', body)
      if (response.ok !== true) throw new Error('后端未确认保存成功')
      setData((current) => current ? { ...current, engines: response.engines ?? current.engines } : current)
      setSuccess('搜索设置已保存')
      toast?.('搜索设置已保存', 'success')
    } catch (reason) {
      const message = errorMessage(reason, '保存搜索设置失败')
      setError(message)
      toast?.(`保存失败：${message}`, 'error')
    } finally {
      setSaving(false)
    }
  }

  return (
    <ShimmerCard variant="accent" padding="md" className={highlightKey === 'search.web' ? 'ring-2 ring-[var(--accent)]' : undefined}>
      <div className="flex flex-col gap-4">
        <div className="flex items-center gap-2">
          <span className="flex size-8 items-center justify-center rounded-lg bg-[var(--accent-soft)] text-[var(--accent)]"><Search className="size-4" /></span>
          <h3 className="text-sm font-medium text-[var(--text)]">网络搜索</h3>
        </div>
        {loading && <p className="text-xs text-[var(--text-muted)]">正在读取搜索配置…</p>}
        {data && !loading && (
          <>
            <p className="text-xs text-[var(--text-muted)]">{data.summary.hint}</p>
            <fieldset className="grid gap-2">
              <legend className="mb-1 text-xs font-medium text-[var(--text)]">搜索引擎</legend>
              {data.engines.map((engine) => (
                <label key={engine.id} className="flex min-h-11 items-center justify-between gap-3 rounded-lg bg-[var(--surface-hover)] px-3 text-xs text-[var(--text-secondary)]">
                  <span>{engine.label}<span className="ml-2 text-[var(--text-muted)]">{engine.reason}</span></span>
                  <input aria-label={`引擎 ${engine.label}`} type="checkbox" checked={engine.enabled} disabled={saving} onChange={(event) => setData({ ...data, engines: data.engines.map((item) => item.id === engine.id ? { ...item, enabled: event.target.checked } : item) })} className="size-5 accent-[var(--accent)]" />
                </label>
              ))}
            </fieldset>
            <fieldset className="grid gap-3 md:grid-cols-2">
              <legend className="mb-1 text-xs font-medium text-[var(--text)]">SearXNG</legend>
              <label className="flex min-h-11 items-center gap-2 text-xs text-[var(--text-secondary)]"><input aria-label="启用 SearXNG（自建）" type="checkbox" checked={data.searxng.enabled} disabled={saving} onChange={(event) => setData({ ...data, searxng: { ...data.searxng, enabled: event.target.checked } })} className="size-5 accent-[var(--accent)]" />启用自建实例</label>
              <label className="flex flex-col gap-1 text-xs text-[var(--text-secondary)]">SearXNG 实例地址<input value={data.searxng.base_url} disabled={saving} onChange={(event) => setData({ ...data, searxng: { ...data.searxng, base_url: event.target.value } })} className="min-h-11 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 text-[var(--text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]" /></label>
            </fieldset>
            <fieldset className="grid gap-3 md:grid-cols-3">
              <legend className="mb-1 text-xs font-medium text-[var(--text)]">聚合与抓取策略</legend>
              {numericFields.map((field) => (
                <label key={`${field.section}.${field.key}`} className="flex flex-col gap-1 text-xs text-[var(--text-secondary)]">{field.label}<input aria-label={field.label} type="number" min={field.min} step={field.step ?? 1} value={Number.isNaN((data[field.section] as unknown as Record<string, number>)[field.key]) ? '' : (data[field.section] as unknown as Record<string, number>)[field.key]} disabled={saving} onChange={(event) => updateNumber(field.section, field.key, event.target.valueAsNumber)} className="min-h-11 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 text-[var(--text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]" /></label>
              ))}
            </fieldset>
            <div className="flex items-center justify-between gap-3">
              <div aria-live="polite">{success && <p className="text-xs text-[var(--success)]">{success}</p>}{error && <p role="alert" className="flex items-center gap-1.5 text-xs text-[var(--danger)]"><AlertTriangle className="size-4" />{error}</p>}</div>
              <Button loading={saving} disabled={saving} icon={<Save />} onClick={() => void save()}>保存</Button>
            </div>
          </>
        )}
        {!data && error && <p role="alert" className="flex items-center gap-1.5 text-xs text-[var(--danger)]"><AlertTriangle className="size-4" />{error}</p>}
      </div>
    </ShimmerCard>
  )
}
