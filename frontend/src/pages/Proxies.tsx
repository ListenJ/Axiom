import { useEffect, useState } from 'react'
import {
  Globe,
  Shield,
  CheckCircle2,
  XCircle,
  Server,
  AlertTriangle,
} from 'lucide-react'
import {
  ShimmerCard,
  StatCard,
  PageHeader,
  InlineEmptyState,
  Skeleton,
} from '@/components/ui'
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
    <div className="space-y-6">
      <PageHeader
        icon={<Globe className="size-5" />}
        title="代理管理"
        description="系统代理状态 · 隐私保护配置。"
      />

      {error && (
        <p
          role="alert"
          className="flex items-center gap-2 rounded-lg border border-[var(--danger-soft)] bg-[var(--danger-soft)] px-3 py-2 text-sm text-[var(--danger)]"
        >
          <AlertTriangle className="size-4" />
          {error}
        </p>
      )}

      <section className="stagger grid grid-cols-1 gap-4 sm:grid-cols-3" aria-busy={loading}>
        <StatCard label="代理总数" value={proxies.length} icon={<Server className="size-4" />} accent="default" loading={loading} />
        <StatCard label="活跃代理" value={proxies.filter((p) => p.active).length} icon={<CheckCircle2 className="size-4" />} accent="success" loading={loading} />
        <StatCard label="非活跃" value={proxies.filter((p) => !p.active).length} icon={<XCircle className="size-4" />} accent="warning" loading={loading} />
      </section>

      <ShimmerCard>
        <h2 className="mb-3 flex items-center gap-2 text-base font-semibold text-[var(--text)]">
          <Shield className="size-4 text-[var(--accent)]" />
          代理配置
        </h2>
        {loading ? (
          <div className="space-y-2">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} height="3rem" />
            ))}
          </div>
        ) : proxies.length === 0 ? (
          <InlineEmptyState
            icon={<Globe className="size-5" />}
            title="未配置代理"
            description={
              <>
                可通过 <code className="rounded bg-[var(--bg-tertiary)] px-1 font-mono">HTTP_PROXY</code> 和{' '}
                <code className="rounded bg-[var(--bg-tertiary)] px-1 font-mono">HTTPS_PROXY</code> 环境变量配置
              </>
            }
          />
        ) : (
          <div className="space-y-2">
            {proxies.map((p, i) => (
              <div
                key={i}
                className="flex items-center justify-between rounded-xl border border-[var(--border)] p-3 transition-colors hover:bg-[var(--surface-hover)]"
              >
                <div className="flex items-center gap-3">
                  <div
                    className={`flex size-9 items-center justify-center rounded-lg ${
                      p.active ? 'bg-[var(--success-soft)]' : 'bg-[var(--bg-tertiary)]'
                    }`}
                  >
                    <Globe
                      className={`size-4 ${p.active ? 'text-[var(--success)]' : 'text-[var(--text-muted)]'}`}
                    />
                  </div>
                  <div>
                    <p className="font-mono text-sm font-medium text-[var(--text)]">
                      {p.host}
                      {p.port && <span className="text-[var(--text-muted)]">:{p.port}</span>}
                    </p>
                    <p className="text-2xs text-[var(--text-muted)]">
                      {p.protocol} · {p.country}
                    </p>
                  </div>
                </div>
                <span
                  className={`rounded-full px-2 py-0.5 text-xs ${
                    p.active
                      ? 'bg-[var(--success-soft)] text-[var(--success)]'
                      : 'bg-[var(--bg-tertiary)] text-[var(--text-muted)]'
                  }`}
                >
                  {p.active ? '活跃' : '禁用'}
                </span>
              </div>
            ))}
          </div>
        )}
      </ShimmerCard>

      <p className="text-2xs text-[var(--text-muted)]">
        代理仅用于出站爬取请求，不会影响本地 API 访问。
      </p>
    </div>
  )
}
