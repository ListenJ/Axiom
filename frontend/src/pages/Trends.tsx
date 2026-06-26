import { useEffect, useState } from 'react'
import { TrendingUp, BarChart3, Search, MessageSquare, Cpu, CheckCircle2 } from 'lucide-react'
import ShimmerCard from '@/components/ui/ShimmerCard'
import { endpoints } from '@/lib/api'

interface TrendsData {
  days: number
  searchTrend: Array<{ day: string; count: number }>
  chatTrend: Array<{ day: string; count: number }>
  modelTrend: Array<{ model_name: string; count: number; avg_latency: number }>
  taskTrend: Array<{ status: string; count: number }>
  generatedAt: string
}

export default function Trends() {
  const [data, setData] = useState<TrendsData | null>(null)
  const [days, setDays] = useState(7)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setLoading(true)
    setError(null)
    endpoints.trends
      .summary(days)
      .then((d) => setData(d as TrendsData))
      .catch((e) => setError(String((e as Error)?.message ?? e)))
      .finally(() => setLoading(false))
  }, [days])

  const maxSearch = Math.max(1, ...(data?.searchTrend?.map((d) => d.count) ?? [0]))
  const maxChat = Math.max(1, ...(data?.chatTrend?.map((d) => d.count) ?? [0]))
  const totalSearches = data?.searchTrend?.reduce((s, d) => s + d.count, 0) ?? 0
  const totalChats = data?.chatTrend?.reduce((s, d) => s + d.count, 0) ?? 0

  return (
    <div className="fade-in stagger space-y-4">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="fade-in stagger space-y-1">
          <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight">
            <TrendingUp className="size-6 text-accent" />
            瓒嬪娍鍒嗘瀽
          </h1>
          <p className="text-text-secondary">鎼滅储銆佸璇濄€佹ā鍨嬭皟鐢ㄣ€佷换鍔＄殑瓒嬪娍缁熻銆?/p>
        </div>
        <div className="flex gap-1 rounded-lg border border-border p-1">
          {[1, 7, 30, 90].map((d) => (
            <button
              key={d}
              type="button"
              onClick={() => setDays(d)}
              className={`rounded-md px-3 py-1 text-sm transition-colors ${
                days === d ? 'bg-accent text-white' : 'text-text-secondary hover:bg-bg-secondary'
              }`}
            >
              {d} 澶?
            </button>
          ))}
        </div>
      </header>

      {error && (
        <p role="alert" className="text-sm text-warning">
          瓒嬪娍鏁版嵁鏆備笉鍙敤锛歿error}
        </p>
      )}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4" aria-busy={loading}>
        <ShimmerCard glow>
          <p className="flex items-center gap-1.5 text-sm text-text-muted">
            <Search className="size-3.5" />
            鎬绘悳绱㈤噺
          </p>
          <p className="mt-1 text-3xl font-bold">{loading ? '鈥? : totalSearches}</p>
        </ShimmerCard>
        <ShimmerCard>
          <p className="flex items-center gap-1.5 text-sm text-text-muted">
            <MessageSquare className="size-3.5" />
            鎬诲璇濇暟
          </p>
          <p className="mt-1 text-3xl font-bold">{loading ? '鈥? : totalChats}</p>
        </ShimmerCard>
        <ShimmerCard>
          <p className="flex items-center gap-1.5 text-sm text-text-muted">
            <Cpu className="size-3.5" />
            娲昏穬妯″瀷
          </p>
          <p className="mt-1 text-3xl font-bold">{loading ? '鈥? : data?.modelTrend?.length ?? 0}</p>
        </ShimmerCard>
        <ShimmerCard>
          <p className="flex items-center gap-1.5 text-sm text-text-muted">
            <CheckCircle2 className="size-3.5" />
            浠诲姟鐘舵€?
          </p>
          <p className="mt-1 text-3xl font-bold">{loading ? '鈥? : data?.taskTrend?.length ?? 0}</p>
        </ShimmerCard>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <ShimmerCard>
          <h2 className="flex items-center gap-2 text-base font-semibold">
            <Search className="size-4 text-accent" />
            鎼滅储瓒嬪娍
          </h2>
          {loading ? (
            <div className="mt-4 h-40 animate-pulse rounded bg-bg-tertiary" aria-hidden="true" />
          ) : !data?.searchTrend?.length ? (
            <p className="mt-4 text-sm text-text-muted">鏆傛棤鎼滅储鏁版嵁</p>
          ) : (
            <div className="mt-4 flex h-40 items-end gap-1">
              {data.searchTrend.map((d, i) => (
                <div key={i} className="flex min-w-0 flex-1 flex-col items-center gap-1">
                  <div
                    className="w-full rounded-t bg-accent/70 transition-all hover:bg-accent"
                    style={{ height: `${(d.count / maxSearch) * 100}%`, minHeight: '4px' }}
                    title={`${d.day}: ${d.count}`}
                  />
                  <span className="text-2xs text-text-muted">{d.day.slice(5)}</span>
                </div>
              ))}
            </div>
          )}
        </ShimmerCard>

        <ShimmerCard>
          <h2 className="flex items-center gap-2 text-base font-semibold">
            <MessageSquare className="size-4 text-accent" />
            瀵硅瘽瓒嬪娍
          </h2>
          {loading ? (
            <div className="mt-4 h-40 animate-pulse rounded bg-bg-tertiary" aria-hidden="true" />
          ) : !data?.chatTrend?.length ? (
            <p className="mt-4 text-sm text-text-muted">鏆傛棤瀵硅瘽鏁版嵁</p>
          ) : (
            <div className="mt-4 flex h-40 items-end gap-1">
              {data.chatTrend.map((d, i) => (
                <div key={i} className="flex min-w-0 flex-1 flex-col items-center gap-1">
                  <div
                    className="w-full rounded-t bg-success/70 transition-all hover:bg-success"
                    style={{ height: `${(d.count / maxChat) * 100}%`, minHeight: '4px' }}
                    title={`${d.day}: ${d.count}`}
                  />
                  <span className="text-2xs text-text-muted">{d.day.slice(5)}</span>
                </div>
              ))}
            </div>
          )}
        </ShimmerCard>
      </div>

      <ShimmerCard>
        <h2 className="flex items-center gap-2 text-base font-semibold">
          <Cpu className="size-4 text-accent" />
          妯″瀷璋冪敤 Top {data?.modelTrend?.length ?? 0}
        </h2>
        {loading ? (
          <div className="mt-3 space-y-2" aria-hidden="true">
            {[0, 1, 2].map((i) => (
              <div key={i} className="h-8 animate-pulse rounded bg-bg-tertiary" />
            ))}
          </div>
        ) : !data?.modelTrend?.length ? (
          <p className="mt-3 text-sm text-text-muted">鏆傛棤妯″瀷璋冪敤</p>
        ) : (
          <div className="mt-3 space-y-2">
            {data.modelTrend.map((m, i) => (
              <div key={i} className="flex items-center justify-between rounded-lg border border-border p-2 text-sm">
                <span className="truncate font-medium" title={m.model_name}>{m.model_name}</span>
                <div className="flex shrink-0 items-center gap-4 text-xs text-text-muted">
                  <span>{m.count} 娆?/span>
                  <span>~{Math.round(m.avg_latency ?? 0)}ms</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </ShimmerCard>

      {data?.taskTrend && data.taskTrend.length > 0 && (
        <ShimmerCard>
          <h2 className="flex items-center gap-2 text-base font-semibold">
            <BarChart3 className="size-4 text-accent" />
            浠诲姟鐘舵€佸垎甯?
          </h2>
          <div className="mt-3 flex flex-wrap gap-3">
            {data.taskTrend.map((t, i) => (
              <div key={i} className="rounded-lg border border-border bg-bg-secondary px-3 py-2">
                <p className="text-xs text-text-muted">{t.status}</p>
                <p className="text-lg font-semibold">{t.count}</p>
              </div>
            ))}
          </div>
        </ShimmerCard>
      )}
    </div>
  )
}
