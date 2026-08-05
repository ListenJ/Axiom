import { useEffect, useState, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { Activity, Cpu, Globe, Coins, Database } from 'lucide-react'
import { endpoints } from '@/lib/api'

interface SystemStats {
  activeTasks: number
  agents: number
  completed: number
  tokensUsed: number
}

interface TokenDetails {
  cacheStats: { hitRate: number }
}

// 轮询收敛（2026-08-04）：状态条为低决策价值信息，从 1s/5s 放宽到 10s/60s，
// 且页面隐藏时暂停轮询（visibilitychange），避免后台空转与无效请求
const STATS_POLL = 10_000
const TOKEN_POLL = 60_000

export default function StatsBar() {
  const navigate = useNavigate()
  const [stats, setStats] = useState<SystemStats | null>(null)
  const [cacheRate, setCacheRate] = useState<number | null>(null)

  const fetchStats = useCallback(async () => {
    try {
      const data = await endpoints.stats()
      setStats(data as SystemStats)
    } catch (e) {
      if (e instanceof Error) console.warn('[StatsBar] fetch failed:', e.message)
    }
  }, [])

  const fetchTokenDetails = useCallback(async () => {
    try {
      const data = await endpoints.tokenDetails(1) as TokenDetails
      setCacheRate(data.cacheStats.hitRate)
    } catch (e) {
      if (e instanceof Error) console.warn('[StatsBar] fetch failed:', e.message)
    }
  }, [])

  useEffect(() => {
    fetchStats()
    fetchTokenDetails()
    const si = setInterval(fetchStats, STATS_POLL)
    const ti = setInterval(fetchTokenDetails, TOKEN_POLL)
    // 页面隐藏时暂停轮询，回到前台立即刷新一次
    const onVisibility = () => {
      if (document.visibilityState === 'visible') {
        void fetchStats()
        void fetchTokenDetails()
      }
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      clearInterval(si)
      clearInterval(ti)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [fetchStats, fetchTokenDetails])

  return (
    <div className="shell-surface flex items-center justify-center gap-6 border-t border-[var(--shell-border)] px-4 py-2 text-2xs text-[var(--text-secondary)]">
      <div className="flex items-center gap-1.5">
        <Activity className="size-3 text-[var(--success)]" />
        <span>任务 {stats?.activeTasks ?? '—'}</span>
      </div>
      <div className="flex items-center gap-1.5">
        <Cpu className="size-3 text-[var(--accent)]" />
        <span>智能体 {stats?.agents ?? '—'}</span>
      </div>
      <div className="flex items-center gap-1.5">
        <Globe className="size-3 text-[var(--info)]" />
        <span>已完成 {stats?.completed ?? '—'}</span>
      </div>
      <button
        onClick={() => navigate('/tokens')}
        className="flex items-center gap-1.5 transition-colors hover:text-[var(--text)]"
      >
        <Coins className="size-3 text-[var(--warning)]" />
        <span>Tokens {(stats?.tokensUsed ?? 0).toLocaleString()}</span>
      </button>
      {cacheRate !== null && (
        <div className="flex items-center gap-1.5">
          <Database className="size-3 text-[var(--info)]" />
          <span>缓存 {cacheRate}%</span>
        </div>
      )}
    </div>
  )
}
