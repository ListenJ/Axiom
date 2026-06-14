import { useEffect, useState } from 'react'
import { Globe, Shield, CheckCircle2, XCircle, Server, AlertTriangle } from 'lucide-react'
import ShimmerCard from '@/components/ui/ShimmerCard'
import { endpoints } from '@/lib/api'

interface Proxy {
  host: string
  port: string
  protocol: string
  country: string
  active: boolean
}

export default function Proxies() {
  const [proxies, setProxies] = useState<Proxy[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    endpoints.proxies
      .list()
      .then((d) => {
        // Backend returns raw array (or possibly wrapped) — handle both
        if (Array.isArray(d)) {
          setProxies(d as Proxy[])
        } else if (d && typeof d === 'object' && Array.isArray((d as { proxies?: unknown }).proxies)) {
          setProxies((d as { proxies: Proxy[] }).proxies)
        } else {
          setProxies([])
        }
      })
      .catch((e) => setError(String((e as Error)?.message ?? e)))
      .finally(() => setLoading(false))
  }, [])

  return (
    <div className="space-y-4">
      <header className="space-y-1">
        <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight">
          <Globe className="size-6 text-accent" />
          代理管理
        </h1>
        <p className="text-text-secondary">系统代理状态 · 隐私保护配置。</p>
      </header>

      {error && (
        <p role="alert" className="flex items-center gap-2 text-sm text-danger">
          <AlertTriangle className="size-4" />
          {error}
        </p>
      )}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3" aria-busy={loading}>
        <ShimmerCard glow>
          <p className="flex items-center gap-1.5 text-sm text-text-muted">
            <Server className="size-3.5" />
            代理总数
          </p>
          <p className="mt-1 text-3xl font-bold">
            {loading ? '—' : proxies.length}
          </p>
        </ShimmerCard>
        <ShimmerCard>
          <p className="flex items-center gap-1.5 text-sm text-text-muted">
            <CheckCircle2 className="size-3.5" />
            活跃代理
          </p>
          <p className="mt-1 text-3xl font-bold text-success">
            {loading ? '—' : proxies.filter((p) => p.active).length}
          </p>
        </ShimmerCard>
        <ShimmerCard>
          <p className="flex items-center gap-1.5 text-sm text-text-muted">
            <XCircle className="size-3.5" />
            非活跃
          </p>
          <p className="mt-1 text-3xl font-bold text-text-muted">
            {loading ? '—' : proxies.filter((p) => !p.active).length}
          </p>
        </ShimmerCard>
      </div>

      <ShimmerCard>
        <h2 className="flex items-center gap-2 text-base font-semibold">
          <Shield className="size-4 text-accent" />
          代理配置
        </h2>
        {loading ? (
          <div className="mt-3 space-y-2" aria-hidden="true">
            {[0, 1, 2].map((i) => (
              <div key={i} className="h-12 animate-pulse rounded bg-bg-tertiary" />
            ))}
          </div>
        ) : proxies.length === 0 ? (
          <div className="mt-4 rounded-xl border border-dashed border-border bg-bg-secondary/30 p-6 text-center">
            <Globe className="mx-auto mb-3 size-10 text-text-muted opacity-50" />
            <p className="text-sm text-text-secondary">未配置代理</p>
            <p className="mt-1 text-xs text-text-muted">
              可通过 <code className="rounded bg-bg-tertiary px-1">HTTP_PROXY</code> 和{' '}
              <code className="rounded bg-bg-tertiary px-1">HTTPS_PROXY</code>{' '}
              环境变量配置
            </p>
          </div>
        ) : (
          <div className="mt-3 space-y-2">
            {proxies.map((p, i) => (
              <div
                key={i}
                className="flex items-center justify-between rounded-xl border border-border p-3"
              >
                <div className="flex items-center gap-3">
                  <div
                    className={`flex size-9 items-center justify-center rounded-lg ${
                      p.active ? 'bg-success/10' : 'bg-bg-tertiary'
                    }`}
                  >
                    <Globe
                      className={`size-4 ${p.active ? 'text-success' : 'text-text-muted'}`}
                    />
                  </div>
                  <div>
                    <p className="font-mono text-sm font-medium">
                      {p.host}
                      {p.port && <span className="text-text-muted">:{p.port}</span>}
                    </p>
                    <p className="text-2xs text-text-muted">
                      {p.protocol} · {p.country}
                    </p>
                  </div>
                </div>
                <span
                  className={`rounded-full px-2 py-0.5 text-xs ${
                    p.active
                      ? 'bg-success/15 text-success'
                      : 'bg-bg-tertiary text-text-muted'
                  }`}
                >
                  {p.active ? '活跃' : '禁用'}
                </span>
              </div>
            ))}
          </div>
        )}
      </ShimmerCard>

      <p className="text-2xs text-text-muted">
        代理仅用于出站爬取请求，不会影响本地 API 访问。
      </p>
    </div>
  )
}
