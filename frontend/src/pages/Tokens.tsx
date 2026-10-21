import { useEffect, useState, useCallback } from 'react'
import { ArrowLeft, Coins, Activity, ArrowUp, ArrowDown, Clock, HardDrive, Database, BarChart3, AlertTriangle } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import Button from '@/components/ui/Button'
import PageHeader from '@/components/ui/PageHeader'
import StatCard from '@/components/ui/StatCard'
import BarChart from '@/components/ui/BarChart'
import Collapsible from '@/components/ui/Collapsible'
import InlineEmptyState from '@/components/ui/InlineEmptyState'
import { formatClockTime, formatNumber } from '@/lib/format'
import { endpoints } from '@/lib/api'

interface TokenDetail {
  perModel: Array<{ model: string; calls: number; promptTokens: number; completionTokens: number; avgLatency: number }>
  hourlyTrend: Array<{ date: string; totalCalls: number; totalTokens: number }>
  overall: { totalTokens: number; totalCalls: number; promptTokens: number; completionTokens: number; avgLatency: number }
  recentCalls: Array<{ timestamp: number; model: string; promptTokens: number; completionTokens: number; latencyMs: number; success: boolean }>
  cacheStats: { totalCalls: number; cacheHits: number; hitRate: number }
}

/** Token 用量面板（设置页「调试与检查」嵌入用，不含页头） */
export function TokensPanel() {
  const [data, setData] = useState<TokenDetail | null>(null)
  const [error, setError] = useState<string | null>(null)

  const fetchData = useCallback(async () => {
    try {
      // 走 api 封装（endpoints.tokenDetails 带鉴权拦截器/超时/错误映射），不再裸 fetch。
      // 裸 fetch 不带 Authorization ⇒ 后端恒 401；且未校验形状就 setData 会把错误 JSON
      // 当数据渲染 ⇒ `data.overall` 为 undefined 抛 TypeError（2026-10-22 E2E 发现）。
      const json = await endpoints.tokenDetails(7)
      // 形状校验：仅当 overall/cacheStats 存在且 perModel/recentCalls 为数组才 setData，
      // 避免渲染期对非数组 .map 崩溃。
      if (
        json &&
        typeof json === 'object' &&
        'overall' in json &&
        'cacheStats' in json &&
        Array.isArray((json as TokenDetail).perModel) &&
        Array.isArray((json as TokenDetail).recentCalls)
      ) {
        setData(json as TokenDetail)
        setError(null) // 下一次成功自动清错
      } else {
        // 形状异常：保留上一轮成功数据，提示格式异常
        setError('Token 数据格式异常（缺少 overall/cacheStats 或 perModel/recentCalls 数组）')
      }
    } catch (reason) {
      // 保留上一轮成功数据（不清空）；错误可见，下一轮轮询/重试再取
      setError(reason instanceof Error ? reason.message : '读取 Token 数据失败')
    }
  }, [])

  useEffect(() => {
    fetchData()
    const interval = setInterval(fetchData, 10000)
    return () => clearInterval(interval)
  }, [fetchData])

  const modelChartData = (data?.perModel ?? []).map(m => ({
    label: m.model.length > 15 ? m.model.slice(0, 12) + '…' : m.model,
    value: m.promptTokens + m.completionTokens,
  }))

  return (
    <div className="flex flex-col gap-4">
      {error && (
        <div className="flex flex-wrap items-center gap-3 rounded-xl border border-[var(--danger)]/40 bg-[var(--danger-soft,var(--surface))] px-4 py-3">
          <p role="alert" className="flex items-center gap-1.5 text-xs text-[var(--danger)]">
            <AlertTriangle className="size-4" />{error}
          </p>
          <button type="button" className="text-xs text-[var(--accent)] underline" onClick={() => void fetchData()}>
            重试
          </button>
        </div>
      )}

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <StatCard label="总 Token" value={data ? formatNumber(data.overall.totalTokens) : '—'} icon={<Coins className="size-5" />} accent="info" />
        <StatCard label="总调用" value={data ? formatNumber(data.overall.totalCalls) : '—'} icon={<Activity className="size-5" />} accent="success" />
        <StatCard label="输入 Token" value={data ? formatNumber(data.overall.promptTokens) : '—'} icon={<ArrowUp className="size-5" />} accent="warning" />
        <StatCard label="输出 Token" value={data ? formatNumber(data.overall.completionTokens) : '—'} icon={<ArrowDown className="size-5" />} accent="danger" />
      </div>

      <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
        <StatCard label="平均延迟" value={data ? `${data.overall.avgLatency}ms` : '—'} icon={<Clock className="size-5" />} accent="default" />
        <StatCard label="缓存命中率" value={data ? `${data.cacheStats.hitRate}%` : '—'} icon={<HardDrive className="size-5" />} accent="success" />
        <StatCard label="缓存条目" value={data ? formatNumber(data.cacheStats.cacheHits) : '—'} icon={<Database className="size-5" />} accent="info" />
      </div>

      <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-secondary)] p-4">
        <h3 className="mb-3 text-sm font-medium text-[var(--text)]">Token 消耗趋势 (7天)</h3>
        {modelChartData.length > 0 ? (
          <BarChart data={modelChartData} showLabels />
        ) : (
          <InlineEmptyState
            icon={<BarChart3 className="size-6" />}
            title="暂无 Token 消耗数据"
            description="完成一次模型调用后，这里将展示 7 天消耗趋势。"
          />
        )}
      </div>

      <Collapsible
        title="按模型明细"
        description="各模型调用次数与 Token 消耗统计"
        icon={<Database className="size-4" />}
        className="rounded-xl border border-[var(--border)] bg-[var(--bg-secondary)]"
      >
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-[var(--border)] text-left text-[var(--text-muted)]">
                <th className="pb-2 font-medium">模型</th>
                <th className="pb-2 font-medium text-right">调用次数</th>
                <th className="pb-2 font-medium text-right">输入 Token</th>
                <th className="pb-2 font-medium text-right">输出 Token</th>
                <th className="pb-2 font-medium text-right">平均延迟</th>
              </tr>
            </thead>
            <tbody>
              {(data?.perModel ?? []).map((m, i) => (
                <tr key={i} className="border-b border-[var(--border)] last:border-0">
                  <td className="py-2 text-[var(--text)]">{m.model}</td>
                  <td className="py-2 text-right text-[var(--text-muted)]">{formatNumber(m.calls)}</td>
                  <td className="py-2 text-right text-[var(--text-muted)]">{formatNumber(m.promptTokens)}</td>
                  <td className="py-2 text-right text-[var(--text-muted)]">{formatNumber(m.completionTokens)}</td>
                  <td className="py-2 text-right text-[var(--text-muted)]">{m.avgLatency}ms</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Collapsible>

      <Collapsible
        title="最近调用记录"
        description="近 7 天调用记录与状态"
        icon={<Clock className="size-4" />}
        className="rounded-xl border border-[var(--border)] bg-[var(--bg-secondary)]"
      >
        <div className="max-h-64 overflow-y-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-[var(--border)] text-left text-[var(--text-muted)]">
                <th className="pb-2 font-medium">时间</th>
                <th className="pb-2 font-medium">模型</th>
                <th className="pb-2 font-medium text-right">输入</th>
                <th className="pb-2 font-medium text-right">输出</th>
                <th className="pb-2 font-medium text-right">延迟</th>
                <th className="pb-2 font-medium text-center">状态</th>
              </tr>
            </thead>
            <tbody>
              {(data?.recentCalls ?? []).map((c, i) => (
                <tr key={i} className="border-b border-[var(--border)] last:border-0">
                  <td className="py-1.5 text-[var(--text-muted)]">{formatClockTime(c.timestamp)}</td>
                  <td className="py-1.5 text-[var(--text)]">{c.model.length > 20 ? c.model.slice(0, 17) + '…' : c.model}</td>
                  <td className="py-1.5 text-right text-[var(--text-muted)]">{formatNumber(c.promptTokens)}</td>
                  <td className="py-1.5 text-right text-[var(--text-muted)]">{formatNumber(c.completionTokens)}</td>
                  <td className="py-1.5 text-right text-[var(--text-muted)]">{c.latencyMs}ms</td>
                  <td className="py-1.5 text-center">
                    <span className={c.success ? 'text-[var(--success)]' : 'text-[var(--danger)]'}>
                      {c.success ? '✓' : '✗'}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Collapsible>
    </div>
  )
}

export default function Tokens() {
  const navigate = useNavigate()
  return (
    <div className="flex flex-col gap-6 p-6">
      <div className="flex items-center gap-4">
        <Button variant="ghost" size="sm" onClick={() => navigate(-1)} icon={<ArrowLeft className="size-4" />}>
          返回
        </Button>
        <PageHeader icon={<Coins className="size-5" />} title="Token 消耗分析" description="实时监控模型调用、Token 消耗和缓存命中率" />
      </div>
      <TokensPanel />
    </div>
  )
}
