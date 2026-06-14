import type { ReactNode, HTMLAttributes } from 'react'

type CardVariant = 'default' | 'accent' | 'muted' | 'outlined'
type CardPadding = 'none' | 'sm' | 'md' | 'lg'

interface ShimmerCardProps extends Omit<HTMLAttributes<HTMLDivElement>, 'className'> {
  children: ReactNode
  /** Visual style: default (subtle border), accent (accent border), muted (no hover), outlined (dashed) */
  variant?: CardVariant
  /** Legacy API: use border-glow accent edge */
  glow?: boolean
  /** Add hover lift effect */
  hoverable?: boolean
  /** Add active press feedback */
  pressable?: boolean
  /** Add fade-in entrance animation */
  animate?: boolean
  /** Padding scale */
  padding?: CardPadding
  className?: string
}

const VARIANT_CLASSES: Record<CardVariant, string> = {
  default:
    'border border-[var(--border)] bg-[var(--surface)] hover:border-[var(--border-hover)]',
  accent:
    'border border-[var(--accent-soft)] bg-[var(--surface)] hover:border-[var(--accent)]',
  muted:
    'border border-[var(--border)] bg-[var(--bg-secondary)]',
  outlined:
    'border border-dashed border-[var(--border-hover)] bg-transparent',
}

const PADDING_CLASSES: Record<CardPadding, string> = {
  none: 'p-0',
  sm: 'p-3',
  md: 'p-4',
  lg: 'p-6',
}

export default function ShimmerCard({
  children,
  variant = 'default',
  glow = false,
  hoverable = false,
  pressable = false,
  animate = false,
  padding = 'md',
  className = '',
  ...rest
}: ShimmerCardProps) {
  return (
    <div
      className={`
        relative overflow-hidden rounded-xl text-[var(--text)]
        transition-colors duration-200
        ${glow ? 'border-glow' : VARIANT_CLASSES[variant]}
        ${PADDING_CLASSES[padding]}
        ${hoverable ? 'card-hover cursor-pointer' : ''}
        ${pressable ? 'press' : ''}
        ${animate ? 'fade-in' : ''}
        ${className}
      `}
      {...rest}
    >
      {children}
    </div>
  )
}
