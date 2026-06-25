interface LoadingDotsProps {
  label?: string
  className?: string
  /** Dot color (defaults to accent) */
  variant?: 'accent' | 'success' | 'info' | 'warning'
  /** Dot size */
  size?: 'sm' | 'md'
}

const COLOR_CLASSES = {
  accent: 'bg-[var(--accent)]',
  success: 'bg-[var(--success)]',
  info: 'bg-[var(--info)]',
  warning: 'bg-[var(--warning)]',
} as const

const SIZE_CLASSES = {
  sm: 'size-1',
  md: 'size-1.5',
} as const

export default function LoadingDots({
  label,
  className = '',
  variant = 'accent',
  size = 'md',
}: LoadingDotsProps) {
  const color = COLOR_CLASSES[variant]
  const dotSize = SIZE_CLASSES[size]
  return (
    <span
      role="status"
      aria-live="polite"
      aria-label={label ?? '加载中'}
      className={`inline-flex items-center gap-1 ${className}`}
    >
      <span
        className={`${dotSize} animate-pulse rounded-full ${color}`}
        style={{ animationDelay: '0ms' }}
      />
      <span
        className={`${dotSize} animate-pulse rounded-full ${color}`}
        style={{ animationDelay: '120ms' }}
      />
      <span
        className={`${dotSize} animate-pulse rounded-full ${color}`}
        style={{ animationDelay: '240ms' }}
      />
      {label && <span className="ml-1.5 text-xs text-[var(--text-muted)]">{label}</span>}
    </span>
  )
}
