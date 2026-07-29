import type { ReactNode } from 'react'
import ShimmerCard from './ShimmerCard'

interface EmptyStateProps {
  icon: ReactNode
  title: string
  description?: ReactNode
  action?: ReactNode
  className?: string
}

export default function EmptyState({
  icon,
  title,
  description,
  action,
  className = '',
}: EmptyStateProps) {
  return (
    <ShimmerCard
      variant="outlined"
      padding="lg"
      role="status"
      aria-live="polite"
      className={`flex flex-col items-center justify-center text-center ${className}`}
    >
      <div className="mb-3 flex size-12 items-center justify-center rounded-xl bg-[var(--bg-tertiary)] text-[var(--text-muted)]">
        {icon}
      </div>
      <h3 className="text-sm font-semibold text-[var(--text)]">{title}</h3>
      {description && (
        <p className="mt-1 max-w-sm text-xs text-[var(--text-muted)]">{description}</p>
      )}
      {action && <div className="mt-4">{action}</div>}
    </ShimmerCard>
  )
}
