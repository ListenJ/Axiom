import type { ReactNode } from 'react'

interface PageHeaderProps {
  icon: ReactNode
  title: string
  description?: string
  /** Optional right-side actions */
  actions?: ReactNode
  /** Subtitle line (e.g. version, status) */
  subtitle?: string
}

export default function PageHeader({
  icon,
  title,
  description,
  actions,
  subtitle,
}: PageHeaderProps) {
  return (
    <header className="flex flex-wrap items-start justify-between gap-3">
      <div className="flex items-center gap-3">
        <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-[var(--accent-soft)] text-[var(--accent)]">
          {icon}
        </div>
        <div className="min-w-0 space-y-0.5">
          <h1 className="font-display text-2xl font-semibold tracking-tight text-[var(--text)]">
            {title}
          </h1>
          {description && (
            <p className="text-sm text-[var(--text-secondary)]">{description}</p>
          )}
          {subtitle && (
            <p className="text-2xs text-[var(--text-muted)]">{subtitle}</p>
          )}
        </div>
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </header>
  )
}
