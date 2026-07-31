import { CheckCircle2, AlertCircle, Info, AlertTriangle, X } from 'lucide-react'
import Button from './Button'
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
        // Error/warning toasts must be announced assertively; info/success are polite.
        const isAlert = t.type === 'error' || t.type === 'warning'
        return (
          <div
            key={t.id}
            className={`pointer-events-auto flex w-full max-w-sm items-start gap-3 rounded-xl border px-4 py-3 shadow-lg ${TONE[t.type]}`}
            role={isAlert ? 'alert' : 'status'}
            aria-live={isAlert ? 'assertive' : 'polite'}
          >
            <Icon className={`mt-0.5 size-4 shrink-0 ${ICON_TONE[t.type]}`} />
            <p className="flex-1 text-sm">{t.message}</p>
            <Button
              variant="ghost"
              size="icon"
              onClick={() => dismiss(t.id)}
              className="-m-1"
              aria-label="关闭通知"
              icon={<X size={14} />}
            />
          </div>
        )
      })}
    </div>
  )
}
