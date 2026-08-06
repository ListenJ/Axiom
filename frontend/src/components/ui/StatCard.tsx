import type { ReactNode } from 'react'
import ShimmerCard from './ShimmerCard'

interface StatCardProps {
  label: string
  value: ReactNode
  /** Optional sublabel (units, change indicator) */
  hint?: ReactNode
  /** Optional icon */
  icon?: ReactNode
  /** Accent color for icon and value */
  accent?: 'default' | 'success' | 'warning' | 'danger' | 'info'
  /** Show loading skeleton */
  loading?: boolean
  /** Optional className */
  className?: string
}

const ACCENT_CLASSES = {
  default: { text: 'text-[var(--accent)]', bg: 'bg-[var(--accent-soft)]' },
  success: { text: 'text-[var(--success)]', bg: 'bg-[var(--success-soft)]' },
  warning: { text: 'text-[var(--warning)]', bg: 'bg-[var(--warning-soft)]' },
  danger: { text: 'text-[var(--danger)]', bg: 'bg-[var(--danger-soft)]' },
  info: { text: 'text-[var(--info)]', bg: 'bg-[var(--info-soft)]' },
} as const

export default function StatCard({
  label,
  value,
  hint,
  icon,
  accent = 'default',
  loading = false,
  className = '',
}: StatCardProps) {
  const a = ACCENT_CLASSES[accent]
  return (
    <ShimmerCard padding="md" className={className}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1 space-y-1">
          <p className="text-xs font-medium uppercase tracking-wider text-[var(--text-secondary)]">
            {label}
          </p>
          {loading ? (
            <div className="skeleton h-8 w-20" />
          ) : (
            <p className={`text-2xl font-bold tabular-nums ${a.text}`}>
              {value}
            </p>
          )}
          {hint && (
            <p className="text-2xs text-[var(--text-muted)]">{hint}</p>
          )}
        </div>
        {icon && (
          <div className={`flex size-9 shrink-0 items-center justify-center rounded-lg ${a.bg} ${a.text}`}>
            {icon}
          </div>
        )}
      </div>
    </ShimmerCard>
  )
}
