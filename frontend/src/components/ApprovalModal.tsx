import { useEffect, useRef, useState } from 'react'
import { ShieldAlert } from 'lucide-react'
import Button from '@/components/ui/Button'
import { useApprovals, type ApprovalRisk } from '@/state/useApprovals'
import { useFocusTrap } from '@/hooks/useFocusTrap'

const COUNTDOWN_MS = 15_000
const TICK_MS = 100

const RISK_META: Record<ApprovalRisk, { label: string; className: string }> = {
  safe: { label: '安全', className: 'bg-[var(--success-soft)] text-[var(--success)]' },
  caution: { label: '注意', className: 'bg-[var(--warning-soft)] text-[var(--warning)]' },
  destructive: { label: '高危', className: 'bg-[var(--danger-soft)] text-[var(--danger)]' },
  unknown: { label: '未知', className: 'bg-[var(--surface)] text-[var(--text-secondary)]' },
}

function prettyArgs(args: unknown): string {
  if (args === undefined || args === null) return '（无参数）'
  try {
    return JSON.stringify(args, null, 2)
  } catch {
    return String(args)
  }
}

export default function ApprovalModal() {
  const current = useApprovals((s) => s.queue[0])
  const queueLength = useApprovals((s) => s.queue.length)
  const resolve = useApprovals((s) => s.resolve)
  const [remainingMs, setRemainingMs] = useState(COUNTDOWN_MS)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const autoRejectedRef = useRef(false)
  const dialogRef = useRef<HTMLDivElement | null>(null)

  const currentId = current?.id

  useFocusTrap(dialogRef, !!current)

  // 每条新审批重置 15s 倒计时
  useEffect(() => {
    setRemainingMs(COUNTDOWN_MS)
    setSubmitting(false)
    setError(null)
    autoRejectedRef.current = false
    if (!currentId) return
    const startedAt = Date.now()
    const timer = setInterval(() => {
      setRemainingMs(Math.max(0, COUNTDOWN_MS - (Date.now() - startedAt)))
    }, TICK_MS)
    return () => clearInterval(timer)
  }, [currentId])

  // 倒计时结束自动拒绝（仅触发一次）
  useEffect(() => {
    if (!currentId || remainingMs > 0 || autoRejectedRef.current) return
    autoRejectedRef.current = true
    resolve(currentId, false, '前端倒计时超时自动拒绝').catch(() => {
      // 后端超时兜底（approval-timeout），本地失败无需额外处理
    })
  }, [currentId, remainingMs, resolve])

  if (!current) return null

  const decide = async (approved: boolean) => {
    if (submitting) return
    setSubmitting(true)
    setError(null)
    try {
      await resolve(current.id, approved, approved ? undefined : '用户拒绝')
    } catch {
      setError('提交失败，请重试')
      setSubmitting(false)
    }
  }

  const risk = RISK_META[current.risk] ?? RISK_META.unknown
  const secondsLeft = Math.ceil(remainingMs / 1000)
  const pct = (remainingMs / COUNTDOWN_MS) * 100

  return (
    <div
      ref={dialogRef}
      className="fixed inset-0 z-[100] flex items-center justify-center backdrop-glass"
      role="dialog"
      aria-modal="true"
      aria-label="审批请求"
    >
      <div className="w-[min(90vw,32rem)] elevation-4 glass rounded-2xl p-5">
        <div className="mb-4 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <span className="text-[var(--warning)]">
              <ShieldAlert size={20} />
            </span>
            <h2 className="text-lg font-semibold">审批请求</h2>
          </div>
          <span className="text-xs text-text-secondary">
            第 1 / {queueLength} 条
          </span>
        </div>

        <div className="mb-3 flex items-center gap-2 text-sm">
          <span className="text-text-secondary">工具</span>
          <span className="font-mono text-text">{current.tool}</span>
          <span className={`ml-auto rounded px-2 py-0.5 text-2xs ${risk.className}`}>
            风险：{risk.label}
          </span>
        </div>

        <pre className="mb-4 max-h-48 overflow-auto rounded-lg bg-bg-tertiary p-3 font-mono text-xs text-text">
          {prettyArgs(current.args)}
        </pre>

        <div className="mb-4">
          <div className="mb-1 flex justify-between text-2xs text-text-secondary">
            <span>超时将自动拒绝</span>
            <span>剩余 {secondsLeft} 秒</span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-[var(--surface)]">
            <div
              className="h-full rounded-full bg-[var(--warning)] transition-[width] duration-100"
              style={{ width: `${pct}%` }}
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={15}
              aria-valuenow={secondsLeft}
            />
          </div>
        </div>

        {error && <p className="mb-3 text-sm text-[var(--danger)]">{error}</p>}

        <div className="flex justify-end gap-2">
          <Button variant="danger" loading={submitting} onClick={() => void decide(false)}>
            拒绝
          </Button>
          <Button variant="success" loading={submitting} onClick={() => void decide(true)}>
            批准
          </Button>
        </div>
      </div>
    </div>
  )
}
