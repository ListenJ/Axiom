import type { ReactNode } from 'react'

interface InlineEmptyStateProps {
  icon: ReactNode
  title: string
  description?: ReactNode
  action?: ReactNode
  className?: string
}

/** Inline empty state (no card wrapper) for use inside ShimmerCards or other containers */
export default function InlineEmptyState({
  icon,
  title,
  description,
  action,
  className = '',
}: InlineEmptyStateProps) {
  return (
    <div className={`flex flex-col items-center justify-center py-12 text-[var(--text-muted)] ${className}`}>
      <div className="mb-3 flex size-12 items-center justify-center rounded-xl bg-[var(--bg-tertiary)] text-[var(--text-muted)]">
        {icon}
      </div>
      <p className="text-sm font-medium text-[var(--text-secondary)]">{title}</p>
      {description && <p className="mt-1 text-xs text-[var(--text-muted)]">{description}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  )
}
