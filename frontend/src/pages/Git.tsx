import { useState, useEffect, useCallback } from 'react'
import { GitBranch, GitCommitVertical, Upload, RefreshCw, FileEdit, FilePlus, FileMinus, FileQuestion } from 'lucide-react'
import { api } from '@/lib/api'
import { useApp } from '@/state/useApp'
import ShimmerCard from '@/components/ui/ShimmerCard'
import Button from '@/components/ui/Button'
import { Textarea } from '@/components/ui/Input'
import EmptyState from '@/components/ui/EmptyState'

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

export default function Git() {
  const toast = useApp((s) => s.toast)
  const [status, setStatus] = useState<GitStatus | null>(null)
  const [log, setLog] = useState<GitLogResult | null>(null)
  const [commitMessage, setCommitMessage] = useState('')
  const [loading, setLoading] = useState(false)
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
    } catch (e) {
      toast('加载 Git 状态失败', 'error')
    } finally {
      setLoading(false)
    }
  }, [toast])

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
      const res = await api.post<{ success: boolean; remote?: string; branch?: string; error?: string }>('/api/git/push', {})
      if (res.success) {
        toast(`已推送到 ${res.remote}/${res.branch}`, 'success')
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

  return (
    <div className="fade-in space-y-4">
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
                {status?.clean ? '工作区干净' : `${allFiles.length} 个变更`}
                {ahead > 0 && ` · 领先 ${ahead}`}
                {behind > 0 && ` · 落后 ${behind}`}
              </p>
            </div>
          </div>
          <Button
            variant="ghost"
            size="icon"
            icon={<RefreshCw className={`size-4 ${loading ? 'animate-spin' : ''}`} />}
            onClick={refresh}
            loading={loading}
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
          {hasChanges ? (
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
          ) : (
            <EmptyState
              icon={<GitCommitVertical className="size-5" />}
              title="无变更"
              description="工作区干净，没有需要提交的修改"
            />
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
              placeholder="输入提交信息..."
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
            {ahead === 0 && (
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
        {log?.commits && log.commits.length > 0 ? (
          <ul className="space-y-2">
            {log.commits.map((commit, i) => (
              <li key={i} className="flex items-start gap-3 text-xs">
                <code className="shrink-0 rounded bg-[var(--bg-tertiary)] px-1.5 py-0.5 font-mono text-[var(--accent)]">
                  {commit.shortHash}
                </code>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[var(--text)]" title={commit.message}>{commit.message}</p>
                  <p className="text-[var(--text-muted)]">
                    {commit.author} · {new Date(commit.date).toLocaleString('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-xs text-[var(--text-muted)]">暂无提交记录</p>
        )}
      </ShimmerCard>
    </div>
  )
}
