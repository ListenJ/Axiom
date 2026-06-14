import { useEffect, useState } from 'react'
import { BookCheck, Check, X, RefreshCw, Clock, Tag, FileText } from 'lucide-react'
import ShimmerCard from '@/components/ui/ShimmerCard'
import { useApp } from '@/state/useApp'
import { endpoints } from '@/lib/api'

interface PendingNote {
  file: string
  title: string
  source: string
  reason?: string
  created: string
  updated?: string
}

export default function Knowledge() {
  const [notes, setNotes] = useState<PendingNote[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [processing, setProcessing] = useState<string | null>(null)
  const toast = useApp((s) => s.toast)

  const load = () => {
    setLoading(true)
    setError(null)
    endpoints.knowledge
      .pendingReview()
      .then((d) => {
        const data = d as { notes?: PendingNote[] }
        setNotes(data.notes ?? [])
      })
      .catch((e) => setError(String((e as Error)?.message ?? e)))
      .finally(() => setLoading(false))
  }

  useEffect(load, [])

  const act = async (file: string, action: 'approve' | 'reject') => {
    setProcessing(file)
    try {
      await endpoints.knowledge.reviewAction({ file, action })
      toast(action === 'approve' ? '已批准' : '已驳回', 'success')
      setNotes((prev) => prev.filter((n) => n.file !== file))
    } catch (e) {
      toast('操作失败：' + ((e as Error)?.message ?? String(e)), 'error')
    } finally {
      setProcessing(null)
    }
  }

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="space-y-1">
          <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight">
            <BookCheck className="size-6 text-accent" />
            知识审核
          </h1>
          <p className="text-text-secondary">审批或驳回待审核的原子笔记。</p>
        </div>
        <button
          type="button"
          onClick={load}
          disabled={loading}
          className="focus-ring flex h-10 items-center gap-2 rounded-xl bg-accent px-3 text-sm font-medium text-white transition-colors hover:bg-accent-hover disabled:opacity-50"
        >
          <RefreshCw className={`size-4 ${loading ? 'animate-spin' : ''}`} />
          刷新
        </button>
      </header>

      {error && (
        <p role="alert" className="text-sm text-warning">
          加载待审核笔记失败：{error}
        </p>
      )}

      <ShimmerCard>
        {loading ? (
          <div className="space-y-3">
            {[0, 1, 2].map((i) => (
              <div key={i} className="h-20 animate-pulse rounded-lg bg-bg-tertiary" />
            ))}
          </div>
        ) : notes.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 text-text-muted">
            <BookCheck className="mb-3 size-12 opacity-30" />
            <p>暂无待审核笔记</p>
            <p className="text-sm">所有原子笔记均已审核</p>
          </div>
        ) : (
          <div className="space-y-3">
            {notes.map((n) => (
              <div
                key={n.file}
                className="rounded-xl border border-border p-4 transition-colors hover:bg-bg-secondary/30"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <FileText className="size-4 shrink-0 text-accent" />
                      <h3 className="truncate font-medium">{n.title}</h3>
                    </div>
                    <p className="mt-1 truncate font-mono text-2xs text-text-muted">
                      {n.file}
                    </p>
                    {n.reason && (
                      <p className="mt-2 text-sm text-text-secondary">
                        <span className="text-text-muted">审核原因：</span>
                        {n.reason}
                      </p>
                    )}
                    <div className="mt-2 flex flex-wrap items-center gap-3 text-2xs text-text-muted">
                      {n.source && (
                        <span className="flex items-center gap-1">
                          <Tag className="size-3" />
                          {n.source}
                        </span>
                      )}
                      {n.created && (
                        <span className="flex items-center gap-1">
                          <Clock className="size-3" />
                          {n.created}
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="flex shrink-0 gap-2">
                    <button
                      type="button"
                      onClick={() => act(n.file, 'reject')}
                      disabled={processing === n.file}
                      className="focus-ring flex h-9 items-center gap-1.5 rounded-lg border border-border bg-bg-tertiary px-3 text-sm text-text-secondary transition-colors hover:border-danger/40 hover:text-danger disabled:opacity-50"
                      title="驳回"
                    >
                      <X className="size-3.5" />
                      驳回
                    </button>
                    <button
                      type="button"
                      onClick={() => act(n.file, 'approve')}
                      disabled={processing === n.file}
                      className="focus-ring flex h-9 items-center gap-1.5 rounded-lg bg-success px-3 text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
                      title="批准"
                    >
                      <Check className="size-3.5" />
                      批准
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </ShimmerCard>

      {notes.length > 0 && (
        <p className="text-xs text-text-muted">
          共 {notes.length} 条待审核笔记，批准后将标记为 <code className="rounded bg-bg-tertiary px-1">active</code>，
          驳回将标记为 <code className="rounded bg-bg-tertiary px-1">archived</code>。
        </p>
      )}
    </div>
  )
}
