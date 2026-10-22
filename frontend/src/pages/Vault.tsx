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
  AlertTriangle,
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
  const [tags, setTags] = useState<string[] | null>(null)
  const [statsError, setStatsError] = useState<string | null>(null)
  const [tagsError, setTagsError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [reloadToken, setReloadToken] = useState(0)
  // 骨架只属于首屏：显式 loading 且尚未拿到 stats。加载结束（成功或失败）后必须消失。
  const initialLoading = loading && stats === null

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setStatsError(null)
    setTagsError(null)
    Promise.allSettled([endpoints.vault.stats(), endpoints.vault.tags()]).then(
      ([statsResult, tagsResult]) => {
        if (cancelled) return
        if (statsResult.status === 'fulfilled') {
          setStats((statsResult.value as VaultStats | null) ?? null)
        } else {
          setStatsError(formatError(statsResult.reason))
        }
        if (tagsResult.status === 'fulfilled') {
          setTags(toTags(tagsResult.value))
        } else {
          setTagsError(formatError(tagsResult.reason))
        }
        setLoading(false)
      },
    )
    return () => {
      cancelled = true
    }
  }, [reloadToken])

  const retry = () => setReloadToken((n) => n + 1)

  return (
    <div className="space-y-5">
      {(statsError !== null || tagsError !== null) && (
        <div
          role="alert"
          className="flex flex-wrap items-center gap-2 rounded-lg border border-[var(--danger-soft)] bg-[var(--danger-soft)] px-3 py-2 text-sm text-[var(--danger)]"
        >
          <AlertTriangle className="size-4 shrink-0" aria-hidden="true" />
          <div className="min-w-0 flex-1 space-y-0.5">
            {statsError !== null && <p>统计加载失败：{statsError}</p>}
            {tagsError !== null && <p>标签不可用：{tagsError}</p>}
          </div>
          <Button
            size="sm"
            variant="secondary"
            onClick={retry}
            loading={loading}
            icon={<RefreshCw className="size-3.5" />}
          >
            重试
          </Button>
        </div>
      )}

      {/* Stats */}
      <section
        className="stagger grid grid-cols-3 gap-3"
        aria-busy={initialLoading}
        data-testid={initialLoading ? 'vault-skeleton' : undefined}
      >
        <StatCard label="笔记" value={stats?.notes ?? '—'} icon={<BookOpen className="size-4" />} accent="default" loading={initialLoading} />
        <StatCard label="标签" value={stats?.tags ?? '—'} icon={<Tag className="size-4" />} accent="info" loading={initialLoading} />
        <StatCard label="链接" value={stats?.links ?? '—'} icon={<NetworkIcon className="size-4" />} accent="success" loading={initialLoading} />
      </section>

      {/* Tags */}
      <ShimmerCard className="space-y-3">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-[var(--text)]">
          <Tag className="size-4 text-[var(--accent)]" />
          标签
        </h2>
        {tagsError !== null ? (
          <p className="text-sm text-[var(--text-secondary)]">
            标签不可用，请点击上方「重试」重新加载。
          </p>
        ) : tags === null ? (
          <div className="space-y-2">
            <Skeleton width="5rem" height="1.5rem" rounded="full" />
            <Skeleton width="8rem" height="1.5rem" rounded="full" />
          </div>
        ) : tags.length === 0 ? (
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
        <p className="mt-1 text-2xs text-[var(--text-muted)]">
          网页端仅展示概览，不在此处加载图谱数据。
        </p>
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
  const [reloadToken, setReloadToken] = useState(0)
  const toast = useApp((s) => s.toast)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    endpoints.knowledge
      .pendingReview()
      .then((d) => {
        if (cancelled) return
        const data = d as { notes?: PendingNote[] }
        setNotes(data.notes ?? [])
      })
      .catch((e) => {
        if (cancelled) return
        setNotes([])
        setError(formatError(e))
      })
      .finally(() => {
        if (cancelled) return
        setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [reloadToken])

  const reload = () => setReloadToken((n) => n + 1)

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
          onClick={reload}
          loading={loading}
          variant="secondary"
          size="sm"
          icon={<RefreshCw className="size-4" />}
        >
          刷新
        </Button>
      </div>

      <ShimmerCard>
        {loading ? (
          <div className="space-y-3">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-20 w-full" />
            ))}
          </div>
        ) : error !== null ? (
          <div
            role="alert"
            className="flex flex-col items-center justify-center gap-3 py-10 text-center"
          >
            <AlertTriangle className="size-5 text-[var(--warning)]" aria-hidden="true" />
            <p className="text-sm text-[var(--text-secondary)]">加载待审核笔记失败：{error}</p>
            <Button
              size="sm"
              variant="secondary"
              onClick={reload}
              icon={<RefreshCw className="size-3.5" />}
            >
              重试
            </Button>
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

/** 把 API 错误折叠成可读文案；超时/取消必须与普通失败可区分（错误态三态修复）。 */
function formatError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err ?? '未知错误')
  const code = (err as { code?: string } | null | undefined)?.code
  if (code === 'timeout') return `请求超时，请稍后重试（${message}）`
  if (code === 'canceled') return `请求已取消（${message}）`
  return message
}

function toTags(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map(String)
  if (raw && typeof raw === 'object' && Array.isArray((raw as { tags?: unknown }).tags)) {
    return ((raw as { tags: unknown[] }).tags).map(String)
  }
  return []
}
