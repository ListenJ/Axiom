import { CheckCircle2, AlertCircle, Info, AlertTriangle, X } from 'lucide-react'
import { useApp } from '@/state/useApp'

const ICONS = {
  info: Info,
  success: CheckCircle2,
  error: AlertCircle,
  warning: AlertTriangle,
}

const TONE: Record<keyof typeof ICONS, string> = {
  info: 'border-accent/40 bg-bg-secondary text-text',
  success: 'border-success/40 bg-bg-secondary text-text',
  error: 'border-danger/40 bg-bg-secondary text-text',
  warning: 'border-warning/40 bg-bg-secondary text-text',
}

const ICON_TONE: Record<keyof typeof ICONS, string> = {
  info: 'text-accent',
  success: 'text-success',
  error: 'text-danger',
  warning: 'text-warning',
}

export default function Toasts() {
  const toasts = useApp((s) => s.toasts)
  const dismiss = useApp((s) => s.dismissToast)
  return (
    <div className="pointer-events-none fixed inset-x-0 top-4 z-[200] flex flex-col items-center gap-2 px-4">
      {toasts.map((t) => {
        const Icon = ICONS[t.type]
        return (
          <div
            key={t.id}
            className={`pointer-events-auto flex w-full max-w-sm items-start gap-3 rounded-xl border px-4 py-3 shadow-lg ${TONE[t.type]}`}
            role="status"
          >
            <Icon className={`mt-0.5 size-4 shrink-0 ${ICON_TONE[t.type]}`} />
            <p className="flex-1 text-sm">{t.message}</p>
            <button
              type="button"
              onClick={() => dismiss(t.id)}
              className="focus-ring -m-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-text-muted transition-colors hover:bg-surface-hover hover:text-text"
              aria-label="关闭通知"
            >
              <X size={14} />
            </button>
          </div>
        )
      })}
    </div>
  )
}
