import type { ReactNode } from 'react'

interface ShimmerCardProps {
  children: ReactNode
  glow?: boolean
  className?: string
}

export default function ShimmerCard({ children, glow = false, className = '' }: ShimmerCardProps) {
  return (
    <div
      className={`
        relative overflow-hidden rounded-2xl bg-surface p-4 transition-transform
        ${glow ? 'border-glow' : 'border border-border'}
        ${className}
      `}
    >
      {children}
      <div className="pointer-events-none absolute inset-0 -translate-x-full shimmer" aria-hidden="true" />
    </div>
  )
}
