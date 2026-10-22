import { useState, useEffect, useCallback } from 'react'
import { GitBranch, GitCommitVertical, Upload, RefreshCw, FileEdit, FilePlus, FileMinus, FileQuestion, AlertTriangle } from 'lucide-react'
import { api } from '@/lib/api'
import { useApp } from '@/state/useApp'
import ShimmerCard from '@/components/ui/ShimmerCard'
import Button from '@/components/ui/Button'
import Skeleton from '@/components/ui/Skeleton'
import { Textarea } from '@/components/ui/Input'
import EmptyState from '@/components/ui/EmptyState'
import { formatDateTime } from '@/lib/format'

interface GitStatus {
  success: boolean
  branch?: string
  ahead?: number
  behind?: number
  modified?: string[]
  added?: string[]
  deleted?: string[]
  untracked?: string[]
  conflicted?: string[]
  clean?: boolean
  error?: string
}

interface GitLogResult {
  success: boolean
  commits?: Array<{
    hash: string
    shortHash: string
    message: string
    author: string
    date: string
  }>
  error?: string
}

interface FileEntry {
  path: string
  type: 'modified' | 'added' | 'deleted' | 'untracked'
}

const FILE_ICONS = {
  modified: { icon: FileEdit, color: 'text-[var(--warning)]' },
  added: { icon: FilePlus, color: 'text-[var(--success)]' },
  deleted: { icon: FileMinus, color: 'text-[var(--danger)]' },
  untracked: { icon: FileQuestion, color: 'text-[var(--text-muted)]' },
}

/**
 * 把页面级读取失败映射成持久、可区分的错误文案。
 * api 已把超时/主动取消归一化为 HttpError.code，二者语义不同，
 * 不能都落成「无数据/干净」；其它错误保留原始 message 便于定位。
 */
function describeLoadError(e: unknown): string {
  const code = (e as { code?: string } | null)?.code
  if (code === 'timeout') return 'Git 状态不可用：读取 Git 状态超时，请重试。'
  if (code === 'canceled') return 'Git 状态不可用：读取 Git 状态已取消，请重试。'
  const detail = e instanceof Error && e.message ? `（${e.message}）` : ''
  return `Git 状态不可用：读取 Git 状态失败${detail}，请重试。`
}

export default function Git() {
  const toast = useApp((s) => s.toast)
  const [status, setStatus] = useState<GitStatus | null>(null)
  const [log, setLog] = useState<GitLogResult | null>(null)
  const [commitMessage, setCommitMessage] = useState('')
  // 初始即为加载中：首屏在请求返回前不得先渲染「干净/无数据」空态。
  const [loading, setLoading] = useState(true)
  // 页面级持久错误：读取失败必须可见且可重试，不能被渲染成干净工作区。
  const [loadError, setLoadError] = useState<string | null>(null)
  const [committing, setCommitting] = useState(false)
  const [pushing, setPushing] = useState(false)

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const [statusRes, logRes] = await Promise.all([
        api.get<GitStatus>('/api/git/status'),
        api.get<GitLogResult>('/api/git/log?maxCount=10'),
      ])
      setStatus(statusRes)
      setLog(logRes)
      setLoadError(null) // 仅重试成功才清错
    } catch (e) {
      // 读失败保留持久错误态（可重试），不得显示成「无变更 / 暂无提交记录」
      setLoadError(describeLoadError(e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  const handleCommit = async () => {
    if (!commitMessage.trim()) {
      toast('请输入提交信息', 'warning')
      return
    }
    setCommitting(true)
    try {
      const res = await api.post<{ success: boolean; shortHash?: string; error?: string; message?: string }>('/api/git/commit', { message: commitMessage })
      if (res.success) {
        toast(res.shortHash ? `已提交 ${res.shortHash}` : (res.message || '已提交'), 'success')
        setCommitMessage('')
        refresh()
      } else {
        toast(res.error || '提交失败', 'error')
      }
    } catch {
      toast('提交失败', 'error')
    } finally {
      setCommitting(false)
    }
  }

  const handlePush = async () => {
    setPushing(true)
    try {
      const res = await api.post<{ success: boolean; output?: string; error?: string }>('/api/git/push', {})
      if (res.success) {
        toast(res.output?.trim() ? `已推送：${res.output.trim().slice(0, 80)}` : '推送成功', 'success')
        refresh()
      } else {
        toast(res.error || '推送失败', 'error')
      }
    } catch {
      toast('推送失败', 'error')
    } finally {
      setPushing(false)
    }
  }

  const allFiles: FileEntry[] = [
    ...(status?.modified || []).map((p) => ({ path: p, type: 'modified' as const })),
    ...(status?.added || []).map((p) => ({ path: p, type: 'added' as const })),
    ...(status?.deleted || []).map((p) => ({ path: p, type: 'deleted' as const })),
    ...(status?.untracked || []).map((p) => ({ path: p, type: 'untracked' as const })),
  ]

  const hasChanges = allFiles.length > 0
  const ahead = status?.ahead || 0
  const behind = status?.behind || 0
  // 骨架屏只属于「初始加载且尚无数据」，请求结束（成功或失败）后不得残留。
  const initialLoading = loading && status === null && log === null
  // 空态只在请求成功且确实为空时成立：git 明确 clean 且解析不到任何变更。
  const filesEmpty = status?.clean === true && allFiles.length === 0
  const commitsEmpty = Array.isArray(log?.commits) && log.commits.length === 0

  return (
    <div className="space-y-4">
      {/* 读失败：持久可重试的错误态；不得伪装成「干净/无数据」正常态 */}
      {loadError && (
        <div className="flex flex-wrap items-center gap-3 rounded-xl border border-[var(--danger)]/40 bg-[var(--danger-soft)] px-4 py-3">
          <p role="alert" className="flex items-center gap-1.5 text-xs text-[var(--danger)]">
            <AlertTriangle className="size-4 shrink-0" />
            {loadError}
          </p>
          <Button
            variant="secondary"
            size="sm"
            icon={<RefreshCw className="size-3.5" />}
            onClick={refresh}
            loading={loading}
          >
            重试
          </Button>
        </div>
      )}

      {/* Header */}
      <ShimmerCard variant="accent" padding="md">
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-3 min-w-0">
            <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-[var(--accent-soft)] text-[var(--accent)]">
              <GitBranch className="size-5" />
            </div>
            <div className="min-w-0">
              <h2 className="truncate text-sm font-semibold text-[var(--text)]">
                {status?.branch || '—'}
              </h2>
              <p className="text-xs text-[var(--text-muted)]">
                {loadError ? (
                  <span className="text-[var(--warning)]">Git 状态不可用：未能读取仓库状态</span>
                ) : initialLoading ? (
                  <Skeleton data-testid="git-skeleton" width="9rem" height="0.75rem" />
                ) : (
                  <>
                    {status?.clean === true ? '工作区干净' : `${allFiles.length} 个变更`}
                    {ahead > 0 && ` · 领先 ${ahead}`}
                    {behind > 0 && ` · 落后 ${behind}`}
                  </>
                )}
              </p>
            </div>
          </div>
          <Button
            variant="ghost"
            size="icon"
            icon={<RefreshCw className={`size-4 ${loading ? 'animate-spin' : ''}`} />}
            onClick={refresh}
            loading={loading}
            aria-label="刷新 Git 状态"
            title="刷新 Git 状态"
          />
        </div>
      </ShimmerCard>

      {/* Main content: files + commit form */}
      <div className="grid gap-4 lg:grid-cols-2">
        {/* File list */}
        <ShimmerCard variant="outlined" padding="md">
          <h3 className="mb-3 text-xs font-semibold uppercase tracking-wider text-[var(--text-secondary)]">
            变更文件
          </h3>
          {loadError ? (
            <p className="flex items-start gap-2 text-xs text-[var(--warning)]">
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
              变更文件不可用：读取 Git 状态失败
            </p>
          ) : initialLoading ? (
            <div className="space-y-1.5">
              {[0, 1, 2].map((i) => (
                <Skeleton key={i} data-testid="git-skeleton" width={`${80 - i * 15}%`} height="1rem" />
              ))}
            </div>
          ) : allFiles.length > 0 ? (
            <ul className="space-y-1.5 max-h-64 overflow-y-auto">
              {allFiles.map((file, i) => {
                const cfg = FILE_ICONS[file.type]
                const Icon = cfg.icon
                return (
                  <li key={i} className="flex items-center gap-2 text-xs">
                    <Icon className={`size-3.5 shrink-0 ${cfg.color}`} />
                    <span className="truncate text-[var(--text)]" title={file.path}>{file.path}</span>
                  </li>
                )
              })}
            </ul>
          ) : filesEmpty ? (
            <EmptyState
              icon={<GitCommitVertical className="size-5" />}
              title="无变更"
              description="工作区干净，没有需要提交的修改"
            />
          ) : (
            <p className="text-xs text-[var(--text-muted)]">—</p>
          )}
        </ShimmerCard>

        {/* Commit form */}
        <ShimmerCard variant="outlined" padding="md">
          <h3 className="mb-3 text-xs font-semibold uppercase tracking-wider text-[var(--text-secondary)]">
            提交
          </h3>
          <div className="space-y-3">
            <Textarea
              label="提交信息"
              placeholder="输入提交信息…"
              value={commitMessage}
              onChange={(e) => setCommitMessage(e.target.value)}
              rows={4}
              hint="支持多行，Ctrl+Enter 快速提交"
              onKeyDown={(e) => {
                if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
                  e.preventDefault()
                  handleCommit()
                }
              }}
            />
            <div className="flex gap-2">
              <Button
                variant="primary"
                size="sm"
                icon={<GitCommitVertical className="size-3.5" />}
                onClick={handleCommit}
                loading={committing}
                disabled={!hasChanges || !commitMessage.trim()}
              >
                提交
              </Button>
              <Button
                variant="secondary"
                size="sm"
                icon={<Upload className="size-3.5" />}
                onClick={handlePush}
                loading={pushing}
                disabled={ahead === 0}
              >
                推送
              </Button>
            </div>
            {!loadError && !initialLoading && ahead === 0 && (
              <p className="text-xs text-[var(--text-muted)]">没有待推送的提交</p>
            )}
          </div>
        </ShimmerCard>
      </div>

      {/* Commit log */}
      <ShimmerCard variant="outlined" padding="md">
        <h3 className="mb-3 text-xs font-semibold uppercase tracking-wider text-[var(--text-secondary)]">
          最近提交
        </h3>
        {loadError ? (
          <p className="flex items-start gap-2 text-xs text-[var(--warning)]">
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
            最近提交不可用：读取提交记录失败
          </p>
        ) : initialLoading ? (
          <div className="space-y-2">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} data-testid="git-skeleton" height="2rem" rounded="md" />
            ))}
          </div>
        ) : log?.commits && log.commits.length > 0 ? (
          <ul className="space-y-2">
            {log.commits.map((commit, i) => (
              <li key={i} className="flex items-start gap-3 text-xs">
                <code className="shrink-0 rounded bg-[var(--bg-tertiary)] px-1.5 py-0.5 font-mono text-[var(--accent)]">
                  {commit.shortHash}
                </code>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[var(--text)]" title={commit.message}>{commit.message}</p>
                  <p className="text-[var(--text-muted)]">
                    {commit.author} · {formatDateTime(commit.date)}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        ) : commitsEmpty ? (
          <p className="text-xs text-[var(--text-muted)]">暂无提交记录</p>
        ) : (
          <p className="text-xs text-[var(--text-muted)]">—</p>
        )}
      </ShimmerCard>
    </div>
  )
}
