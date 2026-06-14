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
        relative overflow-hidden rounded-2xl bg-surface p-4 transition-all duration-200
        ${glow ? 'border-glow hover:-translate-y-0.5 hover:shadow-lg' : 'border border-border hover:border-border-hover'}
        ${className}
      `}
    >
      {children}
      <div className="pointer-events-none absolute inset-0 -translate-x-full shimmer" aria-hidden="true" />
    </div>
  )
}
