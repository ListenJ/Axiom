import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import {
  Folder,
  Tag,
  Network as NetworkIcon,
  BookOpen,
  BookCheck,
  Check,
  X,
  RefreshCw,
  Clock,
  FileText,
} from 'lucide-react'
import {
  ShimmerCard,
  StatCard,
  PageHeader,
  InlineEmptyState,
  Skeleton,
  Tabs,
  Button,
} from '@/components/ui'
import { FadeIn } from '@/components/motion'
import { useApp } from '@/state/useApp'
import { endpoints } from '@/lib/api'

type VaultTab = 'notes' | 'review'

export default function Vault() {
  const [searchParams, setSearchParams] = useSearchParams()
  const tab: VaultTab = searchParams.get('tab') === 'review' ? 'review' : 'notes'
  const setTab = (id: string) =>
    setSearchParams(id === 'notes' ? {} : { tab: id }, { replace: true })

  return (
    <div className="mx-auto max-w-2xl space-y-5">
      <PageHeader
        icon={<Folder className="size-5" />}
        title="知识库"
        description="笔记库概览与待审核笔记。"
      />

      <Tabs
        tabs={[
          { id: 'notes', label: '笔记', icon: <BookOpen className="size-4" /> },
          { id: 'review', label: '待审核', icon: <BookCheck className="size-4" /> },
        ]}
        active={tab}
        onChange={setTab}
      />

      <FadeIn key={tab} className="space-y-5">
        {tab === 'notes' ? <NotesTab /> : <ReviewTab />}
      </FadeIn>
    </div>
  )
}

interface VaultStats {
  notes?: number
  tags?: number
  links?: number
}

function NotesTab() {
  const [stats, setStats] = useState<VaultStats | null>(null)
  const [tags, setTags] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)
  const loading = stats === null

  useEffect(() => {
    let cancelled = false
    Promise.allSettled([
      endpoints.vault.stats().then((d) => d as VaultStats).catch(() => null),
      endpoints.vault.tags().then((d) => toTags(d)).catch(() => []),
    ]).then(([s, t]) => {
      if (cancelled) return
      setStats(s.status === 'fulfilled' ? s.value : null)
      setTags(t.status === 'fulfilled' ? t.value : [])
      const failed = [s, t].find((r) => r.status === 'rejected') as PromiseRejectedResult | undefined
      if (failed) setError(String(failed.reason?.message ?? failed.reason))
    })
    return () => { cancelled = true }
  }, [])

  return (
    <div className="space-y-5">
      {error && <p role="alert" className="rounded-lg border border-[var(--danger-soft)] bg-[var(--danger-soft)] px-3 py-2 text-sm text-[var(--danger)]">{error}</p>}

      {/* Stats */}
      <section className="stagger grid grid-cols-3 gap-3" aria-busy={loading}>
        <StatCard label="笔记" value={stats?.notes ?? '—'} icon={<BookOpen className="size-4" />} accent="default" loading={loading} />
        <StatCard label="标签" value={stats?.tags ?? '—'} icon={<Tag className="size-4" />} accent="info" loading={loading} />
        <StatCard label="链接" value={stats?.links ?? '—'} icon={<NetworkIcon className="size-4" />} accent="success" loading={loading} />
      </section>

      {/* Tags */}
      <ShimmerCard className="space-y-3">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-[var(--text)]">
          <Tag className="size-4 text-[var(--accent)]" />
          标签
        </h2>
        {tags.length === 0 ? (
          <InlineEmptyState icon={<Tag className="size-5" />} title="暂无标签" />
        ) : (
          <div className="flex flex-wrap gap-2">
            {tags.map((t, i) => (
              <span key={i} className="rounded-full border border-[var(--border)] bg-[var(--bg-tertiary)] px-3 py-1 text-xs text-[var(--text-secondary)]">
                #{t}
              </span>
            ))}
          </div>
        )}
      </ShimmerCard>

      {/* PARA 视图 */}
      <ShimmerCard variant="muted">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-[var(--text)]">
          <NetworkIcon className="size-4 text-[var(--accent)]" />
          PARA 视图
        </h2>
        <p className="mt-2 text-sm text-[var(--text-secondary)]">在原生 Axiom 应用中查看 PARA 分类与反向链接。</p>
        <div className="mt-3 flex items-center gap-2 text-2xs text-[var(--text-muted)]">
          <Skeleton width="3rem" height="0.5rem" />
          <Skeleton width="6rem" height="0.5rem" />
          <Skeleton width="4rem" height="0.5rem" />
        </div>
      </ShimmerCard>
    </div>
  )
}

interface PendingNote {
  file: string
  title: string
  source: string
  reason?: string
  created: string
  updated?: string
}

function ReviewTab() {
  const [notes, setNotes] = useState<PendingNote[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [processing, setProcessing] = useState<string | null>(null)
  const toast = useApp((s) => s.toast)

  const load = (cancelled = false) => {
    setLoading(true)
    setError(null)
    endpoints.knowledge
      .pendingReview()
      .then((d) => {
        if (cancelled) return
        const data = d as { notes?: PendingNote[] }
        setNotes(data.notes ?? [])
      })
      .catch((e) => { if (!cancelled) setError(String((e as Error)?.message ?? e)) })
      .finally(() => { if (!cancelled) setLoading(false) })
  }

  useEffect(() => {
    let cancelled = false
    void load(cancelled)
    return () => { cancelled = true }
  }, [])

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
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-[var(--text-secondary)]">审批或驳回待审核的原子笔记。</p>
        <Button
          onClick={() => void load()}
          loading={loading}
          variant="secondary"
          size="sm"
          icon={<RefreshCw className="size-4" />}
        >
          刷新
        </Button>
      </div>

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

function toTags(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map(String)
  if (raw && typeof raw === 'object' && Array.isArray((raw as { tags?: unknown }).tags)) {
    return ((raw as { tags: unknown[] }).tags).map(String)
  }
  return []
}
