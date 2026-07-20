import { useEffect, useState } from 'react'
import { Code2, RefreshCw, FileCode } from 'lucide-react'
import { ShimmerCard, StatCard, Button, PageHeader, InlineEmptyState, Skeleton } from '@/components/ui'
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
        endpoints.codegraph.status(),
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
    <div className="space-y-6 fade-in">
      <PageHeader
        icon={<Code2 className="size-5" />}
        title="代码图谱"
        description="CodeGraph 索引状态与文件列表。"
        actions={
          <Button
            onClick={refresh}
            loading={loading}
            icon={<RefreshCw className={`size-3.5 ${loading ? 'animate-spin' : ''}`} />}
          >
            刷新
          </Button>
        }
      />

      {error && (
        <ShimmerCard variant="muted">
          <p role="alert" className="text-sm text-[var(--danger)]">
            加载失败：{error}
          </p>
        </ShimmerCard>
      )}

      <section className="stagger grid grid-cols-1 gap-4 sm:grid-cols-3" aria-busy={loading && !status}>
        <StatCard label="已索引文件" value={status?.indexed ?? '—'} icon={<FileCode className="size-4" />} accent="default" loading={loading && !status} />
        <StatCard label="状态" value={status?.status ?? '未知'} icon={<Code2 className="size-4" />} accent="success" loading={loading && !status} />
        <StatCard label="最近构建" value={status?.last_build ?? '—'} icon={<RefreshCw className="size-4" />} accent="info" loading={loading && !status} />
      </section>

      <ShimmerCard>
        <h2 className="mb-3 text-base font-semibold text-[var(--text)]">文件列表</h2>
        {loading && files.length === 0 ? (
          <div className="space-y-2">
            {[0, 1, 2, 3, 4].map((i) => (
              <Skeleton key={i} height="1rem" />
            ))}
          </div>
        ) : files.length === 0 ? (
          <InlineEmptyState
            icon={<FileCode className="size-5" />}
            title="暂无文件"
            description="请先运行 CodeGraph 索引。"
          />
        ) : (
          <ul className="max-h-80 space-y-1 overflow-y-auto font-mono text-xs text-[var(--text-secondary)]">
            {files.map((f, i) => (
              <li key={i} className="truncate rounded px-2 py-1 transition-colors hover:bg-[var(--surface-hover)]">
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
