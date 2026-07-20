import { useEffect, useState } from 'react'
import { BookCheck, Check, X, RefreshCw, Clock, Tag, FileText } from 'lucide-react'
import {
  ShimmerCard,
  PageHeader,
  Button,
  Skeleton,
  InlineEmptyState,
} from '@/components/ui'
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
    <div className="space-y-6 fade-in">
      <PageHeader
        icon={<BookCheck className="size-5" />}
        title="知识审核"
        description="审批或驳回待审核的原子笔记。"
        actions={
          <Button
            onClick={load}
            loading={loading}
            variant="secondary"
            icon={<RefreshCw className="size-4" />}
          >
            刷新
          </Button>
        }
      />

      {error && (
        <p
          role="alert"
          className="rounded-lg border border-[var(--warning-soft)] bg-[var(--warning-soft)] px-3 py-2 text-sm text-[var(--warning)]"
        >
          加载待审核笔记失败：{error}
        </p>
      )}

      <ShimmerCard>
        {loading ? (
          <div className="space-y-3">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-20 w-full" />
            ))}
          </div>
        ) : notes.length === 0 ? (
          <InlineEmptyState
            icon={<BookCheck className="size-5" />}
            title="暂无待审核笔记"
            description="所有原子笔记均已审核"
          />
        ) : (
          <div className="space-y-3">
            {notes.map((n) => (
              <div
                key={n.file}
                className="rounded-xl border border-[var(--border)] p-4 transition-colors hover:border-[var(--border-hover)] hover:bg-[var(--surface-hover)]"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <FileText className="size-4 shrink-0 text-[var(--accent)]" />
                      <h3 className="truncate font-medium text-[var(--text)]">{n.title}</h3>
                    </div>
                    <p className="mt-1 truncate font-mono text-2xs text-[var(--text-muted)]">
                      {n.file}
                    </p>
                    {n.reason && (
                      <p className="mt-2 text-sm text-[var(--text-secondary)]">
                        <span className="text-[var(--text-muted)]">审核原因：</span>
                        {n.reason}
                      </p>
                    )}
                    <div className="mt-2 flex flex-wrap items-center gap-3 text-2xs text-[var(--text-muted)]">
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
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => act(n.file, 'reject')}
                      loading={processing === n.file}
                      icon={<X className="size-3.5" />}
                    >
                      驳回
                    </Button>
                    <Button
                      size="sm"
                      onClick={() => act(n.file, 'approve')}
                      loading={processing === n.file}
                      icon={<Check className="size-3.5" />}
                    >
                      批准
                    </Button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </ShimmerCard>

      {notes.length > 0 && (
        <p className="text-xs text-[var(--text-muted)]">
          共 {notes.length} 条待审核笔记，批准后将标记为{' '}
          <code className="rounded bg-[var(--bg-tertiary)] px-1">active</code>，
          驳回将标记为 <code className="rounded bg-[var(--bg-tertiary)] px-1">archived</code>。
        </p>
      )}
    </div>
  )
}
