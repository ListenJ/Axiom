import { useCallback, useEffect, useRef, useState } from 'react'
import { AlertTriangle, Compass, Coins, Heart } from 'lucide-react'
import { ShimmerCard, PageHeader, Skeleton } from '@/components/ui'
import { endpoints } from '@/lib/api'
import { formatNumber } from '@/lib/format'

interface RouterStatus {
  status?: string
  models?: number
  healthy?: number
  tokens?: { used: number; total: number }
}

/** 三个数据源：失败时必须能分别标记是哪一个不可用。 */
type MetricKey = 'status' | 'health' | 'tokenStats'

const METRIC_KEYS: MetricKey[] = ['status', 'health', 'tokenStats']

const METRIC_LABELS: Record<MetricKey, string> = {
  status: '路由状态',
  health: '健康模型',
  tokenStats: 'Token 使用',
}

type FailureMap = Partial<Record<MetricKey, string>>

/** 兼容后端 { success, data } 响应包裹（unwrap 取 data）。 */
function unwrapData(d: unknown): unknown {
  const obj = d as { data?: unknown }
  return obj && typeof obj === 'object' && 'data' in obj ? obj.data : d
}

/** 把失败原因转成可读文案；区分超时与调用方取消（api 层 HttpError.code）。 */
function describeError(reason: unknown): string {
  const err = reason as { code?: string; message?: string } | null | undefined
  if (err?.code === 'timeout') return '请求超时'
  if (err?.code === 'canceled') return '请求已取消'
  const message = typeof err?.message === 'string' ? err.message : ''
  if (message) return message
  if (typeof reason === 'string' && reason) return reason
  return '未知错误'
}

function RetryButton({ onRetry, disabled }: { onRetry: () => void; disabled: boolean }) {
  return (
    <button
      type="button"
      onClick={onRetry}
      disabled={disabled}
      className="min-h-11 shrink-0 rounded-lg px-3 text-sm font-medium text-[var(--accent)] underline underline-offset-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] disabled:cursor-not-allowed disabled:opacity-60"
    >
      重试
    </button>
  )
}

/** 模型路由面板（设置页「调试与检查」嵌入用，不含页头） */
export function RouterPanel() {
  const [data, setData] = useState<RouterStatus | null>(null)
  const [failures, setFailures] = useState<FailureMap | null>(null)
  const [loading, setLoading] = useState(true)
  const requestId = useRef(0)

  const load = useCallback(async () => {
    const current = ++requestId.current
    setLoading(true)
    // 保留每个 allSettled 结果的 rejected 信息：不再在分支内 .catch(() => null) 把失败洗成成功值。
    const results = await Promise.allSettled([
      endpoints.router.status(),
      endpoints.router.health(),
      endpoints.router.tokenStats(),
    ])
    // 过期响应（重试之后才返回的旧请求）不得覆盖新状态。
    if (current !== requestId.current) return
    const [s, h, t] = results
    const nextFailures: FailureMap = {}
    if (s.status === 'rejected') nextFailures.status = describeError(s.reason)
    if (h.status === 'rejected') nextFailures.health = describeError(h.reason)
    if (t.status === 'rejected') nextFailures.tokenStats = describeError(t.reason)
    const sVal = s.status === 'fulfilled' ? (unwrapData(s.value) as RouterStatus | undefined) : undefined
    const hVal = h.status === 'fulfilled' ? (unwrapData(h.value) as RouterStatus | undefined) : undefined
    const tVal = t.status === 'fulfilled' ? (unwrapData(t.value) as RouterStatus | undefined) : undefined
    const anySuccess = s.status === 'fulfilled' || h.status === 'fulfilled' || t.status === 'fulfilled'
    // 全失败时不再伪造 { status: '未知' }：保留 null，由错误态接管渲染。
    setData(
      anySuccess
        ? {
            status: sVal?.status ?? hVal?.status,
            models: sVal?.models ?? hVal?.models,
            healthy: hVal?.healthy,
            tokens: tVal?.tokens,
          }
        : null,
    )
    setFailures(nextFailures)
    setLoading(false)
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const failedKeys = failures ? METRIC_KEYS.filter((key) => failures[key] !== undefined) : []
  const initialLoading = loading && failures === null
  const allFailed = failures !== null && failedKeys.length === METRIC_KEYS.length
  const partial = failures !== null && failedKeys.length > 0 && failedKeys.length < METRIC_KEYS.length
  const reasonsText = failedKeys
    .map((key) => `${METRIC_LABELS[key]}：${failures?.[key] ?? '未知错误'}`)
    .join('；')
  const healthFailed = failures?.health !== undefined
  const tokensFailed = failures?.tokenStats !== undefined
  const statusFailed = failures?.status !== undefined && !data?.status

  return (
    <div className="space-y-4">
      {allFailed && (
        <div className="flex flex-wrap items-start gap-3 rounded-xl border border-[var(--danger)]/40 bg-[var(--danger-soft)] px-4 py-3">
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-[var(--danger)]" />
          <div className="min-w-0 flex-1 space-y-1">
            <p role="alert" className="text-sm font-medium text-[var(--danger)]">
              模型路由服务暂不可用：{reasonsText}
            </p>
            <p className="text-xs text-[var(--text-muted)]">
              健康模型、Token 使用与路由状态均读取失败，请确认后端服务后重试。
            </p>
          </div>
          <RetryButton onRetry={() => void load()} disabled={loading} />
        </div>
      )}

      {partial && (
        <div className="flex flex-wrap items-center gap-3 rounded-lg border border-[var(--warning-soft)] bg-[var(--warning-soft)] px-3 py-2">
          <AlertTriangle className="size-4 shrink-0 text-[var(--warning)]" />
          <p role="alert" className="min-w-0 flex-1 text-sm text-[var(--warning)]">
            部分指标不可用：{reasonsText}
          </p>
          <RetryButton onRetry={() => void load()} disabled={loading} />
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3" aria-busy={loading}>
        <ShimmerCard glow>
          <div className="flex items-center gap-2 text-[var(--text-muted)]">
            <Heart className="size-4" />
            <span className="text-sm">健康模型</span>
          </div>
          {initialLoading ? (
            <>
              <Skeleton data-testid="router-skeleton" className="mt-3 h-8 w-16" />
              <Skeleton data-testid="router-skeleton" className="mt-2 h-3 w-24" />
            </>
          ) : (
            <>
              <p className={`mt-2 text-3xl font-bold ${healthFailed ? 'text-[var(--danger)]' : 'text-[var(--text)]'}`}>
                {data?.healthy ?? '—'}
              </p>
              <p className={`mt-1 text-xs ${healthFailed ? 'text-[var(--danger)]' : 'text-[var(--text-muted)]'}`}>
                {healthFailed ? '健康数据不可用' : `共 ${data?.models ?? '—'} 个模型`}
              </p>
            </>
          )}
        </ShimmerCard>

        <ShimmerCard>
          <div className="flex items-center gap-2 text-[var(--text-muted)]">
            <Coins className="size-4" />
            <span className="text-sm">Token 使用</span>
          </div>
          {initialLoading ? (
            <>
              <Skeleton data-testid="router-skeleton" className="mt-3 h-8 w-24" />
              <Skeleton data-testid="router-skeleton" className="mt-2 h-3 w-20" />
            </>
          ) : (
            <>
              <p className={`mt-2 text-3xl font-bold ${tokensFailed ? 'text-[var(--danger)]' : 'text-[var(--text)]'}`}>
                {data?.tokens ? formatNumber(data.tokens.used) : '—'}
              </p>
              <p className={`mt-1 text-xs ${tokensFailed ? 'text-[var(--danger)]' : 'text-[var(--text-muted)]'}`}>
                {tokensFailed ? 'Token 数据不可用' : `/ ${data?.tokens ? formatNumber(data.tokens.total) : '—'}`}
              </p>
            </>
          )}
        </ShimmerCard>

        <ShimmerCard>
          <div className="flex items-center gap-2 text-[var(--text-muted)]">
            <Compass className="size-4" />
            <span className="text-sm">路由状态</span>
          </div>
          {initialLoading ? (
            <Skeleton data-testid="router-skeleton" className="mt-3 h-8 w-20" />
          ) : (
            <>
              {/* 只有真实 status 值才用 success 色；缺失时用中性色 —，不得伪装成成功。 */}
              <p className={`mt-2 text-3xl font-bold capitalize ${data?.status ? 'text-[var(--success)]' : 'text-[var(--text-muted)]'}`}>
                {data?.status ?? '—'}
              </p>
              {statusFailed && <p className="mt-1 text-xs text-[var(--danger)]">路由状态不可用</p>}
            </>
          )}
        </ShimmerCard>
      </div>
    </div>
  )
}

export default function Router() {
  return (
    <div className="space-y-6">
      <PageHeader
        icon={<Compass className="size-5" />}
        title="模型路由"
        description="Advisor + Health + Token 使用统计。"
      />
      <RouterPanel />
    </div>
  )
}
