/**
 * GitStatusBadge — Header 右上角 Git 状态徽标
 *
 * 轮询 /api/git/status：显示当前分支 + 未提交变更数；clean 时显示 ✓；
 * 点击跳转 /git 页面。后端不可用时静默隐藏（不阻塞 UI）。
 */
import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { GitBranch, CheckCircle2 } from 'lucide-react'
import { endpoints } from '@/lib/api'

interface GitState {
  branch?: string
  changes: number
  clean: boolean
  loaded: boolean
}

const POLL_MS = 30_000

export function GitStatusBadge() {
  const navigate = useNavigate()
  const [state, setState] = useState<GitState>({ changes: 0, clean: true, loaded: false })

  useEffect(() => {
    let alive = true
    const load = async () => {
      try {
        const r = await endpoints.git.status()
        if (!alive || !r?.success) return
        const changes =
          (r.modified?.length ?? 0) +
          (r.added?.length ?? 0) +
          (r.deleted?.length ?? 0) +
          (r.untracked?.length ?? 0) +
          (r.conflicted?.length ?? 0)
        setState({ branch: r.branch, changes, clean: changes === 0, loaded: true })
      } catch {
        // 后端不可用：保持隐藏
      }
    }
    void load()
    const t = setInterval(load, POLL_MS)
    return () => {
      alive = false
      clearInterval(t)
    }
  }, [])

  if (!state.loaded) return null

  return (
    <button
      type="button"
      onClick={() => navigate('/git')}
      title={`Git 状态：${state.branch ?? '?'} · ${state.changes} 个变更（点击打开 Git 页面）`}
      aria-label={`Git 状态：分支 ${state.branch ?? '未知'}，${state.changes} 个变更`}
      className={`press flex h-8 items-center gap-1.5 rounded-full border px-2.5 text-2xs font-medium transition-colors focus:outline-none ${
        state.clean
          ? 'border-[var(--border)] text-[var(--text-muted)] hover:text-[var(--text)]'
          : 'border-[var(--accent)]/40 bg-[var(--accent-soft)] text-[var(--accent)]'
      }`}
    >
      {state.clean ? (
        <CheckCircle2 size={13} className="text-[var(--success)]" />
      ) : (
        <GitBranch size={13} />
      )}
      <span className="max-w-24 truncate font-mono">{state.branch ?? '?'}</span>
      {state.changes > 0 && (
        <span className="rounded-full bg-[var(--accent)] px-1.5 text-[var(--on-accent)]">
          {state.changes}
        </span>
      )}
    </button>
  )
}
