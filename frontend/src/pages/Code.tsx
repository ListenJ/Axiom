import { useEffect, useState } from 'react'
import { Code2, RefreshCw } from 'lucide-react'
import ShimmerCard from '@/components/ui/ShimmerCard'
import { endpoints } from '@/lib/api'

interface CodegraphStatus {
  indexed?: number
  status?: string
  last_build?: string
}

export default function Code() {
  const [status, setStatus] = useState<CodegraphStatus | null>(null)
  const [files, setFiles] = useState<string[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = async () => {
    setLoading(true)
    setError(null)
    try {
      const [s, f] = await Promise.all([
        endpoints.codegraph.status().catch((e) => {
          throw e
        }),
        endpoints.codegraph.fileIndex().catch(() => []),
      ])
      setStatus((s as CodegraphStatus) ?? null)
      setFiles(toFileList(f))
    } catch (e) {
      setError(String((e as Error)?.message ?? e))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    refresh()
  }, [])

  return (
    <div className="space-y-4">
      <header className="flex items-center justify-between gap-3">
        <div className="space-y-1">
          <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight">
            <Code2 className="size-6 text-accent" />
            代码图谱
          </h1>
          <p className="text-text-secondary">CodeGraph 索引状态与文件列表。</p>
        </div>
        <button
          type="button"
          onClick={refresh}
          disabled={loading}
          aria-label="刷新 CodeGraph 数据"
          className="focus-ring flex h-10 items-center gap-2 rounded-xl bg-accent px-3 text-sm font-medium text-white transition-colors hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
        >
          <RefreshCw className={`size-4 transition-transform ${loading ? 'animate-spin' : ''}`} />
          刷新
        </button>
      </header>

      {error && (
        <ShimmerCard>
          <p role="alert" className="text-sm text-danger">
            加载失败：{error}
          </p>
        </ShimmerCard>
      )}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3" aria-busy={loading}>
        <ShimmerCard>
          <p className="text-sm text-text-muted">已索引文件</p>
          {loading && !status ? (
            <div className="mt-2 h-7 w-20 animate-pulse rounded bg-bg-tertiary" aria-hidden="true" />
          ) : (
            <p className="mt-1 text-2xl font-bold">{status?.indexed ?? '—'}</p>
          )}
        </ShimmerCard>
        <ShimmerCard>
          <p className="text-sm text-text-muted">状态</p>
          {loading && !status ? (
            <div className="mt-2 h-5 w-16 animate-pulse rounded bg-bg-tertiary" aria-hidden="true" />
          ) : (
            <p className="mt-1 text-base font-medium">{status?.status ?? '未知'}</p>
          )}
        </ShimmerCard>
        <ShimmerCard>
          <p className="text-sm text-text-muted">最近构建</p>
          {loading && !status ? (
            <div className="mt-2 h-4 w-32 animate-pulse rounded bg-bg-tertiary" aria-hidden="true" />
          ) : (
            <p className="mt-1 text-sm font-mono">{status?.last_build ?? '—'}</p>
          )}
        </ShimmerCard>
      </div>

      <ShimmerCard>
        <h2 className="text-base font-semibold">文件列表</h2>
        {loading && files.length === 0 ? (
          <div className="mt-3 space-y-2" aria-hidden="true">
            {[0, 1, 2, 3, 4].map((i) => (
              <div key={i} className="h-4 w-full animate-pulse rounded bg-bg-tertiary" />
            ))}
          </div>
        ) : files.length === 0 ? (
          <p className="mt-3 text-sm text-text-muted">暂无文件。请先运行 CodeGraph 索引。</p>
        ) : (
          <ul className="mt-3 max-h-80 space-y-1 overflow-y-auto font-mono text-xs">
            {files.map((f, i) => (
              <li key={i} className="truncate text-text-secondary">
                {f}
              </li>
            ))}
          </ul>
        )}
      </ShimmerCard>
    </div>
  )
}

function toFileList(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map(String)
  if (raw && typeof raw === 'object') {
    const o = raw as Record<string, unknown>
    if (Array.isArray(o.files)) return o.files.map(String)
    if (Array.isArray(o.index)) return o.index.map(String)
  }
  return []
}
